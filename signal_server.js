console.log('=== signal_server.js started ===', new Date().toISOString());
const { WebSocketServer } = require('ws');
const { randomUUID }       = require('crypto');
const https                = require('https');
const http                 = require('http');
const os                   = require('os');

const PORT = process.env.PORT || 3000;

const IS_LOCAL = !process.env.RAILWAY_ENVIRONMENT_NAME && !process.env.METERED_FORCE;

function _requireEnv(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`[Config] FATAL: required environment variable "${name}" is not set. Refusing to start.`);
    process.exit(1);
  }
  return val;
}

const METERED_APP_NAME = IS_LOCAL ? (process.env.METERED_APP_NAME || '') : _requireEnv('METERED_APP_NAME');
const METERED_API_KEY  = IS_LOCAL ? (process.env.METERED_API_KEY  || '') : _requireEnv('METERED_API_KEY');
const METERED_SECRET_KEY = process.env.METERED_SECRET_KEY || '';

function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}
const LAN_IP = getLanIp();

const METERED_API_URL = METERED_APP_NAME && METERED_API_KEY
  ? `https://${METERED_APP_NAME}.metered.live/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`
  : null;

const STATIC_ICE_FALLBACK = [
  { urls: 'stun:stun.relay.metered.ca:80' },
];

const LOCAL_ICE = [];

const ICE_REFRESH_INTERVAL = 12 * 60 * 60 * 1000;

let _cachedIceServers = LOCAL_ICE;

function fetchIceServers() {
  if (IS_LOCAL || !METERED_API_URL) {
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
      resolve();
    });
  });
}

fetchIceServers().then(() => {
  if (!IS_LOCAL) setInterval(fetchIceServers, ICE_REFRESH_INTERVAL);
});

const USAGE_REFRESH_INTERVAL = 5 * 60 * 1000;

let _cachedUsage = null;

function fetchMeteredUsage() {
  if (!METERED_SECRET_KEY || !METERED_APP_NAME) {
    console.warn('[Usage] METERED_SECRET_KEY or METERED_APP_NAME not set — monthly usage unavailable.');
    return Promise.resolve();
  }

  const url = `https://${METERED_APP_NAME}.metered.live/api/v1/turn/current_usage?secretKey=${METERED_SECRET_KEY}`;
  console.log(`[Usage] Fetching from: https://${METERED_APP_NAME}.metered.live/api/v1/turn/current_usage`);

  return new Promise((resolve) => {
    https.get(url, (res) => {
      let data = '';
      console.log(`[Usage] HTTP status: ${res.statusCode}`);
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log('[Usage] Raw response:', data);
        try {
          const parsed = JSON.parse(data);
          if (parsed.message) {
            console.warn('[Usage] Metered API error:', parsed.message);
            resolve();
            return;
          }
          if (typeof parsed.usageInGB === 'number') {
            _cachedUsage = {
              quotaInGB  : parsed.quotaInGB,
              usageInGB  : parsed.usageInGB,
              overageInGB: parsed.overageInGB ?? 0,
              fetchedAt  : Date.now(),
            };
            console.log(`[Usage] Metered: ${parsed.usageInGB.toFixed(4)} GB used / ${parsed.quotaInGB} GB quota`);
          } else {
            console.warn('[Usage] Unexpected Metered response shape:', parsed);
          }
        } catch {
          console.warn('[Usage] Failed to parse Metered response:', data);
        }
        resolve();
      });
    }).on('error', (err) => {
      console.error('[Usage] HTTPS request failed:', err.message);
      resolve();
    });
  });
}

console.log('[Config] METERED_APP_NAME:', METERED_APP_NAME || '(not set — local mode)');
console.log('[Config] METERED_SECRET_KEY set:', METERED_SECRET_KEY ? `yes (${METERED_SECRET_KEY.length} chars)` : 'NO');

fetchMeteredUsage().then(() => {
  if (METERED_SECRET_KEY) {
    setInterval(fetchMeteredUsage, USAGE_REFRESH_INTERVAL);
  }
});

const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  if (req.method === 'GET' && req.url === '/turn-usage') {
    res.setHeader('Content-Type', 'application/json');
    if (!_cachedUsage) {
      if (METERED_SECRET_KEY) {
        fetchMeteredUsage().then(() => {
          res.writeHead(200);
          res.end(JSON.stringify(_cachedUsage ?? { quotaInGB: null, usageInGB: null, overageInGB: null, fetchedAt: null }));
        });
      } else {
        res.writeHead(200);
        res.end(JSON.stringify({ quotaInGB: null, usageInGB: null, overageInGB: null, fetchedAt: null }));
      }
    } else {
      res.writeHead(200);
      res.end(JSON.stringify(_cachedUsage));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

const MAX_ROOM_SIZE        = 8;
const MAX_ROOM_ID_LEN      = 64;
const RATE_LIMIT_WINDOW    = 1000;
const RATE_LIMIT_MAX_MSG   = 30;
const MAX_CONNECTIONS_PER_IP = 8;

const _ipConnectionCounts = new Map();

function _ipConnectAllow(ip) {
  const count = _ipConnectionCounts.get(ip) ?? 0;
  if (count >= MAX_CONNECTIONS_PER_IP) return false;
  _ipConnectionCounts.set(ip, count + 1);
  return true;
}

function _ipConnectRelease(ip) {
  const count = _ipConnectionCounts.get(ip) ?? 0;
  if (count <= 1) {
    _ipConnectionCounts.delete(ip);
  } else {
    _ipConnectionCounts.set(ip, count - 1);
  }
}

const wss = new WebSocketServer({ server: httpServer });

httpServer.listen(PORT, () => {
  const mode = IS_LOCAL
    ? `LOCAL (host candidates only) -- LAN address: ws://${LAN_IP}:${PORT}`
    : 'PRODUCTION (Metered TURN)';
  console.log(`Signaling server running on port ${PORT} -- ${mode}`);
});

const rooms = new Map();

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

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim()
    ?? req.socket.remoteAddress
    ?? 'unknown';

  if (!_ipConnectAllow(ip)) {
    console.warn(`[Server] Connection refused — IP ${ip} exceeded limit of ${MAX_CONNECTIONS_PER_IP}`);
    ws.close(1008, 'Too many connections from your IP');
    return;
  }

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
    _ipConnectRelease(ip);
    if (currentRoom && rooms.has(currentRoom)) {
      rooms.get(currentRoom).delete(ws);
      if (rooms.get(currentRoom).size === 0) rooms.delete(currentRoom);
    }
  });
});