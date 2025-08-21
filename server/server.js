const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const SHARED_SECRET_KEY = process.env.SHARED_SECRET_KEY;
if (!SHARED_SECRET_KEY) {
  console.error('Missing SHARED_SECRET_KEY. Set it in your environment.');
  process.exit(1);
}

function computeToken(room) {
  return crypto.createHash('sha256').update(String(room) + SHARED_SECRET_KEY).digest('hex');
}

// Serve client with verification on root path
app.get('/', (req, res, next) => {
  const { room, token } = req.query;
  if (!room || !token) {
    return res.status(403).send('Forbidden: missing credentials');
  }
  const expected = computeToken(room);
  if (token !== expected) {
    return res.status(403).send('Forbidden: invalid token');
  }
  return res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

// Static assets (scripts, css, icons)
app.use(express.static(path.join(__dirname, '..', 'client')));

// In-memory per-room state
// rooms: Map<roomId, { history: string[], historyStep: number, activeUsers: Map<socketId, signature> }>
const rooms = new Map();

function getRoomState(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { history: [], historyStep: -1, activeUsers: new Map() });
  }
  return rooms.get(roomId);
}

// Socket authentication using the same secret
io.use((socket, next) => {
  const auth = socket.handshake.auth || socket.handshake.query || {};
  const room = auth.room;
  const token = auth.token;
  if (!room || !token) return next(new Error('unauthorized'));
  const expected = computeToken(room);
  if (token !== expected) return next(new Error('unauthorized'));
  socket.data.room = String(room);
  next();
});

io.on('connection', (socket) => {
  const room = socket.data.room;
  const state = getRoomState(room);
  socket.join(room);
  console.log(`Socket ${socket.id} joined room ${room}`);

  // Send current canvas state to the new user
  if (state.historyStep >= 0) {
    socket.emit('loadCanvas', { dataUrl: state.history[state.historyStep] });
  }

  // User signature handling (per room)
  socket.on('userSignedUp', ({ signature }) => {
    state.activeUsers.set(socket.id, signature);
    io.to(room).emit('updateUserList', Array.from(state.activeUsers.values()));
  });

  socket.on('requestCanvasState', () => {
    if (state.historyStep >= 0) socket.emit('loadCanvas', { dataUrl: state.history[state.historyStep] });
  });

  // Drawing events scoped to room
  socket.on('startDrawing', (data) => socket.to(room).emit('startDrawing', data));
  socket.on('draw', (data) => socket.to(room).emit('draw', data));
  socket.on('stopDrawing', () => socket.to(room).emit('stopDrawing'));
  socket.on('fill', (data) => socket.to(room).emit('fill', data));
  socket.on('clearCanvas', () => socket.to(room).emit('clearCanvas'));

  socket.on('saveState', ({ dataUrl }) => {
    if (state.historyStep < state.history.length - 1) state.history = state.history.slice(0, state.historyStep + 1);
    state.history.push(dataUrl);
    state.historyStep++;
  });

  socket.on('undo', () => {
    if (state.historyStep > 0) {
      state.historyStep--;
      io.to(room).emit('loadCanvas', { dataUrl: state.history[state.historyStep] });
    }
  });

  socket.on('redo', () => {
    if (state.historyStep < state.history.length - 1) {
      state.historyStep++;
      io.to(room).emit('loadCanvas', { dataUrl: state.history[state.historyStep] });
    }
  });

  socket.on('disconnect', () => {
    state.activeUsers.delete(socket.id);
    io.to(room).emit('updateUserList', Array.from(state.activeUsers.values()));
    console.log(`Socket ${socket.id} left room ${room}`);
  });
});

server.listen(PORT, () => {
  console.log(`✔️ Server listening on port ${PORT}`);
});