const { Server } = require('socket.io');
const db = require('./db');

let io;

const initSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        const allowed = (process.env.CLIENT_URL || 'http://localhost:5173')
          .split(',').map(u => u.trim());
        if (!origin || allowed.includes(origin)) callback(null, true);
        else callback(new Error('Not allowed by CORS'));
      },
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  io.on('connection', (socket) => {
    console.log(`[Socket] conectado: ${socket.id}`);

    socket.on('chat:join', (userData) => {
      socket.userData = userData;
      socket.join(`user_${userData.id}`);
      io.emit('chat:user_joined', { name: userData.name, id: userData.id });
    });

    socket.on('chat:dm', async ({ senderId, senderName, recipientId, message }) => {
      try {
        const result = await db.query(
          `INSERT INTO chat_messages (user_id, user_name, recipient_id, message)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [senderId, senderName, recipientId, message]
        );
        const msg = result.rows[0];
        io.to(`user_${recipientId}`).emit('chat:dm', msg);
        io.to(`user_${senderId}`).emit('chat:dm', msg);
      } catch (err) {
        console.error('[Chat] Error DM:', err);
      }
    });

    socket.on('disconnect', () => {
      if (socket.userData) {
        io.emit('chat:user_left', { name: socket.userData.name, id: socket.userData.id });
      }
    });
  });

  return io;
};

const getIO = () => io;

const emitDataUpdate = (resource, action, payload = null) => {
  if (!io) return;
  io.emit('data:update', { resource, action, payload });
  console.log(`[Socket] data:update → ${resource}:${action}`);
};

module.exports = { initSocket, getIO, emitDataUpdate };