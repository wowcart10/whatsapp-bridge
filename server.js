const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason, 
  fetchLatestBaileysVersion,
  Browsers
} = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 3000;
const AUTH_FOLDER = path.join(__dirname, 'auth_info_baileys');

app.use(cors());
app.use(express.json());

let sock = null;
let qrData = null;
let connectionStatus = 'disconnected';
let connectedPhone = null;
let isStarting = false;
const logs = [];

function addLog(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  logs.push(line);
  if (logs.length > 50) logs.shift();
}

function clearAuthFolder() {
  if (fs.existsSync(AUTH_FOLDER)) {
    try {
      fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
      addLog('Cleaned auth session folder');
    } catch (err) {
      addLog(`Failed to clean auth folder: ${err.message}`);
    }
  }
}

async function startSock() {
  if (isStarting) return;
  isStarting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();

    addLog(`Starting WhatsApp socket with version ${version.join('.')}`);

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }), // suppress verbose noise
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'), // Standard WhatsApp Web browser (avoids Desktop signature rejection)
      syncFullHistory: false,
      markOnlineOnConnect: true,
      connectTimeoutMs: 60000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        connectionStatus = 'connecting';
        try {
          qrData = await qrcode.toDataURL(qr);
          addLog('Generated fresh QR code');
        } catch (err) {
          addLog(`QR generation error: ${err.message}`);
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errTrace = lastDisconnect?.error?.message || 'closed';
        addLog(`Connection closed: statusCode ${statusCode} (${errTrace})`);
        
        qrData = null;
        isStarting = false;

        if (statusCode === DisconnectReason.loggedOut) {
          addLog('User logged out — clearing credentials');
          connectionStatus = 'disconnected';
          connectedPhone = null;
          clearAuthFolder();
          setTimeout(startSock, 2000);
        } else {
          connectionStatus = 'connecting';
          addLog(`Reconnecting to finalize pairing (code ${statusCode})...`);
          setTimeout(startSock, 2000);
        }
      } else if (connection === 'open') {
        connectionStatus = 'connected';
        qrData = null;
        isStarting = false;
        connectedPhone = sock.user?.id ? sock.user.id.split(':')[0] : 'Connected';
        addLog(`✅ WhatsApp linked successfully for: +${connectedPhone}`);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (!msg.key.fromMe && msg.message) {
          const from = msg.key.remoteJid;
          const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
          addLog(`Incoming message from ${from}: ${text.slice(0, 40)}`);
        }
      }
    });
  } catch (err) {
    addLog(`Error in startSock: ${err.message}`);
    isStarting = false;
    setTimeout(startSock, 3000);
  }
}

startSock();

app.get('/status', (req, res) => {
  res.json({
    status: connectionStatus,
    phone: connectedPhone,
    hasQR: Boolean(qrData),
    qr: qrData
  });
});

app.get('/logs', (req, res) => {
  res.json({ logs });
});

app.post('/pair-code', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number required' });
    if (!sock) return res.status(500).json({ error: 'Socket not initialized' });

    const clean = phone.replace(/[^0-9]/g, '');
    const code = await sock.requestPairingCode(clean);
    addLog(`Pairing code requested for +${clean}: ${code}`);
    res.json({ code });
  } catch (err) {
    addLog(`Pairing code error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.post('/disconnect', async (req, res) => {
  try {
    if (sock) await sock.logout();
    clearAuthFolder();
    connectionStatus = 'disconnected';
    qrData = null;
    connectedPhone = null;
    setTimeout(startSock, 1500);
    res.json({ success: true });
  } catch (error) {
    clearAuthFolder();
    setTimeout(startSock, 1500);
    res.status(500).json({ error: error.message });
  }
});

app.post('/send-message', async (req, res) => {
  const { phone, message } = req.body;
  if (!sock || connectionStatus !== 'connected') {
    return res.status(400).json({ error: 'WhatsApp is not connected' });
  }
  try {
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const jid = `${cleanPhone}@s.whatsapp.net`;
    const sent = await sock.sendMessage(jid, { text: message });
    res.json({ success: true, messageId: sent.key.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => {
  res.send('WhatsApp Bridge is running!');
});

app.listen(PORT, () => {
  addLog(`Server listening on port ${PORT}`);
});
