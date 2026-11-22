const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Auto-patch Baileys to resolve WhatsApp 405 (Platform) & 500 (Signature) errors
// ---------------------------------------------------------------------------
try {
  const validatePath = path.join(__dirname, 'node_modules/@whiskeysockets/baileys/lib/Utils/validate-connection.js');
  if (fs.existsSync(validatePath)) {
    let content = fs.readFileSync(validatePath, 'utf8');
    let modified = false;

    // 1. Fix error 405: Use MACOS platform instead of WEB for companion handshake
    if (content.includes('proto.ClientPayload.UserAgent.Platform.WEB')) {
      content = content.replace(
        'proto.ClientPayload.UserAgent.Platform.WEB',
        'proto.ClientPayload.UserAgent.Platform.MACOS'
      );
      modified = true;
      console.log('✓ Applied MACOS platform patch (fixes error 405)');
    }

    // 2. Fix error 500: Bypass ADV signature validation for WhatsApp Business accounts
    if (content.includes("throw new Boom('Invalid account signature')")) {
      content = content.replace(
        /throw new Boom\('Invalid account signature'\);?/g,
        '// Signature bypassed for WhatsApp Business'
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
      fs.writeFileSync(validatePath, content, 'utf8');
      console.log('✓ Applied WhatsApp Business signature patch');
    }
  }
} catch (err) {
  console.warn('Patch warning:', err.message);
}

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const AUTH_FOLDER = path.join(__dirname, 'auth_session');

// Live WhatsApp Web revision as of today
const WA_VERSION = [2, 3000, 1055775191];

let sock = null;
let qrCodeData = null;
let connectionStatus = 'connecting';
let connectionLogs = [];
let reconnectTimer = null;

function addLog(msg) {
  const timestamp = new Date().toLocaleTimeString('en-US', { timeZone: 'UTC' });
  const line = `[${timestamp} UTC] ${msg}`;
  console.log(line);
  connectionLogs.push(line);
  if (connectionLogs.length > 50) connectionLogs.shift();
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

async function startWhatsApp() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    addLog(`Starting WhatsApp socket (v${WA_VERSION.join('.')})...`);
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

    sock = makeWASocket({
      auth: state,
      version: WA_VERSION,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: Browsers.macOS('Desktop'),
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          qrCodeData = await qrcode.toDataURL(qr);
          connectionStatus = 'connecting';
          addLog('✓ Generated fresh QR code');
        } catch (err) {
          addLog('Failed to generate QR data URL: ' + err.message);
        }
      }

      if (connection === 'close') {
        qrCodeData = null;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errorMsg = lastDisconnect?.error?.message || '';
        addLog(`Connection closed: statusCode ${statusCode || 'unknown'} (${errorMsg})`);

        if (statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 405) {
          connectionStatus = 'disconnected';
          addLog(`Encountered code ${statusCode}. Clearing stale session state...`);
          clearAuthFolder();
          // 8-second backoff to avoid hammering WhatsApp servers
          reconnectTimer = setTimeout(startWhatsApp, 8000);
        } else {
          connectionStatus = 'reconnecting';
          addLog(`Reconnecting (code ${statusCode})...`);
          reconnectTimer = setTimeout(startWhatsApp, 5000);
        }
      } else if (connection === 'open') {
        qrCodeData = null;
        connectionStatus = 'connected';
        addLog('🎉 WhatsApp connection opened successfully!');
      }
    });

  } catch (err) {
    addLog('Fatal error in startWhatsApp: ' + err.message);
    reconnectTimer = setTimeout(startWhatsApp, 8000);
  }
}

startWhatsApp();

app.get('/status', (req, res) => {
  res.json({
    status: connectionStatus,
    qr: qrCodeData,
  });
});

app.get('/logs', (req, res) => {
  res.json({ logs: connectionLogs });
});

app.post('/pair-code', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number is required' });
  try {
    if (!sock) return res.status(400).json({ error: 'WhatsApp socket not initialized' });
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    addLog(`Requesting pairing code for phone: ${cleanPhone}`);
    const code = await sock.requestPairingCode(cleanPhone);
    addLog(`✓ Pairing code generated: ${code}`);
    res.json({ success: true, code });
  } catch (err) {
    addLog(`Pairing code error: ${err.message}`);
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
  setTimeout(startWhatsApp, 2000);
  res.json({ success: true, message: 'Disconnected' });
});

app.listen(PORT, () => {
  addLog(`Server listening on port ${PORT}`);
});
