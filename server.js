const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Auto-patch: Bypass Baileys WhatsApp Business account signature crash
// ---------------------------------------------------------------------------
try {
  const validatePath = path.join(__dirname, 'node_modules/@whiskeysockets/baileys/lib/Utils/validate-connection.js');
  if (fs.existsSync(validatePath)) {
    let content = fs.readFileSync(validatePath, 'utf8');
    if (content.includes("throw new Boom('Invalid account signature')")) {
      content = content.replace(
        /throw new Boom\('Invalid account signature'\);?/g,
        "// Account signature check bypassed for WhatsApp Business compatibility"
      );
      fs.writeFileSync(validatePath, content, 'utf8');
      console.log('✓ Successfully applied WhatsApp Business signature patch');
    }
  }
} catch (err) {
  console.warn('Signature patch warning:', err.message);
}

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const AUTH_FOLDER = path.join(__dirname, 'auth_session');

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
    addLog('Starting WhatsApp socket...');
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

    sock = makeWASocket({
      auth: state,
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

        if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
          connectionStatus = 'disconnected';
          addLog('Logged out. Clearing auth folder and restarting...');
          clearAuthFolder();
          reconnectTimer = setTimeout(startWhatsApp, 3000);
        } else {
          connectionStatus = 'reconnecting';
          addLog(`Reconnecting (code ${statusCode})...`);
          reconnectTimer = setTimeout(startWhatsApp, 3000);
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
    const code = await sock.requestPairingCode(phone.replace(/[^0-9]/g, ''));
    res.json({ success: true, code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/disconnect', async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
    }
  } catch (err) {
    // Ignore logout errors
  }
  clearAuthFolder();
  connectionStatus = 'disconnected';
  qrCodeData = null;
  setTimeout(startWhatsApp, 1000);
  res.json({ success: true, message: 'Disconnected' });
});

app.listen(PORT, () => {
  addLog(`Server listening on port ${PORT}`);
});
