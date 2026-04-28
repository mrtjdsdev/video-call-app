const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const { ExpressPeerServer } = require('peer');

const app = express();
const server = http.createServer(app);

/** PeerJS signaling (WebRTC offer/answer/ICE handled by PeerServer + library) */
const peerServer = ExpressPeerServer(server, {
  path: '/',
  debug: false,
});
app.use('/peerjs', peerServer);

const io = new Server(server, {
  cors: { origin: true },
});

app.use(express.static(path.join(__dirname, 'public')));

/** roomId -> [socketId, ...] max 2, join order */
const rooms = new Map();
/** socket.id -> PeerJS id (after client registers) */
const peerjsBySocket = new Map();
/** roomId: we already told the second socket to peer.call() this pair */
const roomCallStarted = new Set();

function removeSocketFromAllRooms(socketId) {
  for (const [roomId, ids] of rooms.entries()) {
    const idx = ids.indexOf(socketId);
    if (idx === -1) continue;
    ids.splice(idx, 1);
    peerjsBySocket.delete(socketId);
    roomCallStarted.delete(roomId);
    const remaining = ids[0];
    if (remaining) {
      io.to(remaining).emit('peer-left');
    }
    if (ids.length === 0) {
      rooms.delete(roomId);
    }
  }
}

function tryStartPeerCall(roomId) {
  const ids = rooms.get(roomId);
  if (!ids || ids.length < 2) return;
  const firstSocket = ids[0];
  const secondSocket = ids[1];
  const firstPeerjs = peerjsBySocket.get(firstSocket);
  const secondPeerjs = peerjsBySocket.get(secondSocket);
  if (!firstPeerjs || !secondPeerjs) return;
  if (roomCallStarted.has(roomId)) return;
  roomCallStarted.add(roomId);
  /** Second joiner places the media call; first answers in PeerJS. */
  io.to(secondSocket).emit('you-call', { partnerPeerId: firstPeerjs });
}

io.on('connection', (socket) => {
  socket.on('join-room', (roomIdRaw) => {
    const roomId = String(roomIdRaw || '').trim().slice(0, 64);
    if (!roomId) {
      socket.emit('join-error', 'Invalid room ID');
      return;
    }

    removeSocketFromAllRooms(socket.id);

    let ids = rooms.get(roomId);
    if (!ids) {
      ids = [];
      rooms.set(roomId, ids);
    }

    if (ids.length >= 2) {
      socket.emit('join-error', 'Room is full (max 2 people)');
      return;
    }

    const otherSocketId = ids[0];
    ids.push(socket.id);
    socket.join(roomId);
    socket.roomId = roomId;

    if (otherSocketId) {
      io.to(otherSocketId).emit('peer-joined');
      socket.emit('peer-present');
    } else {
      socket.emit('waiting');
    }
  });

  socket.on('peerjs-register', (data) => {
    const peerjsId = data && data.peerjsId;
    const roomId = socket.roomId;
    if (!peerjsId || !roomId) return;
    peerjsBySocket.set(socket.id, String(peerjsId));
    tryStartPeerCall(roomId);
  });

  /** Client leaves the matchmaking room without disconnecting the socket (retry / soft reset). */
  socket.on('leave-room', () => {
    const roomId = socket.roomId;
    if (roomId) {
      socket.leave(roomId);
    }
    removeSocketFromAllRooms(socket.id);
    socket.roomId = undefined;
  });

  const ADMIN_EFFECTS = new Set([
    'toggleGlow',
    'togglePulse',
    'toggleDim',
    'screenPulse',
    'shake',
    'reset',
  ]);
  const ADMIN_SOUNDS = new Set(['beep', 'buzzer', 'horn', 'pop', 'alert']);

  /** Room-scoped admin FX (only when 2 clients are in the same room). */
  socket.on('admin-effect', (data) => {
    const roomId = socket.roomId;
    const action = data && data.action;
    if (!roomId || typeof action !== 'string' || !ADMIN_EFFECTS.has(action)) return;
    const ids = rooms.get(roomId);
    if (!ids || ids.length < 2) return;
    socket.to(roomId).emit('admin-sync-effect', { action });
  });

  socket.on('admin-sound', (data) => {
    const roomId = socket.roomId;
    const id = data && data.id;
    if (!roomId || typeof id !== 'string' || !ADMIN_SOUNDS.has(id)) return;
    const ids = rooms.get(roomId);
    if (!ids || ids.length < 2) return;
    socket.to(roomId).emit('admin-sync-sound', { id });
  });

  socket.on('disconnect', () => {
    removeSocketFromAllRooms(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
});
