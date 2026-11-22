// SysBlink WhatsApp bridge — one connection manager, one socket, no Baileys patches.
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

const PORT = process.env.PORT || 10000;
// Point AUTH_DIR at a Render Persistent Disk (e.g. /var/data/wa-auth) so the login survives restarts.
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, 'auth_session');
const SESSION_ID = process.env.SESSION_ID || 'default';
const FALLBACK_VERSION = [2, 3000, 1055775191];

let B; // Baileys module (ESM, loaded once)
const logs = [];
let socketSeq = 0;

function log(sid, msg) {
  const line = `[${new Date().toISOString()}] [session:${SESSION_ID}] [socket:${sid ?? '-'}] ${msg}`;
  console.log(line);
  logs.push(line);
  if (logs.length > 200) logs.shift();
}

const M = {
  sock: null, sid: null, mode: 'qr', status: 'disconnected', qr: null,
  phone: null, lastConnectedAt: null, lastError: null, reconnectTimer: null,
  pairTimer: null, retries: 0,
};

function clearTimers() {
  if (M.reconnectTimer) clearTimeout(M.reconnectTimer);
  if (M.pairTimer) clearTimeout(M.pairTimer);
  M.reconnectTimer = M.pairTimer = null;
}

function killSocket(reason) {
  clearTimers();
  const s = M.sock;
  if (!s) return;
  log(M.sid, `Closing socket (${reason})`);
  M.sock = null;
  try { s.ev.removeAllListeners(); } catch {}
  try { s.end(undefined); } catch {}
}

function wipeAuth() {
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  log(M.sid, 'Credentials removed');
}

async function waVersion() {
  try {
    const r = await B.fetchLatestWaWebVersion?.({});
    if (r?.version) return r.version;
  } catch {}
  return FALLBACK_VERSION;
}

// Start (or restart) the single socket. pairPhone => pairing-code mode.
async function start(mode, pairPhone) {
  killSocket('new start');
  M.mode = mode; M.qr = null; M.status = 'initializing';
  const sid = ++socketSeq; M.sid = sid;
  const { state, saveCreds } = await B.useMultiFileAuthState(AUTH_DIR);
  const registered = !!state.creds.registered;
  const version = await waVersion();
  log(sid, `Init socket mode=${mode} registered=${registered} wa=${version.join('.')}`);

  const sock = B.default({
    auth: state, version, printQRInTerminal: false,
    logger: pino({ level: 'silent' }), browser: B.Browsers.ubuntu('Chrome'),
    syncFullHistory: false, markOnlineOnConnect: false,
  });
  M.sock = sock;

  sock.ev.on('creds.update', async () => { await saveCreds(); log(sid, 'Credentials saved'); });

  return new Promise((resolve) => {
    let pairingRequested = false;
    sock.ev.on('connection.update', async (u) => {
      if (M.sid !== sid) return; // stale socket
      const { connection, lastDisconnect, qr } = u;

      if (qr && !registered) {
        if (M.mode === 'pairing' && pairPhone && !pairingRequested) {
          pairingRequested = true;
          try {
            const code = await sock.requestPairingCode(pairPhone);
            M.status = 'waiting_pairing';
            log(sid, 'Pairing code issued (hidden)');
            // a pairing code is valid ~3 minutes
            M.pairTimer = setTimeout(() => { if (M.status === 'waiting_pairing') { log(sid, 'Pairing timeout'); M.lastError = 'Pairing code expired'; killSocket('pairing timeout'); M.status = 'disconnected'; } }, 180000);
            resolve({ code });
          } catch (e) { log(sid, `Pairing request failed: ${e.message}`); M.lastError = e.message; resolve({ error: e.message }); }
        } else if (M.mode === 'qr') {
          M.qr = await qrcode.toDataURL(qr); M.status = 'waiting_qr';
          log(sid, 'QR generated'); resolve({ qr: M.qr });
        }
      }

      if (connection === 'connecting' && M.status === 'initializing' && registered) M.status = 'connecting';

      if (connection === 'open') {
        clearTimers(); M.retries = 0; M.qr = null; M.status = 'connected'; M.lastError = null;
        M.phone = (sock.user?.id || '').split(':')[0].split('@')[0] || null;
        M.lastConnectedAt = new Date().toISOString();
        log(sid, 'Connection open'); resolve({ connected: true });
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const msg = lastDisconnect?.error?.message || '';
        log(sid, `Connection closed code=${code} ${msg}`);
        M.qr = null;
        const R = B.DisconnectReason;
        if (code === R.restartRequired) { // 515: normal right after linking
          log(sid, 'Restart required after pairing — reconnecting with saved credentials');
          M.status = 'connecting'; M.reconnectTimer = setTimeout(() => start('qr'), 500);
        } else if (code === R.loggedOut) {
          M.status = 'failed'; M.lastError = 'Logged out from phone'; killSocket('logged out'); wipeAuth(); M.status = 'disconnected';
        } else if (code === R.timedOut && !registered) {
          log(sid, M.mode === 'qr' ? 'QR expired (not scanned)' : 'Pairing socket timed out');
          killSocket('timeout'); M.status = 'disconnected'; // wait for user to ask again
        } else if (code === 405 || code === 403) {
          M.status = 'failed'; M.lastError = `WhatsApp rejected the connection (${code})`; killSocket('rejected');
        } else {
          M.retries++; const delay = Math.min(30000, 2000 * M.retries);
          M.status = 'reconnecting'; log(sid, `Reconnecting in ${delay}ms (attempt ${M.retries})`);
          M.reconnectTimer = setTimeout(() => start(registered ? 'qr' : M.mode, M.mode === 'pairing' ? pairPhone : undefined), delay);
        }
        resolve({ error: msg || `closed ${code}` });
      }
    });
    setTimeout(() => resolve({ error: 'Timed out waiting for WhatsApp' }), 30000);
  });
}

