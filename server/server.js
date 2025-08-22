const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());

const PORT = process.env.PORT || 3000;

// Serve client unconditionally (for now)
app.get('/', (req, res) => {
  return res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

// Static assets (scripts, css, icons)
app.use(express.static(path.join(__dirname, '..', 'client')));
// Serve images (SVGs and others)
app.use('/images', express.static(path.join(__dirname, '..', 'images')));

// API to list available SVGs for the guide
app.get('/api/svgs', (req, res) => {
  try {
    const svgDir = path.join(__dirname, '..', 'images', 'SVG');
    if (!fs.existsSync(svgDir)) return res.json([]);
    const files = fs.readdirSync(svgDir)
      .filter(f => f.toLowerCase().endsWith('.svg'))
      .map(f => ({ name: f, url: `/images/SVG/${encodeURIComponent(f)}` }));
    res.json(files);
  } catch (e) {
    console.error('Error listing SVGs:', e);
    res.status(500).json({ error: 'failed' });
  }
});

// In-memory per-room state
const rooms = new Map();

function getRoomState(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { 
      history: [], 
      historyStep: -1, 
      activeUsers: new Map(),
      guide: {
        active: false,
        svgPath: null,
        stepIndex: -1
      }
    });
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

  // Send current guide state to the new client if active
  if (state.guide && state.guide.active && state.guide.svgPath) {
    socket.emit('guideSet', { svgPath: state.guide.svgPath, stepIndex: state.guide.stepIndex });
  }

  socket.on('userSignedUp', ({ signature }) => {
    state.activeUsers.set(socket.id, signature);
    io.to(room).emit('updateUserList', Array.from(state.activeUsers.values()));
  });

  socket.on('requestCanvasState', () => {
    if (state.historyStep >= 0) socket.emit('loadCanvas', { dataUrl: state.history[state.historyStep] });
  });

  // New single-shot stroke event
  socket.on('stroke', (stroke) => {
    socket.to(room).emit('applyStroke', stroke);
  });

  socket.on('fill', (data) => {
    socket.to(room).emit('fill', data);
  });

  socket.on('clearCanvas', () => {
    socket.to(room).emit('clearCanvas');
  });

  socket.on('saveState', ({ dataUrl }) => {
    if (state.historyStep < state.history.length - 1) state.history = state.history.slice(0, state.historyStep + 1);
    state.history.push(dataUrl);
    state.historyStep++;
  });

  // Guide synchronization events
  socket.on('guideSet', ({ svgPath, stepIndex }) => {
    state.guide.active = true;
    state.guide.svgPath = svgPath;
    state.guide.stepIndex = typeof stepIndex === 'number' ? stepIndex : 0;
    io.to(room).emit('guideSet', { svgPath: state.guide.svgPath, stepIndex: state.guide.stepIndex });
  });

  socket.on('guideStep', ({ stepIndex }) => {
    if (typeof stepIndex === 'number') {
      state.guide.stepIndex = stepIndex;
      io.to(room).emit('guideStep', { stepIndex });
    }
  });

  socket.on('guideEnd', () => {
    state.guide.active = false;
    state.guide.svgPath = null;
    state.guide.stepIndex = -1;
    io.to(room).emit('guideEnd');
  });

  socket.on('stepStroke', (stroke) => {
    // Mirror of normal stroke, but applied to step layer client-side
    socket.to(room).emit('applyStepStroke', stroke);
  });

  socket.on('stepFill', (data) => {
    socket.to(room).emit('stepFill', data);
  });

  socket.on('commitStep', () => {
    // Ask clients to merge step layer into base and clear step layer
    io.to(room).emit('commitStep');
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