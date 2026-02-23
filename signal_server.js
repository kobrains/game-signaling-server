const { WebSocketServer } = require('ws');

// Railway (and most cloud platforms) inject a PORT env var.
// Fall back to 3000 for local development.
const PORT = process.env.PORT || 3000;

const wss = new WebSocketServer({ port: PORT });

const rooms = new Map(); // roomId → Set of sockets

wss.on('connection', (ws) => {
  let currentRoom = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'JOIN_ROOM') {
      currentRoom = msg.roomId;
      if (!rooms.has(currentRoom)) rooms.set(currentRoom, new Set());
      rooms.get(currentRoom).add(ws);

      // Tell the new peer its temporary ID
      const peerId = Math.random().toString(36).slice(2);
      ws._peerId = peerId;
      ws.send(JSON.stringify({ type: 'ASSIGNED_PEER_ID', peerId }));

      // Notify everyone else in the room that a new peer joined
      for (const peer of rooms.get(currentRoom)) {
        if (peer !== ws && peer.readyState === 1) {
          peer.send(JSON.stringify({ type: 'PEER_JOINED', peerId }));
        }
      }
      return;
    }

    // Relay OFFER / ANSWER / ICE_CANDIDATE to everyone else in the room
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
    }
  });
});

console.log(`Signaling server running on port ${PORT}`);