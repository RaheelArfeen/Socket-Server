const io = require('socket.io')(3001, {
  cors: {
      origin: 'http://localhost:3000',
      methods: ['GET', 'POST'],
  },
});

io.on('connection', (socket) => {
  socket.on('cartUpdate', (data) => {
      io.emit('cartUpdated', data);
  });

  socket.on('disconnect', () => {
  });
});

console.log('Socket.IO server running on port 3001');