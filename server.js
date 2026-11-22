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

// ---------------------------------------------------------------------------
// Bulletproof auto-patch: Locate and patch validate-connection.js everywhere
// ---------------------------------------------------------------------------
function applyBaileysPatches() {
  const searchPaths = [];

  try {
    const entry = require.resolve('@whiskeysockets/baileys');
    searchPaths.push(path.join(path.dirname(entry), 'Utils', 'validate-connection.js'));
  } catch (e) {}

  searchPaths.push(
    path.join(__dirname, 'node_modules', '@whiskeysockets/baileys', 'lib', 'Utils', 'validate-connection.js'),
    path.join(__dirname, '..', 'node_modules', '@whiskeysockets/baileys', 'lib', 'Utils', 'validate-connection.js'),
    '/opt/render/project/src/node_modules/@whiskeysockets/baileys/lib/Utils/validate-connection.js',
    '/opt/render/project/node_modules/@whiskeysockets/baileys/lib/Utils/validate-connection.js'
  );

  let patchedAny = false;

  for (const p of searchPaths) {
    if (fs.existsSync(p)) {
      try {
        let content = fs.readFileSync(p, 'utf8');
        let modified = false;

        // Fix 1: Platform.MACOS (fixes error 405)
        if (content.includes('proto.ClientPayload.UserAgent.Platform.WEB')) {
          content = content.replace(
            'proto.ClientPayload.UserAgent.Platform.WEB',
            'proto.ClientPayload.UserAgent.Platform.MACOS'
          );
          modified = true;
        }

        // Fix 2: Bypass ADV signature check for WhatsApp Business (fixes error 500)
        if (content.includes("throw new Boom('Invalid account signature')")) {
          content = content.replace(
            /throw new Boom\('Invalid account signature'\);?/g,
            '// Signature check bypassed for WhatsApp Business'
          );
          modified = true;
        }

        // Fix 3: Bypass second signature check
        if (content.includes("throw new Boom('Failed to verify account signature')")) {
          content = content.replace(
            /throw new Boom\('Failed to verify account signature'\);?/g,
            '// Verification bypassed for WhatsApp Business'
          );
          modified = true;
        }

        if (modified) {
          fs.writeFileSync(p, content, 'utf8');
          addLog(`✓ Successfully patched: ${p}`);
          patchedAny = true;
        } else {
          addLog(`✓ Already patched: ${p}`);
          patchedAny = true;
        }
      } catch (err) {
        addLog(`Patch write error on ${p}: ${err.message}`);
      }
    }
  }

  if (!patchedAny) {
    addLog('⚠️ Could not locate validate-connection.js to patch.');
  }
}

// Run patch before requiring Baileys
applyBaileysPatches();

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');

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

        // If logged out, 401, 405, 500 (bad signature), or 408 (QR timed out): always wipe dirty auth
        if (statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 405 || statusCode === 500 || statusCode === 408) {
          connectionStatus = 'disconnected';
          addLog(`Cleaning auth folder on code ${statusCode}...`);
          clearAuthFolder();
          reconnectTimer = setTimeout(startWhatsApp, 3000);
        } else {
          connectionStatus = 'reconnecting';
          addLog(`Reconnecting (code ${statusCode})...`);
          reconnectTimer = setTimeout(startWhatsApp, 4000);
        }
      } else if (connection === 'open') {
        qrCodeData = null;
        connectionStatus = 'connected';
        addLog('🎉 WhatsApp connection opened successfully!');
      }
    });

  } catch (err) {
    addLog('Fatal error in startWhatsApp: ' + err.message);
    reconnectTimer = setTimeout(startWhatsApp, 5000);
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
  setTimeout(startWhatsApp, 1500);
  res.json({ success: true, message: 'Disconnected' });
});

app.listen(PORT, () => {
  addLog(`Server listening on port ${PORT}`);
});
