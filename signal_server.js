const { WebSocketServer } = require('ws');
const { randomUUID }       = require('crypto');
const https                = require('https');
const os                   = require('os');

// Railway (and most cloud platforms) inject a PORT env var.
// Fall back to 3000 for local development.
// Production: wss://game-signaling-server-production.up.railway.app
const PORT = process.env.PORT || 3000;

// Set RAILWAY_ENVIRONMENT (Railway injects this automatically) or LOCAL=true to skip Metered.
const IS_LOCAL = !process.env.RAILWAY_ENVIRONMENT && !process.env.METERED_FORCE;

// ─── LAN IP detection ─────────────────────────────────────────────────────────
// Find the first non-loopback IPv4 address — this is the LAN address clients
// on the same network should use to connect to this signaling server.
function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1'; // fallback: same machine only
}
const LAN_IP = getLanIp();

// ─── Metered TURN credentials ─────────────────────────────────────────────────
// Dynamic fetch — the signaling server fetches fresh credentials from Metered
// on startup and every 12 hours. Replace the API URL with your Metered app name
// and API key when you rotate accounts.
//
// To find your API URL: Metered dashboard → TURN → Credentials → "API Integration"
// Format: https://YOUR_APP_NAME.metered.live/api/v1/turn/credentials?apiKey=YOUR_KEY
const METERED_API_URL =
  'https://YOUR_APP_NAME.metered.live/api/v1/turn/credentials?apiKey=YOUR_API_KEY';

// Static fallback — used if the Metered API fetch fails at startup.
// These credentials expire (Metered rotates them), so the dynamic fetch above
// is the primary path. Update these whenever you rotate your Metered account.
const STATIC_ICE_FALLBACK = [
  { urls: 'stun:stun.relay.metered.ca:80' },
  {
    urls      : 'turn:global.relay.metered.ca:80',
    username  : 'd1339c9f64c60c4b33b31b88',
    credential: 'GTorfAcNMzcbffwu',
  },
  {
    urls      : 'turn:global.relay.metered.ca:80?transport=tcp',
    username  : 'd1339c9f64c60c4b33b31b88',
    credential: 'GTorfAcNMzcbffwu',
  },
  {
    urls      : 'turn:global.relay.metered.ca:443',
    username  : 'd1339c9f64c60c4b33b31b88',
    credential: 'GTorfAcNMzcbffwu',
  },
  {
    urls      : 'turns:global.relay.metered.ca:443?transport=tcp',
    username  : 'd1339c9f64c60c4b33b31b88',
    credential: 'GTorfAcNMzcbffwu',
  },
];

// LAN/local ICE: empty array = browser generates host candidates automatically.
// No STUN needed on a local network — STUN finds your public IP, not LAN IP.
// Keeping this empty makes LAN connections faster and works on offline networks.
const LOCAL_ICE = [];

const ICE_REFRESH_INTERVAL = 12 * 60 * 60 * 1000; // 12 hours

let _cachedIceServers = LOCAL_ICE; // safe default for local; replaced by Metered on Railway

function fetchIceServers() {
  if (IS_LOCAL) {
    console.log('[ICE] Local mode -- host candidates only, Metered skipped');
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    https.get(METERED_API_URL, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const servers = JSON.parse(data);
          if (Array.isArray(servers) && servers.length > 0) {
            _cachedIceServers = servers;
            console.log(`[ICE] Fetched ${servers.length} ICE servers from Metered`);
          } else {
            console.warn('[ICE] Metered returned empty or invalid response -- using static fallback');
            _cachedIceServers = STATIC_ICE_FALLBACK;
          }
        } catch {
          console.warn('[ICE] Failed to parse Metered response -- using static fallback');
          _cachedIceServers = STATIC_ICE_FALLBACK;
        }
        resolve();
      });
    }).on('error', (err) => {
      console.error('[ICE] Failed to fetch from Metered:', err.message, '-- using static fallback');
      _cachedIceServers = STATIC_ICE_FALLBACK;
      resolve(); // non-fatal
    });
  });
}

fetchIceServers().then(() => {
  if (!IS_LOCAL) setInterval(fetchIceServers, ICE_REFRESH_INTERVAL);
});

// ─── Limits ───────────────────────────────────────────────────────────────────
const MAX_ROOM_SIZE      = 8;
const MAX_ROOM_ID_LEN    = 64;
const RATE_LIMIT_WINDOW  = 1000; // ms
const RATE_LIMIT_MAX_MSG = 30;

const wss = new WebSocketServer({ port: PORT });

const rooms = new Map(); // roomId -> Set of sockets

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sanitiseRoomId(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, MAX_ROOM_ID_LEN);
}

function rateAllow(ws) {
  const now = Date.now();
  if (now - ws._rateBucketStart > RATE_LIMIT_WINDOW) {
    ws._rateBucketStart = now;
    ws._rateBucketCount = 0;
  }
  ws._rateBucketCount++;
  return ws._rateBucketCount <= RATE_LIMIT_MAX_MSG;
}

// ─── Server ───────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  let currentRoom = null;

  ws._rateBucketStart = Date.now();
  ws._rateBucketCount = 0;

  ws.on('message', (raw) => {
    if (!rateAllow(ws)) return;

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'JOIN_ROOM') {
      const roomId = sanitiseRoomId(msg.roomId);
      if (!roomId) return;

      const existingRoom = rooms.get(roomId);
      if (existingRoom && existingRoom.size >= MAX_ROOM_SIZE) {
        ws.send(JSON.stringify({ type: 'ROOM_FULL' }));
        return;
      }

      currentRoom = roomId;
      if (!rooms.has(currentRoom)) rooms.set(currentRoom, new Set());
      rooms.get(currentRoom).add(ws);

      const peerId = randomUUID();
      ws._peerId = peerId;

      // Send peer ID, ICE servers, and (in local mode) the LAN address so the
      // client UI can display the exact URL other players should connect to.
      ws.send(JSON.stringify({
        type      : 'ASSIGNED_PEER_ID',
        peerId,
        iceServers: _cachedIceServers,
        lanAddress: IS_LOCAL ? `ws://${LAN_IP}:${PORT}` : null,
      }));

      for (const peer of rooms.get(currentRoom)) {
        if (peer !== ws && peer.readyState === 1) {
          peer.send(JSON.stringify({ type: 'PEER_JOINED', peerId }));
        }
      }
      return;
    }

    if (!currentRoom) return;

    if (['OFFER', 'ANSWER', 'ICE_CANDIDATE'].includes(msg.type)) {
      const room = rooms.get(currentRoom);
      if (!room) return;
      for (const peer of room) {
        if (peer !== ws && peer.readyState === 1) {
          peer.send(JSON.stringify({ ...msg, peerId: ws._peerId }));
        }
      }
    }
  });

  ws.on('close', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      rooms.get(currentRoom).delete(ws);
      if (rooms.get(currentRoom).size === 0) rooms.delete(currentRoom);
    }
  });
});

const mode = IS_LOCAL
  ? `LOCAL (host candidates only) -- LAN address: ws://${LAN_IP}:${PORT}`
  : 'PRODUCTION (Metered TURN)';
console.log(`Signaling server running on port ${PORT} -- ${mode}`);