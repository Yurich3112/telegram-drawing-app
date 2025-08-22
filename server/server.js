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

// Serve client unconditionally (for now)
app.get('/', (req, res) => {
  return res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

// Static assets (scripts, css, icons)
app.use(express.static(path.join(__dirname, '..', 'client')));

// Serve images
app.use('/images', express.static(path.join(__dirname, '..', 'images')));

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
        step: -1,
        stepDataUrl: null
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

  // Send initial state to the new client
  socket.emit('initState', {
    baseDataUrl: state.historyStep >= 0 ? state.history[state.historyStep] : null,
    guide: state.guide
  });

  socket.on('userSignedUp', ({ signature }) => {
    state.activeUsers.set(socket.id, signature);
    io.to(room).emit('updateUserList', Array.from(state.activeUsers.values()));
  });

  socket.on('requestCanvasState', () => {
    if (state.historyStep >= 0) socket.emit('loadCanvas', { dataUrl: state.history[state.historyStep] });
    // Also sync guide state on demand
    socket.emit('guideSyncState', state.guide);
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

  // Guide mode synchronization
  socket.on('guideStepChange', ({ step, svgPath }) => {
    state.guide.active = true;
    if (typeof step === 'number') state.guide.step = step;
    if (typeof svgPath === 'string') state.guide.svgPath = svgPath;
    socket.to(room).emit('guideStepSync', { step, svgPath });
  });

  // Commit current step to base across all clients and go to next step
  socket.on('guideCommitAndGotoStep', ({ step, svgPath, baseDataUrl }) => {
    state.guide.active = true;
    state.guide.step = typeof step === 'number' ? step : state.guide.step;
    state.guide.svgPath = typeof svgPath === 'string' ? svgPath : state.guide.svgPath;
    // Reset current step layer for the new step
    state.guide.stepDataUrl = null;
    socket.to(room).emit('guideCommitAndGotoStep', { step, svgPath, baseDataUrl });
  });

  // Exit guide mode across clients
  socket.on('guideExit', ({ baseDataUrl }) => {
    state.guide = { active: false, svgPath: null, step: -1, stepDataUrl: null };
    socket.to(room).emit('guideExit', { baseDataUrl });
  });

  // Persist and broadcast the current guide step layer (top layer) as a data URL
  socket.on('saveStepState', ({ dataUrl }) => {
    if (!state.guide.active) return;
    try {
      state.guide.stepDataUrl = dataUrl || null;
      io.to(room).emit('loadStepState', { dataUrl: state.guide.stepDataUrl });
    } catch (_) {}
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