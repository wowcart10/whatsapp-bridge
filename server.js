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

function clearAuthFolder() {
  if (fs.existsSync(AUTH_FOLDER)) {
    try {
      fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
      console.log('Cleaned auth session folder');
    } catch (err) {
      console.error('Failed to clean auth folder:', err.message);
    }
  }
}

async function startSock() {
  if (isStarting) return;
  isStarting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();

    console.log(`Starting WhatsApp socket with version ${version.join('.')}`);

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'info' }),
      printQRInTerminal: false,
      browser: Browsers.macOS('Desktop'),
      syncFullHistory: false,
      markOnlineOnConnect: true,
      connectTimeoutMs: 60000
    });

    // CRITICAL: Save credentials whenever WhatsApp updates them
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        connectionStatus = 'connecting';
        try {
          qrData = await qrcode.toDataURL(qr);
          console.log('Generated fresh QR code');
        } catch (err) {
          console.error('QR generation error:', err);
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`Connection closed with statusCode: ${statusCode}`);
        qrData = null;
        isStarting = false;

        const isLoggedOut = statusCode === DisconnectReason.loggedOut;

        // ONLY clear auth if user was explicitly logged out (401).
        // NEVER clear on 515 (restartRequired) or network drops (408/428)!
        if (isLoggedOut) {
          console.log('User logged out — clearing auth session');
          connectionStatus = 'disconnected';
          connectedPhone = null;
          clearAuthFolder();
          setTimeout(startSock, 2000);
        } else {
          // Reconnect immediately to finalize handshake
          connectionStatus = 'connecting';
          console.log(`Reconnecting immediately to finish pairing (code ${statusCode})...`);
          setTimeout(startSock, 1500);
        }
      } else if (connection === 'open') {
        connectionStatus = 'connected';
        qrData = null;
        isStarting = false;
        connectedPhone = sock.user?.id ? sock.user.id.split(':')[0] : 'Connected';
        console.log(`✅ WhatsApp linked successfully for: ${connectedPhone}`);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (!msg.key.fromMe && msg.message) {
          const from = msg.key.remoteJid;
          const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
          console.log(`Incoming message from ${from}: ${text}`);
        }
      }
    });
  } catch (err) {
    console.error('Error starting socket:', err);
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

app.post('/disconnect', async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
    }
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
  console.log(`Server listening on port ${PORT}`);
});
