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
    rooms.set(roomId, { 
      history: [], 
      historyStep: -1, 
      activeUsers: new Map(),
      currentDrawer: null, // Track who is currently drawing
      drawingStartTime: null // Track when drawing started
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

  socket.on('userSignedUp', ({ signature }) => {
    state.activeUsers.set(socket.id, signature);
    io.to(room).emit('updateUserList', Array.from(state.activeUsers.values()));
  });

  socket.on('requestCanvasState', () => {
    if (state.historyStep >= 0) socket.emit('loadCanvas', { dataUrl: state.history[state.historyStep] });
  });

  socket.on('startDrawing', (data) => {
    // Check if someone else is already drawing
    if (state.currentDrawer && state.currentDrawer !== socket.id) {
      // Someone else is drawing, reject this request
      socket.emit('drawingLocked', { 
        message: 'Someone else is currently drawing. Please wait for them to finish.',
        currentDrawer: state.currentDrawer 
      });
      return;
    }

    // Check if drawing has been going on too long (timeout after 30 seconds)
    const now = Date.now();
    if (state.drawingStartTime && (now - state.drawingStartTime) > 30000) {
      // Reset if drawing has been going on too long
      state.currentDrawer = null;
      state.drawingStartTime = null;
    }

    // Lock the canvas for this user
    state.currentDrawer = socket.id;
    state.drawingStartTime = now;
    
    // Broadcast to other users with sender id
    socket.to(room).emit('startDrawing', { ...data, userId: socket.id });
    socket.to(room).emit('drawingLocked', { 
      message: 'Someone started drawing. Please wait for them to finish.',
      currentDrawer: socket.id 
    });
  });

  socket.on('draw', (data) => {
    // Only allow drawing if this user has the lock
    if (state.currentDrawer === socket.id) {
      socket.to(room).emit('draw', { ...data, userId: socket.id });
    }
  });

  socket.on('stopDrawing', () => {
    // Only allow stopping if this user has the lock
    if (state.currentDrawer === socket.id) {
      // Release the lock
      state.currentDrawer = null;
      state.drawingStartTime = null;
      
      socket.to(room).emit('stopDrawing', { userId: socket.id });
      socket.to(room).emit('drawingUnlocked', { 
        message: 'Drawing is now available.',
        currentDrawer: null 
      });
    }
  });

  socket.on('fill', (data) => {
    // Check if someone else is drawing
    if (state.currentDrawer && state.currentDrawer !== socket.id) {
      socket.emit('drawingLocked', { 
        message: 'Someone else is currently drawing. Please wait for them to finish.',
        currentDrawer: state.currentDrawer 
      });
      return;
    }

    // Fill operations are quick, so we can allow them even if someone is drawing
    // But we'll still notify others
    socket.to(room).emit('fill', data);
  });

  socket.on('clearCanvas', () => {
    // Clear operations affect everyone, so we need to coordinate
    if (state.currentDrawer && state.currentDrawer !== socket.id) {
      socket.emit('drawingLocked', { 
        message: 'Someone else is currently drawing. Please wait for them to finish.',
        currentDrawer: state.currentDrawer 
      });
      return;
    }

    // Release any drawing lock since we're clearing
    state.currentDrawer = null;
    state.drawingStartTime = null;
    
    socket.to(room).emit('clearCanvas');
    socket.to(room).emit('drawingUnlocked', { 
      message: 'Canvas cleared. Drawing is now available.',
      currentDrawer: null 
    });
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

  socket.on('disconnect', () => {
    // If the disconnecting user was drawing, release the lock
    if (state.currentDrawer === socket.id) {
      state.currentDrawer = null;
      state.drawingStartTime = null;
      socket.to(room).emit('drawingUnlocked', { 
        message: 'The person who was drawing left. Drawing is now available.',
        currentDrawer: null 
      });
    }
    
    state.activeUsers.delete(socket.id);
    io.to(room).emit('updateUserList', Array.from(state.activeUsers.values()));
    console.log(`Socket ${socket.id} left room ${room}`);
  });
});

server.listen(PORT, () => {
  console.log(`✔️ Server listening on port ${PORT}`);
});