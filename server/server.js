const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
// Add this to server.js
const path = require('path');
app.use(express.static(path.join(__dirname, '..', 'client')));

let history = [];
let historyStep = -1;
// NEW: Map to store active users and their signatures
const activeUsers = new Map();

io.on('connection', (socket) => {
  console.log(`A user connected: ${socket.id}`);

  // Send the current drawing state to the new user
  if (historyStep >= 0) {
    socket.emit('loadCanvas', { dataUrl: history[historyStep] });
  }

  // --- NEW: User Signature Handling ---
  socket.on('userSignedUp', ({ signature }) => {
    // Store the new user's signature
    activeUsers.set(socket.id, signature);
    // Broadcast the updated list of users to EVERYONE
    io.emit('updateUserList', Array.from(activeUsers.values()));
  });


  // --- All other events remain the same ---
  socket.on('requestCanvasState', () => { /* ... */ });
  socket.on('startDrawing', (data) => socket.broadcast.emit('startDrawing', data));
  socket.on('draw', (data) => socket.broadcast.emit('draw', data));
  socket.on('stopDrawing', () => socket.broadcast.emit('stopDrawing'));
  socket.on('fill', (data) => socket.broadcast.emit('fill', data));
  socket.on('clearCanvas', () => socket.broadcast.emit('clearCanvas'));
  socket.on('saveState', ({ dataUrl }) => { /* ... */ });
  socket.on('undo', () => { /* ... */ });
  socket.on('redo', () => { /* ... */ });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    // NEW: Remove user on disconnect and update everyone's list
    activeUsers.delete(socket.id);
    io.emit('updateUserList', Array.from(activeUsers.values()));
  });
});

// (Pasting full functions for clarity)
io.on('connection', (socket) => {
    console.log(`A user connected: ${socket.id}`);

    if (historyStep >= 0) socket.emit('loadCanvas', { dataUrl: history[historyStep] });

    socket.on('requestCanvasState', () => {
        if (historyStep >= 0) socket.emit('loadCanvas', { dataUrl: history[historyStep] });
    });

    socket.on('userSignedUp', ({ signature }) => {
        activeUsers.set(socket.id, signature);
        io.emit('updateUserList', Array.from(activeUsers.values()));
    });

    socket.on('startDrawing', (data) => socket.broadcast.emit('startDrawing', data));
    socket.on('draw', (data) => socket.broadcast.emit('draw', data));
    socket.on('stopDrawing', () => socket.broadcast.emit('stopDrawing'));
    socket.on('fill', (data) => socket.broadcast.emit('fill', data));
    socket.on('clearCanvas', () => socket.broadcast.emit('clearCanvas'));

    socket.on('saveState', ({ dataUrl }) => {
        if (historyStep < history.length - 1) history = history.slice(0, historyStep + 1);
        history.push(dataUrl);
        historyStep++;
    });

    socket.on('undo', () => {
        if (historyStep > 0) {
            historyStep--;
            io.emit('loadCanvas', { dataUrl: history[historyStep] });
        }
    });

    socket.on('redo', () => {
        if (historyStep < history.length - 1) {
            historyStep++;
            io.emit('loadCanvas', { dataUrl: history[historyStep] });
        }
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        activeUsers.delete(socket.id);
        io.emit('updateUserList', Array.from(activeUsers.values()));
    });
});

server.listen(PORT, () => {
  console.log(`✔️ Server listening on port ${PORT}`);
});