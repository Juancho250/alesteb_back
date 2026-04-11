const { Server } = require('socket.io');
const { pool } = require('./db'); // ajusta al nombre de tu módulo DB

let io;

const initSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: process.env.CLIENT_URL || 'http://localhost:5173',
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  io.on('connection', (socket) => {
    console.log(`[Chat] Admin conectado: ${socket.id}`);

    // El cliente se une con su info de usuario
    socket.on('chat:join', (userData) => {
      socket.userData = userData;
      io.emit('chat:user_joined', {
        name: userData.name,
        socketId: socket.id,
      });
    });

    // Recibe un mensaje, lo guarda y lo re-emite a todos
    socket.on('chat:message', async (data) => {
      const { userId, userName, message } = data;
      try {
        const result = await pool.query(
          `INSERT INTO chat_messages (user_id, user_name, message)
           VALUES ($1, $2, $3) RETURNING *`,
          [userId, userName, message]
        );
        // Broadcast a todos incluyendo al emisor
        io.emit('chat:message', result.rows[0]);
      } catch (err) {
        console.error('[Chat] Error guardando mensaje:', err);
      }
    });

    socket.on('disconnect', () => {
      if (socket.userData) {
        io.emit('chat:user_left', { name: socket.userData.name });
      }
    });
  });

  return io;
};

const getIO = () => io;

module.exports = { initSocket, getIO };