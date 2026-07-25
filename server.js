const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// roomId -> { members: Map(socketId -> {name}), lastState: {action, time, speed, ts} }
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { members: new Map(), lastState: null });
  }
  return rooms.get(roomId);
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let displayName = 'Guest';

  socket.on('join-room', ({ roomId, name }) => {
    currentRoom = roomId;
    displayName = (name || 'Guest').slice(0, 24);
    socket.join(roomId);

    const room = getRoom(roomId);
    room.members.set(socket.id, { name: displayName });

    // tell the new person who else is here (so they can start WebRTC calls)
    const others = [...room.members.entries()]
      .filter(([id]) => id !== socket.id)
      .map(([id, info]) => ({ id, name: info.name }));
    socket.emit('room-joined', {
      roomId,
      selfId: socket.id,
      members: others,
      lastState: room.lastState
    });

    // tell everyone else someone joined
    socket.to(roomId).emit('peer-joined', { id: socket.id, name: displayName });

    io.to(roomId).emit('roster', {
      members: [...room.members.entries()].map(([id, info]) => ({ id, name: info.name }))
    });
  });

  // Playback sync: play, pause, seek, rate-change
  socket.on('sync-event', (payload) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    room.lastState = { ...payload, ts: Date.now() };
    socket.to(currentRoom).emit('sync-event', room.lastState);
  });

  // Chat
  socket.on('chat-message', (msg) => {
    if (!currentRoom) return;
    io.to(currentRoom).emit('chat-message', {
      id: socket.id,
      name: displayName,
      text: String(msg).slice(0, 500),
      ts: Date.now()
    });
  });

  // WebRTC signaling relay (voice/video call between peers)
  socket.on('rtc-signal', ({ to, data }) => {
    io.to(to).emit('rtc-signal', { from: socket.id, data });
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (room) {
      room.members.delete(socket.id);
      socket.to(currentRoom).emit('peer-left', { id: socket.id });
      io.to(currentRoom).emit('roster', {
        members: [...room.members.entries()].map(([id, info]) => ({ id, name: info.name }))
      });
      if (room.members.size === 0) rooms.delete(currentRoom);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Reel Room running on http://localhost:${PORT}`);
});