// --- HTTP ---
const app = express();
app.use(cors()); app.use(express.json({ limit: '10kb' }));
const hits = new Map();
function limit(max) { return (req, res, next) => {
  const k = req.ip + req.path, now = Date.now(); const a = (hits.get(k) || []).filter((t) => now - t < 60000);
  if (a.length >= max) return res.status(429).json({ error: 'Too many requests, wait a minute' });
  a.push(now); hits.set(k, a); next();
}; }
const ADMIN = process.env.BRIDGE_ADMIN_TOKEN;
function admin(req, res, next) { if (ADMIN && req.get('x-bridge-token') !== ADMIN) return res.status(401).json({ error: 'Unauthorized' }); next(); }

app.get('/status', (req, res) => res.json({ status: M.status, mode: M.mode, phone: M.phone, qr: M.mode === 'qr' ? M.qr : null, lastConnectedAt: M.lastConnectedAt, lastError: M.lastError }));
app.get('/logs', admin, (req, res) => res.json({ logs }));

app.post('/connect-qr', limit(10), async (req, res) => {
  if (M.status === 'connected') return res.json({ status: 'connected' });
  const r = await start('qr'); res.status(r.error ? 502 : 200).json(r);
});

app.post('/pair-code', limit(5), async (req, res) => {
  const phone = String(req.body?.phone || '').replace(/\D/g, '');
  if (!/^[1-9]\d{7,14}$/.test(phone)) return res.status(400).json({ error: 'Enter the number with country code, digits only' });
  if (M.status === 'connected') return res.status(409).json({ error: 'Already connected' });
  log(M.sid, 'Fresh pairing session requested');
  killSocket('switch to pairing'); wipeAuth(); // half-finished logins must not be reused
  const r = await start('pairing', phone);
  res.status(r.code ? 200 : 502).json(r.code ? { code: r.code } : { error: r.error || 'No code returned' });
});

app.post('/disconnect', admin, async (req, res) => {
  try { await M.sock?.logout(); } catch {}
  killSocket('disconnect'); wipeAuth(); Object.assign(M, { status: 'disconnected', phone: null, qr: null });
  res.json({ ok: true });
});

app.post('/reset-session', admin, (req, res) => {
  killSocket('reset'); wipeAuth(); Object.assign(M, { status: 'disconnected', phone: null, qr: null, lastError: null, retries: 0 });
  res.json({ ok: true });
});

(async () => {
  B = await import('@whiskeysockets/baileys');
  app.listen(PORT, () => log(null, `Listening on ${PORT}, auth dir ${AUTH_DIR}`));
  if (fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) { log(null, 'Restoring saved session'); start('qr'); }
})();
