const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: true },
});

app.use(express.static(path.join(__dirname, 'public')));

/** roomId -> [socketId, ...] max 2, join order */
const rooms = new Map();
function removeSocketFromAllRooms(socketId) {
  for (const [roomId, ids] of rooms.entries()) {
    const idx = ids.indexOf(socketId);
    if (idx === -1) continue;
    ids.splice(idx, 1);
    const remaining = ids[0];
    if (remaining) {
      io.to(remaining).emit('peer-left');
    }
    if (ids.length === 0) {
      rooms.delete(roomId);
    }
  }
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

  /** Client leaves the matchmaking room without disconnecting the socket (retry / soft reset). */
  socket.on('leave-room', () => {
    const roomId = socket.roomId;
    if (roomId) {
      socket.leave(roomId);
    }
    removeSocketFromAllRooms(socket.id);
    socket.roomId = undefined;
  });

  function relayToRoomPeer(eventName, payload) {
    const roomId = socket.roomId;
    if (!roomId) return;
    const ids = rooms.get(roomId);
    if (!ids || ids.length < 2) return;
    socket.to(roomId).emit(eventName, payload);
  }

  socket.on('offer', (payload) => {
    relayToRoomPeer('offer', payload);
  });

  socket.on('answer', (payload) => {
    relayToRoomPeer('answer', payload);
  });

  socket.on('ice-candidate', (payload) => {
    relayToRoomPeer('ice-candidate', payload);
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
