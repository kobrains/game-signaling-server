const { WebSocketServer } = require('ws');
const { randomUUID }       = require('crypto');
const https                = require('https');

// Railway (and most cloud platforms) inject a PORT env var.
// Fall back to 3000 for local development.
// wss://game-signaling-server-production.up.railway.app
const PORT = process.env.PORT || 3000;

// ─── Metered TURN credentials ─────────────────────────────────────────────────
const METERED_API_URL =
  'https://kyleogata_turnserver.metered.live/api/v1/turn/credentials?apiKey=b43908569ccfe4d1d72a4b8d4d8452bf248c';

// Cache credentials in memory — Metered credentials are valid for 24h.
// Refresh every 12h so they never expire mid-session.
const ICE_REFRESH_INTERVAL = 12 * 60 * 60 * 1000; // 12 hours

let _cachedIceServers = [];

function fetchIceServers() {
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
            console.warn('[ICE] Metered returned empty or invalid response — keeping previous cache');
          }
        } catch {
          console.warn('[ICE] Failed to parse Metered response — keeping previous cache');
        }
        resolve();
      });
    }).on('error', (err) => {
      console.error('[ICE] Failed to fetch from Metered:', err.message);
      resolve(); // non-fatal — use cached value
    });
  });
}

// Fetch immediately on startup, then refresh every 12h
fetchIceServers().then(() => {
  setInterval(fetchIceServers, ICE_REFRESH_INTERVAL);
});

// ─── Limits ───────────────────────────────────────────────────────────────────
const MAX_ROOM_SIZE      = 8;    // hard cap on peers per room
const MAX_ROOM_ID_LEN    = 64;   // max chars in a room ID
const RATE_LIMIT_WINDOW  = 1000; // ms
const RATE_LIMIT_MAX_MSG = 30;   // max messages per window per connection

const wss = new WebSocketServer({ port: PORT });

const rooms = new Map(); // roomId → Set of sockets

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Sanitise a roomId: strip to safe chars, enforce length. Returns '' on failure. */
function sanitiseRoomId(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, MAX_ROOM_ID_LEN);
}

/** Simple per-socket token-bucket rate limiter. Returns true if the message is allowed. */
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

  // Rate-limit state
  ws._rateBucketStart = Date.now();
  ws._rateBucketCount = 0;

  ws.on('message', (raw) => {
    // Rate limiting — drop silently if exceeded
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

      // Send peer ID and ICE servers together — client has everything it needs in one message
      ws.send(JSON.stringify({
        type      : 'ASSIGNED_PEER_ID',
        peerId,
        iceServers: _cachedIceServers,
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
      if (rooms.get(currentRoom).size === 0) {
        rooms.delete(currentRoom);
      }
    }
  });
});

console.log(`Signaling server running on port ${PORT}`);