const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Serve client unconditionally
app.get('/', (req, res) => {
  return res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

// Static assets (scripts, css, icons)
app.use(express.static(path.join(__dirname, '..', 'client')));
// Accept dataUrl from client and forward as photo to Telegram chat
app.post('/api/send-canvas', async (req, res) => {
  try {
    if (!BOT_TOKEN) return res.status(500).json({ error: 'Missing bot token' });
    const { room, dataUrl } = req.body || {};
    if (!room || !dataUrl) return res.status(400).json({ error: 'Missing room or dataUrl' });
    // Convert dataUrl to Buffer
    const match = /^data:image\/(png|jpeg);base64,(.+)$/i.exec(dataUrl);
    if (!match) return res.status(400).json({ error: 'Invalid dataUrl' });
    const buffer = Buffer.from(match[2], 'base64');

    const form = new (require('form-data'))();
    form.append('chat_id', room);
    form.append('photo', buffer, { filename: 'canvas.png', contentType: 'image/png' });
    form.append('caption', 'Latest canvas snapshot');

    const tgResp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
      method: 'POST',
      body: form
    });
    const body = await tgResp.json();
    if (!tgResp.ok || !body.ok) {
      return res.status(500).json({ error: 'Telegram send failed', details: body });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('send-canvas error', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// In-memory per-room state
const rooms = new Map();

function getRoomState(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { history: [], historyStep: -1, activeUsers: new Map() });
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