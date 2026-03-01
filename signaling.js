/**
 * multiplayer/signaling.js
 * WebSocket signaling server connection + WebRTC SDP/ICE exchange.
 * Manages RTCPeerConnections and DataChannels.
 */

// import * as CON from '../settings/constants.js';

// ─── Internal state ───────────────────────────────────────────────────────────
export const peerConnections = new Map();  // peerId → RTCPeerConnection
export const dataChannels    = new Map();  // peerId → RTCDataChannel

let _signalingSocket = null;
let _myPeerId        = null;

// Fallback ICE config used only if the signaling server doesn't provide credentials.
// In production the server sends Metered TURN credentials via ASSIGNED_PEER_ID.
export const DEFAULT_ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// Resolved ICE servers — set from ASSIGNED_PEER_ID, used by all RTCPeerConnections
let _resolvedIceServers = DEFAULT_ICE;

// ─── Teardown ─────────────────────────────────────────────────────────────────
/**
 * Close all existing peer connections, data channels, and the signaling socket.
 * Safe to call even if nothing is connected yet.
 * Must be called before reconnecting (e.g. after a failed password attempt).
 */
export function resetSignaling() {
  for (const ch of dataChannels.values()) {
    try { ch.onclose = null; ch.close(); } catch {}
  }
  dataChannels.clear();

  for (const pc of peerConnections.values()) {
    try { pc.onicecandidate = null; pc.close(); } catch {}
  }
  peerConnections.clear();

  if (_signalingSocket) {
    try {
      _signalingSocket.onmessage = null;
      _signalingSocket.onerror   = null;
      _signalingSocket.onclose   = null;
      if (_signalingSocket.readyState === WebSocket.OPEN ||
          _signalingSocket.readyState === WebSocket.CONNECTING) {
        _signalingSocket.close();
      }
    } catch {}
    _signalingSocket = null;
  }

  _myPeerId = null;
  console.log('[MP:Signaling] Reset — all connections closed');
}

// ─── Connect to signaling server ─────────────────────────────────────────────
/**
 * @param {object} opts
 * @param {string}   opts.signalingUrl
 * @param {string}   opts.roomId
 * @param {string}   opts.playerName
 * @param {'host'|'client'} opts.role
 * @param {RTCIceServer[]} opts.iceServers
 * @param {function} opts.onHostPeerJoined  — (peerId) host callback when a new peer joins
 * @param {function} opts.onHostChannelOpen — (peerId, channel) host callback after offer accepted
 * @param {function} opts.onClientChannelOpen — (channel) client callback when DC opens
 * @param {function} opts.onMessage         — (peerId, msg, isHostSide) routed message handler
 * @param {function} opts.onDisconnect      — (peerId, isHostSide)
 */
export function connectSignaling(opts) {
  const { signalingUrl, roomId, playerName, role, iceServers,
          onHostPeerJoined, onMessage, onDisconnect, passwordHash } = opts;

  // Always reset stale state before opening a new connection
  resetSignaling();

  _signalingSocket = new WebSocket(signalingUrl);

  _signalingSocket.addEventListener('open', () => {
    _signalingSocket.send(JSON.stringify({
      type: 'JOIN_ROOM', roomId, role, name: playerName,
    }));
  });

  _signalingSocket.addEventListener('message', async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    switch (msg.type) {
      case 'ASSIGNED_PEER_ID':
        _myPeerId = msg.peerId;
        if (Array.isArray(msg.iceServers) && msg.iceServers.length > 0) {
          _resolvedIceServers = msg.iceServers;
          console.log(`[MP:Signaling] Received ${msg.iceServers.length} ICE servers from signaling server`);
        } else {
          console.warn('[MP:Signaling] No ICE servers in ASSIGNED_PEER_ID — using fallback STUN only');
        }
        break;

      case 'PEER_JOINED':
        if (role === 'host') {
          await _hostCreateOffer(msg.peerId, _resolvedIceServers, onMessage, onDisconnect);
          onHostPeerJoined?.(msg.peerId);
        }
        break;

      case 'OFFER':
        if (role === 'client') {
          await _clientHandleOffer(msg.peerId, msg.sdp, _resolvedIceServers, onMessage, onDisconnect, playerName, passwordHash);
        }
        break;

      case 'ANSWER': {
        const pc = peerConnections.get(msg.peerId);
        if (pc && pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
        }
        break;
      }

      case 'ICE_CANDIDATE': {
        const pc = peerConnections.get(msg.peerId);
        if (pc && msg.candidate) {
          try { await pc.addIceCandidate(msg.candidate); } catch {}
        }
        break;
      }
    }
  });

  _signalingSocket.addEventListener('error', e => console.error('[MP:Signaling] error:', e));
}

