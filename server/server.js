const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());

const PORT = process.env.PORT || 3000;

// Serve client unconditionally
app.get('/', (req, res) => {
  return res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

// Static assets (scripts, css, icons)
app.use(express.static(path.join(__dirname, '..', 'client')));

// In-memory per-room state
const rooms = new Map();

function getRoomState(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { history: [], historyStep: -1, activeUsers: new Map(), activeStrokes: new Map() });
  }
  return rooms.get(roomId);
}

// Socket connection must provide a room, nothing else
io.use((socket, next) => {
  const auth = socket.handshake.auth || socket.handshake.query || {};
  const room = auth.room ? String(auth.room) : null;
  if (!room) return next(new Error('unauthorized'));
  socket.data.room = room;
  next();
});

io.on('connection', (socket) => {
  const room = socket.data.room;
  const state = getRoomState(room);
  socket.join(room);
  console.log(`Socket ${socket.id} joined room ${room}`);

  if (state.historyStep >= 0) {
    socket.emit('loadCanvas', { dataUrl: state.history[state.historyStep] });
  }

  socket.on('userSignedUp', ({ signature }) => {
    state.activeUsers.set(socket.id, signature);
    io.to(room).emit('updateUserList', Array.from(state.activeUsers.values()));
  });

  socket.on('requestCanvasState', () => {
    if (state.historyStep >= 0) socket.emit('loadCanvas', { dataUrl: state.history[state.historyStep] });
  });

  // Buffer per-user strokes on server and emit a single commit at stop
  socket.on('startDrawing', (data = {}) => {
    const payload = { ...data, senderId: data.senderId || socket.id };
    const s = state.activeStrokes;
    s.set(socket.id, {
      senderId: payload.senderId,
      tool: payload.tool,
      color: payload.color,
      size: payload.size,
      points: [{ x: payload.x, y: payload.y }]
    });
  });
  socket.on('draw', (data = {}) => {
    const s = state.activeStrokes;
    const buf = s.get(socket.id);
    if (buf && data && typeof data.x === 'number' && typeof data.y === 'number') {
      buf.points.push({ x: data.x, y: data.y });
    }
  });
  socket.on('stopDrawing', (data = {}) => {
    const s = state.activeStrokes;
    const buf = s.get(socket.id);
    if (buf && Array.isArray(buf.points) && buf.points.length) {
      const commit = { senderId: buf.senderId, tool: buf.tool, color: buf.color, size: buf.size, points: buf.points };
      socket.to(room).emit('commitStroke', commit);
    }
    s.delete(socket.id);
  });
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