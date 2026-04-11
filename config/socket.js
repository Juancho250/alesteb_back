// config/socket.js
const { Server } = require('socket.io');
const { pool }   = require('./db');

let io;

const initSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      // ✅ Lee la lista de orígenes permitidos desde .env
      // Acepta una lista separada por comas:
      // CLIENT_URL=http://localhost:5173,http://localhost:5174,https://mi-front.vercel.app
      origin: (origin, callback) => {
        const allowed = (process.env.CLIENT_URL || 'http://localhost:5173')
          .split(',')
          .map(u => u.trim());

        // Permitir requests sin origin (ej: Postman, curl)
        if (!origin || allowed.includes(origin)) {
          callback(null, true);
        } else {
          console.warn(`[Socket CORS] Origen bloqueado: ${origin}`);
          callback(new Error('Not allowed by CORS'));
        }
      },
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  // ...resto del código igual (io.on('connection', ...) sin cambios)
  io.on('connection', (socket) => { /* igual que antes */ });

  return io;
};

const getIO = () => io;
module.exports = { initSocket, getIO };