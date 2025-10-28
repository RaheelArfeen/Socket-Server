// src/socket.js
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const PORT = 3001;
const app = express();
const server = http.createServer(app);

const allowedOrigin = "http://localhost:3000";

app.use(cors({
  origin: [allowedOrigin],
  methods: ["GET", "POST"]
}));

const io = new Server(server, {
  cors: {
    origin: allowedOrigin,
    methods: ["GET", "POST"]
  }
});

io.on('connection', (socket) => {
  console.log(`👤 New client connected: ${socket.id}`);

  socket.on('cartUpdate', (data) => {
    console.log(`🛒 Cart update received from ${data.userEmail}.`);
    io.emit('cartUpdated', { userEmail: data.userEmail });
  });

  socket.on('disconnect', () => {
    console.log(`👋 Client disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`✅ Socket.IO server running on port ${PORT}`);
  console.log(`🔗 Connect to: ${allowedOrigin} (CORS allowed)`);
});
