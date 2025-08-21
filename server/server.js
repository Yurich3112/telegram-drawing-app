const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());

const PORT = process.env.PORT || 3000;
const SHARED_SECRET_KEY = process.env.SHARED_SECRET_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!SHARED_SECRET_KEY) {
  console.error('Missing SHARED_SECRET_KEY. Set it in your environment.');
  process.exit(1);
}
if (!TELEGRAM_BOT_TOKEN) {
  console.warn('Warning: TELEGRAM_BOT_TOKEN not set; /api/issue-token will be unavailable');
}

function computeToken(room) {
  return crypto.createHash('sha256').update(String(room) + SHARED_SECRET_KEY).digest('hex');
}

function verifyTelegramInitData(initData) {
  if (!initData || !TELEGRAM_BOT_TOKEN) return false;
  const urlParams = new URLSearchParams(initData);
  const receivedHash = urlParams.get('hash');
  if (!receivedHash) return false;
  urlParams.delete('hash');
  const dataPairs = [];
  for (const [key, value] of urlParams.entries()) {
    dataPairs.push(`${key}=${value}`);
  }
  dataPairs.sort();
  const dataCheckString = dataPairs.join('\n');
  const secretKey = crypto.createHash('sha256').update('WebAppData' + TELEGRAM_BOT_TOKEN).digest();
  const hmac = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  try {
    const a = Buffer.from(hmac, 'hex');
    const b = Buffer.from(receivedHash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Serve client (allow without query so Mini App can load); if query is present and invalid, reject
app.get('/', (req, res) => {
  const { room, token } = req.query;
  if (room || token) {
    const expected = room ? computeToken(room) : '';
    if (!room || !token || token !== expected) {
      return res.status(403).send('Forbidden: invalid token');
    }
  }
  return res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

// Token issuance for Mini App starts
app.post('/api/issue-token', (req, res) => {
  const { room, initData } = req.body || {};
  if (!room || typeof room !== 'string') return res.status(400).json({ error: 'room required' });
  if (!verifyTelegramInitData(initData)) return res.status(403).json({ error: 'invalid initData' });
  const token = computeToken(room);
  return res.json({ token });
});

// Static assets (scripts, css, icons)
app.use(express.static(path.join(__dirname, '..', 'client')));

// In-memory per-room state
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