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
      // Guide mode state
      guideMode: {
        isActive: false,
        currentStep: -1,
        svgPath: null,
        suggestionLayer: null, // Suggestion canvas state
        stepCanvasData: null,   // Current step canvas state
        sortedColorGroups: []   // Cached color groups for quick restoration
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

  // Send current canvas state
  if (state.historyStep >= 0) {
    socket.emit('loadCanvas', { dataUrl: state.history[state.historyStep] });
  }

  // Send current guide mode state if active
  if (state.guideMode.isActive) {
    socket.emit('restoreGuideMode', {
      step: state.guideMode.currentStep,
      svgPath: state.guideMode.svgPath,
      suggestionLayer: state.guideMode.suggestionLayer,
      stepCanvasData: state.guideMode.stepCanvasData,
      sortedColorGroups: state.guideMode.sortedColorGroups
    });
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
    socket.to(room).emit('guideStepSync', { step, svgPath });
  });

  // Start guide mode with initial state
  socket.on('guideStart', ({ step, svgPath, suggestionLayer, sortedColorGroups }) => {
    state.guideMode.isActive = true;
    state.guideMode.currentStep = step;
    state.guideMode.svgPath = svgPath;
    state.guideMode.suggestionLayer = suggestionLayer;
    state.guideMode.stepCanvasData = null; // Clear step canvas on start
    state.guideMode.sortedColorGroups = sortedColorGroups;
    
    socket.to(room).emit('guideStart', { 
      step, 
      svgPath, 
      suggestionLayer,
      sortedColorGroups 
    });
  });

  // Update suggestion layer (when step changes)
  socket.on('guideSuggestionUpdate', ({ suggestionLayer }) => {
    if (state.guideMode.isActive) {
      state.guideMode.suggestionLayer = suggestionLayer;
      socket.to(room).emit('guideSuggestionUpdate', { suggestionLayer });
    }
  });

  // Update step canvas data
  socket.on('guideStepCanvasUpdate', ({ stepCanvasData }) => {
    if (state.guideMode.isActive) {
      state.guideMode.stepCanvasData = stepCanvasData;
      socket.to(room).emit('guideStepCanvasUpdate', { stepCanvasData });
    }
  });

  // Commit current step to base across all clients and go to next step
  socket.on('guideCommitAndGotoStep', ({ step, svgPath, baseDataUrl, suggestionLayer }) => {
    if (state.guideMode.isActive) {
      state.guideMode.currentStep = step;
      state.guideMode.suggestionLayer = suggestionLayer;
      state.guideMode.stepCanvasData = null; // Clear step canvas
      
      // Update main canvas history if baseDataUrl provided
      if (baseDataUrl) {
        if (state.historyStep < state.history.length - 1) {
          state.history = state.history.slice(0, state.historyStep + 1);
        }
        state.history.push(baseDataUrl);
        state.historyStep++;
      }
    }
    
    socket.to(room).emit('guideCommitAndGotoStep', { 
      step, 
      svgPath, 
      baseDataUrl,
      suggestionLayer 
    });
  });

  // Exit guide mode across clients
  socket.on('guideExit', ({ baseDataUrl }) => {
    // Reset guide mode state
    state.guideMode.isActive = false;
    state.guideMode.currentStep = -1;
    state.guideMode.svgPath = null;
    state.guideMode.suggestionLayer = null;
    state.guideMode.stepCanvasData = null;
    state.guideMode.sortedColorGroups = [];

    // Update main canvas history if baseDataUrl provided
    if (baseDataUrl) {
      if (state.historyStep < state.history.length - 1) {
        state.history = state.history.slice(0, state.historyStep + 1);
      }
      state.history.push(baseDataUrl);
      state.historyStep++;
    }
    
    socket.to(room).emit('guideExit', { baseDataUrl });
  });

  // Clear guide step canvas
  socket.on('guideClearStep', () => {
    if (state.guideMode.isActive) {
      state.guideMode.stepCanvasData = null;
      socket.to(room).emit('guideClearStep');
    }
  });

  // Guide step undo/redo
  socket.on('guideStepUndo', ({ stepCanvasData }) => {
    if (state.guideMode.isActive) {
      state.guideMode.stepCanvasData = stepCanvasData;
      socket.to(room).emit('guideStepUndo', { stepCanvasData });
    }
  });

  socket.on('guideStepRedo', ({ stepCanvasData }) => {
    if (state.guideMode.isActive) {
      state.guideMode.stepCanvasData = stepCanvasData;
      socket.to(room).emit('guideStepRedo', { stepCanvasData });
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