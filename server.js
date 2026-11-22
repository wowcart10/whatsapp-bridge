const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason, 
  fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

let sock = null;
let currentQR = null;
let connectionStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'connected'
let connectedPhone = null;

async function startWhatsApp() {
  connectionStatus = 'connecting';
  const { state, saveCreds } = await useMultiFileAuthState('./auth_session');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Chrome (Linux)', 'Chrome', '120.0.0']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = await qrcode.toDataURL(qr);
      connectionStatus = 'connecting';
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      connectionStatus = 'disconnected';
      currentQR = null;
      connectedPhone = null;

      if (shouldReconnect) {
        setTimeout(startWhatsApp, 3000);
      }
    } else if (connection === 'open') {
      connectionStatus = 'connected';
      currentQR = null;
      connectedPhone = sock?.user?.id?.split(':')[0] || 'Unknown';
      console.log('WhatsApp connected as:', connectedPhone);
    }
  });

  // Handle incoming messages
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.key.fromMe && msg.message) {
        const from = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        console.log(`Received message from ${from}: ${text}`);
      }
    }
  });
}

// Start WhatsApp service
startWhatsApp();

// API Endpoints for the Lovable Web App
app.get('/status', (req, res) => {
  res.json({
    status: connectionStatus,
    phone: connectedPhone,
    hasQR: !!currentQR,
    qr: currentQR
  });
});

app.post('/disconnect', async (req, res) => {
  if (sock) {
    try {
      await sock.logout();
    } catch (e) {}
    sock = null;
  }
  connectionStatus = 'disconnected';
  currentQR = null;
  connectedPhone = null;
  res.json({ success: true, message: 'Disconnected' });
});

app.post('/send-message', async (req, res) => {
  const { to, text } = req.body;
  if (!sock || connectionStatus !== 'connected') {
    return res.status(400).json({ error: 'WhatsApp is not connected' });
  }
  try {
    const jid = to.includes('@s.whatsapp.net') ? to : `${to.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    const sent = await sock.sendMessage(jid, { text });
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
