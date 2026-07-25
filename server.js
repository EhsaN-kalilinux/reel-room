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

// roomId -> { members: Map(socketId -> {name}), hostId: string|null }
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { members: new Map(), hostId: null });
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
    room.members.set(socket.id, { name: displayName, mic: true, cam: true });

    const others = [...room.members.entries()]
      .filter(([id]) => id !== socket.id)
      .map(([id, info]) => ({ id, name: info.name, mic: info.mic, cam: info.cam }));
    socket.emit('room-joined', {
      roomId,
      selfId: socket.id,
      members: others,
      hostId: room.hostId
    });

    socket.to(roomId).emit('peer-joined', { id: socket.id, name: displayName });

    io.to(roomId).emit('roster', {
      members: [...room.members.entries()].map(([id, info]) => ({ id, name: info.name }))
    });
  });

  socket.on('become-host', () => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    if (room.hostId && room.hostId !== socket.id) return;
    room.hostId = socket.id;
    io.to(currentRoom).emit('host-info', { hostId: socket.id, hostName: displayName });
  });

  socket.on('chat-message', (msg) => {
    if (!currentRoom) return;
    io.to(currentRoom).emit('chat-message', {
      id: socket.id,
      name: displayName,
      text: String(msg).slice(0, 500),
      ts: Date.now()
    });
  });

  socket.on('rtc-signal', ({ to, data }) => {
    io.to(to).emit('rtc-signal', { from: socket.id, data });
  });

  socket.on('subtitle-cue', ({ text }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('subtitle-cue', { text: String(text || '').slice(0, 500) });
  });

  socket.on('media-state', ({ mic, cam }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (room && room.members.has(socket.id)) {
      const info = room.members.get(socket.id);
      info.mic = !!mic;
      info.cam = !!cam;
    }
    socket.to(currentRoom).emit('media-state', { id: socket.id, mic: !!mic, cam: !!cam });
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (room) {
      room.members.delete(socket.id);
      socket.to(currentRoom).emit('peer-left', { id: socket.id });
      if (room.hostId === socket.id) {
        room.hostId = null;
        io.to(currentRoom).emit('host-info', { hostId: null, hostName: null });
      }
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
