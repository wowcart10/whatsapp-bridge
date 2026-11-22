const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const AUTH_FOLDER = path.join(__dirname, 'auth_session');
const WA_VERSION = [2, 3000, 1055775191];

let sock = null;
let qrCodeData = null;
let connectionStatus = 'connecting';
let connectionLogs = [];
let reconnectTimer = null;
let currentMode = 'qr'; // 'qr' or 'pairing'

function addLog(msg) {
  const timestamp = new Date().toLocaleTimeString('en-US', { timeZone: 'UTC' });
  const line = `[${timestamp} UTC] ${msg}`;
  console.log(line);
  connectionLogs.push(line);
  if (connectionLogs.length > 60) connectionLogs.shift();
}

function clearAuthFolder() {
  try {
    if (fs.existsSync(AUTH_FOLDER)) {
      fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
      addLog('Auth folder cleaned.');
    }
  } catch (e) {
    addLog('Error clearing auth folder: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// Auto-patch Baileys: Fix Platform 405 & WhatsApp Business signature
// ---------------------------------------------------------------------------
function applyBaileysPatches() {
  const searchPaths = [];
  try {
    const entry = require.resolve('@whiskeysockets/baileys');
    searchPaths.push(path.join(path.dirname(entry), 'Utils', 'validate-connection.js'));
  } catch (e) {}

  searchPaths.push(
    path.join(__dirname, 'node_modules', '@whiskeysockets/baileys', 'lib', 'Utils', 'validate-connection.js'),
    '/opt/render/project/src/node_modules/@whiskeysockets/baileys/lib/Utils/validate-connection.js'
  );

  for (const p of searchPaths) {
    if (fs.existsSync(p)) {
      try {
        let content = fs.readFileSync(p, 'utf8');
        let modified = false;

        if (content.includes('proto.ClientPayload.UserAgent.Platform.WEB')) {
          content = content.replace(
            'proto.ClientPayload.UserAgent.Platform.WEB',
            'proto.ClientPayload.UserAgent.Platform.MACOS'
          );
          modified = true;
        }

        if (content.includes("throw new Boom('Invalid account signature')")) {
          content = content.replace(
            /throw new Boom\('Invalid account signature'\);?/g,
            '// Signature check bypassed for WhatsApp Business'
          );
          modified = true;
        }

        if (content.includes("throw new Boom('Failed to verify account signature')")) {
          content = content.replace(
            /throw new Boom\('Failed to verify account signature'\);?/g,
            '// Verification bypassed for WhatsApp Business'
          );
          modified = true;
        }

        if (modified) {
          fs.writeFileSync(p, content, 'utf8');
          addLog(`✓ Patched validate-connection at: ${p}`);
        }
      } catch (err) {
        addLog(`Patch error: ${err.message}`);
      }
    }
  }
}

applyBaileysPatches();

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');

async function startWhatsApp(mode = 'qr', phoneToPair = null) {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  currentMode = mode;

  try {
    addLog(`Starting socket (mode: ${mode}, browser: Chrome/Ubuntu)...`);
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

    sock = makeWASocket({
      auth: state,
      version: WA_VERSION,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      // Emulate standard Chrome on Linux so WhatsApp Business mobile accepts phone pairing
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // Only generate and broadcast QR if we are in QR mode
      if (qr && currentMode === 'qr') {
        try {
          qrCodeData = await qrcode.toDataURL(qr);
          connectionStatus = 'connecting';
          addLog('✓ Generated fresh QR code');
        } catch (err) {
          addLog('QR error: ' + err.message);
        }
      }

      if (connection === 'close') {
        qrCodeData = null;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errorMsg = lastDisconnect?.error?.message || '';
        addLog(`Connection closed: statusCode ${statusCode || 'unknown'} (${errorMsg})`);

        if (statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 405 || statusCode === 500) {
          connectionStatus = 'disconnected';
          addLog(`Cleaning auth folder on code ${statusCode}...`);
          clearAuthFolder();
          reconnectTimer = setTimeout(() => startWhatsApp('qr'), 3000);
        } else if (statusCode === 408) {
          // QR timed out normally
          if (currentMode === 'qr') {
            reconnectTimer = setTimeout(() => startWhatsApp('qr'), 2000);
          }
        } else {
          connectionStatus = 'reconnecting';
          reconnectTimer = setTimeout(() => startWhatsApp(currentMode), 4000);
        }
      } else if (connection === 'open') {
        qrCodeData = null;
        connectionStatus = 'connected';
        addLog('🎉 WhatsApp connection opened successfully!');
      }
    });

    // If starting in pairing mode, wait 1.5s for WebSocket connection and request code
    if (mode === 'pairing' && phoneToPair) {
      setTimeout(async () => {
        try {
          const cleanPhone = phoneToPair.replace(/[^0-9]/g, '');
          addLog(`Requesting pairing code for +${cleanPhone}...`);
          const code = await sock.requestPairingCode(cleanPhone);
          addLog(`✓ Active pairing code: ${code}`);
        } catch (err) {
          addLog(`Pairing code error: ${err.message}`);
        }
      }, 1500);
    }

  } catch (err) {
    addLog('Fatal error in startWhatsApp: ' + err.message);
    reconnectTimer = setTimeout(() => startWhatsApp('qr'), 5000);
  }
}

// Start default QR mode
startWhatsApp('qr');

app.get('/status', (req, res) => {
  const phone = sock?.user?.id ? sock.user.id.split(':')[0].replace(/[^0-9]/g, '') : null;
  res.json({
    status: connectionStatus,
    phone,
    qr: currentMode === 'qr' ? qrCodeData : null,
  });
});

app.get('/logs', (req, res) => {
  res.json({ logs: connectionLogs });
});

app.post('/pair-code', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number is required' });

  const cleanPhone = phone.replace(/[^0-9]/g, '');
  addLog(`Switched to dedicated Pairing Code mode for +${cleanPhone}`);

  try {
    clearAuthFolder();
    qrCodeData = null;
    currentMode = 'pairing';

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    sock = makeWASocket({
      auth: state,
      version: WA_VERSION,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection } = update;
      if (connection === 'open') {
        connectionStatus = 'connected';
        addLog('🎉 WhatsApp linked successfully via pairing code!');
      }
    });

    // Give socket 1.5s to open the handshake, then request pairing code
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(cleanPhone);
        addLog(`✓ Successfully generated pairing code: ${code}`);
        res.json({ success: true, code });
      } catch (err) {
        addLog(`Pairing code error: ${err.message}`);
        if (!res.headersSent) res.status(500).json({ error: err.message });
      }
    }, 1500);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/disconnect', async (req, res) => {
  try {
    if (sock) await sock.logout();
  } catch (err) {}
  clearAuthFolder();
  connectionStatus = 'disconnected';
  qrCodeData = null;
  setTimeout(() => startWhatsApp('qr'), 1500);
  res.json({ success: true, message: 'Disconnected' });
});

app.listen(PORT, () => {
  addLog(`Server listening on port ${PORT}`);
});
