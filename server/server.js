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
        // Map<number, { images: string[], idx: number }>
        stepHistory: new Map()
      }
    });
  }
  return rooms.get(roomId);
}

function getGuideStepHistory(state, step) {
  if (!state.guide.stepHistory.has(step)) {
    state.guide.stepHistory.set(step, { images: [], idx: -1 });
  }
  return state.guide.stepHistory.get(step);
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

  // Send full current state to the newly connected client
  const baseDataUrl = state.historyStep >= 0 ? state.history[state.historyStep] : null;
  let stepDataUrl = null;
  if (state.guide.active && typeof state.guide.step === 'number') {
    const sh = getGuideStepHistory(state, state.guide.step);
    if (sh && sh.idx >= 0 && sh.images[sh.idx]) stepDataUrl = sh.images[sh.idx];
  }
  socket.emit('initState', {
    baseDataUrl,
    guide: {
      active: state.guide.active,
      svgPath: state.guide.svgPath,
      step: state.guide.step,
      stepDataUrl
    }
  });

  socket.on('userSignedUp', ({ signature }) => {
    state.activeUsers.set(socket.id, signature);
    io.to(room).emit('updateUserList', Array.from(state.activeUsers.values()));
  });

  socket.on('requestCanvasState', () => {
    if (state.historyStep >= 0) socket.emit('loadCanvas', { dataUrl: state.history[state.historyStep] });
  });

  socket.on('requestFullState', () => {
    const baseDataUrlReq = state.historyStep >= 0 ? state.history[state.historyStep] : null;
    let stepDataUrlReq = null;
    if (state.guide.active && typeof state.guide.step === 'number') {
      const sh = getGuideStepHistory(state, state.guide.step);
      if (sh && sh.idx >= 0 && sh.images[sh.idx]) stepDataUrlReq = sh.images[sh.idx];
    }
    socket.emit('initState', {
      baseDataUrl: baseDataUrlReq,
      guide: {
        active: state.guide.active,
        svgPath: state.guide.svgPath,
        step: state.guide.step,
        stepDataUrl: stepDataUrlReq
      }
    });
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
  socket.on('guideStart', ({ svgPath }) => {
    state.guide.active = true;
    state.guide.svgPath = svgPath || state.guide.svgPath;
    state.guide.step = -1;
    io.to(room).emit('guideStart', { svgPath: state.guide.svgPath });
  });

  socket.on('guideStepChange', ({ step, svgPath }) => {
    if (typeof step === 'number') state.guide.step = step;
    if (svgPath) state.guide.svgPath = svgPath;
    socket.to(room).emit('guideStepSync', { step, svgPath });
  });

  // Commit current step to base across all clients and go to next step
  socket.on('guideCommitAndGotoStep', ({ step, svgPath, baseDataUrl }) => {
    state.guide.active = true;
    if (typeof step === 'number') state.guide.step = step;
    if (svgPath) state.guide.svgPath = svgPath;
    socket.to(room).emit('guideCommitAndGotoStep', { step, svgPath, baseDataUrl });
  });

  // Exit guide mode across clients
  socket.on('guideExit', ({ baseDataUrl }) => {
    // Reset guide state
    state.guide.active = false;
    state.guide.svgPath = null;
    state.guide.step = -1;
    state.guide.stepHistory = new Map();
    socket.to(room).emit('guideExit', { baseDataUrl });
  });

  // Persist per-step layer after each guide stroke/clear
  socket.on('saveGuideStepState', ({ step, dataUrl }) => {
    if (typeof step !== 'number') return;
    state.guide.active = true;
    state.guide.step = step;
    const sh = getGuideStepHistory(state, step);
    if (sh.idx < sh.images.length - 1) sh.images = sh.images.slice(0, sh.idx + 1);
    sh.images.push(dataUrl);
    sh.idx++;
    // Broadcast to others to update their step overlay
    io.to(room).emit('loadGuideStepLayer', { step, dataUrl });
  });

  socket.on('guideUndo', () => {
    if (!state.guide.active || typeof state.guide.step !== 'number') return;
    const sh = getGuideStepHistory(state, state.guide.step);
    if (sh.idx > 0) {
      sh.idx--;
      const dataUrl = sh.images[sh.idx] || null;
      io.to(room).emit('loadGuideStepLayer', { step: state.guide.step, dataUrl });
    }
  });

  socket.on('guideRedo', () => {
    if (!state.guide.active || typeof state.guide.step !== 'number') return;
    const sh = getGuideStepHistory(state, state.guide.step);
    if (sh.idx < sh.images.length - 1) {
      sh.idx++;
      const dataUrl = sh.images[sh.idx] || null;
      io.to(room).emit('loadGuideStepLayer', { step: state.guide.step, dataUrl });
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