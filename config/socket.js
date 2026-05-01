// config/socket.js
const { Server } = require('socket.io');
const db = require('./db');

let io;

const initSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        const allowed = (process.env.CLIENT_URL || 'https://alestebadmin.vercel.app,http://localhost:5173')
          .split(',').map(u => u.trim());
        if (!origin || allowed.includes(origin)) callback(null, true);
        else callback(new Error('Not allowed by CORS'));
      },
      methods: ['GET', 'POST'],
      credentials: true,
    },
    // Reconexión automática más robusta
    pingTimeout:  60000,
    pingInterval: 25000,
  });

  io.on('connection', (socket) => {
    console.log(`[Socket] conectado: ${socket.id}`);

    // ── Unirse a sala personal ──────────────────────────────────────────────
    socket.on('chat:join', (userData) => {
      if (!userData?.id) return;
      socket.userData = userData;
      socket.join(`user_${userData.id}`);
      io.emit('chat:user_joined', { name: userData.name, id: userData.id });
      console.log(`[Socket] ${userData.name} unido a user_${userData.id}`);
    });

    // ── Mensaje directo ─────────────────────────────────────────────────────
    socket.on('chat:dm', async ({ senderId, senderName, recipientId, message }) => {
      if (!senderId || !recipientId || !message?.trim()) return;
      try {
        const result = await db.query(
          `INSERT INTO chat_messages (user_id, user_name, recipient_id, message)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [senderId, senderName, recipientId, message.trim()]
        );
        const msg = result.rows[0];
        io.to(`user_${recipientId}`).emit('chat:dm', msg);
        io.to(`user_${senderId}`).emit('chat:dm', msg);
      } catch (err) {
        console.error('[Chat] Error DM:', err);
        socket.emit('chat:error', { code: 'DM_FAILED', message: 'No se pudo enviar el mensaje' });
      }
    });

    // ── Indicador de escritura ──────────────────────────────────────────────
    socket.on('chat:typing', ({ userId, recipientId, isTyping }) => {
      if (!userId || !recipientId) return;
      // Solo notificar al destinatario, no al remitente
      socket.to(`user_${recipientId}`).emit('chat:typing', { userId, isTyping });
    });

    // ── Desconexión ─────────────────────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      console.log(`[Socket] desconectado: ${socket.id} — ${reason}`);
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