// ─── Host: create offer and data channel ─────────────────────────────────────
async function _hostCreateOffer(peerId, iceServers, onMessage, onDisconnect) {
  const pc = new RTCPeerConnection({ iceServers });
  peerConnections.set(peerId, pc);

  const ch = pc.createDataChannel('game', { ordered: true });
  _setupChannel(ch, peerId, true, onMessage, onDisconnect);

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) _sigSend({ type: 'ICE_CANDIDATE', peerId, candidate });
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  _sigSend({ type: 'OFFER', peerId, sdp: offer.sdp });
}

// ─── Client: handle incoming offer ───────────────────────────────────────────
async function _clientHandleOffer(hostPeerId, sdp, iceServers, onMessage, onDisconnect, playerName, passwordHash) {
  const pc = new RTCPeerConnection({ iceServers });
  peerConnections.set(hostPeerId, pc);

  pc.ondatachannel  = e => _setupChannel(e.channel, hostPeerId, false, onMessage, onDisconnect, playerName, passwordHash);
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) _sigSend({ type: 'ICE_CANDIDATE', peerId: hostPeerId, candidate });
  };

  await pc.setRemoteDescription({ type: 'offer', sdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  _sigSend({ type: 'ANSWER', peerId: hostPeerId, sdp: answer.sdp });
}

// ─── Channel lifecycle ────────────────────────────────────────────────────────
function _setupChannel(channel, peerId, isHostSide, onMessage, onDisconnect, playerName, passwordHash) {
  dataChannels.set(peerId, channel);

  channel.onopen = () => {
    console.log(`[MP:Signaling] Channel open — ${isHostSide ? 'host' : 'client'} peerId=${peerId}`);
    if (!isHostSide) {
      // Send the player's entered name and (optional) hashed password
      channel.send(JSON.stringify({
        type         : 'CLIENT_HELLO',
        name         : playerName ?? 'Player',
        passwordHash : passwordHash ?? null,
      }));
    }
  };

  channel.onclose = () => {
    dataChannels.delete(peerId);
    peerConnections.delete(peerId);
    onDisconnect?.(peerId, isHostSide);
  };

  channel.onmessage = ({ data }) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    onMessage(peerId, msg, isHostSide);
  };

  channel.onerror = e => console.error(`[MP:Signaling] Channel error (${peerId}):`, e);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _sigSend(obj) {
  _signalingSocket.send(JSON.stringify(obj));
}

/** Send a message to all open data channels. */
export function broadcast(msgStr) {
  for (const [, ch] of dataChannels) {
    if (ch.readyState === 'open') ch.send(msgStr);
  }
}

/** Send a message to a single peer by id. */
export function sendToPeer(peerId, msgStr) {
  const ch = dataChannels.get(peerId);
  if (ch?.readyState === 'open') ch.send(msgStr);
}

/** Send a message to the first open channel (client → host). */
export function sendToHost(msgStr) {
  for (const ch of dataChannels.values()) {
    if (ch.readyState === 'open') { ch.send(msgStr); return; }
  }
  console.warn('[MP:Signaling] No open channel to host — message dropped');
}

/** True if at least one data channel is open. */
export function hasOpenChannel() {
  for (const ch of dataChannels.values()) {
    if (ch.readyState === 'open') return true;
  }
  return false;
}

/** Close all peer connections, data channels, and the signaling socket. */
export function closeAll() {
  for (const [, ch] of dataChannels) {
    try { ch.close(); } catch {}
  }
  dataChannels.clear();

  for (const [, pc] of peerConnections) {
    try { pc.close(); } catch {}
  }
  peerConnections.clear();

  if (_signalingSocket && _signalingSocket.readyState < 2) {
    try { _signalingSocket.close(); } catch {}
  }
  _signalingSocket = null;
  _myPeerId        = null;
}