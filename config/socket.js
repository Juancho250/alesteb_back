// config/socket.js
const { Server } = require('socket.io');
const jwt        = require('jsonwebtoken');
const db         = require('./db');

let io;

const initSocket = (httpServer) => {
  const allowedOrigins = (
    process.env.CLIENT_URL ||
    'https://alestebadmin.vercel.app,http://localhost:5173'
  ).split(',').map((u) => u.trim());

  io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) callback(null, true);
        else callback(new Error('Not allowed by CORS'));
      },
      methods:     ['GET', 'POST'],
      credentials: true,
    },
    pingTimeout:  60_000,
    pingInterval: 25_000,
  });

  // Autenticación JWT obligatoria en cada conexión
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error('AUTH_REQUIRED'));
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET, {
        issuer:   'alesteb-api',
        audience: 'alesteb-client',
      });
      socket.user = decoded;
      next();
    } catch {
      next(new Error('INVALID_TOKEN'));
    }
  });

  io.on('connection', (socket) => {
    const { id, name } = socket.user;

    // Unirse automáticamente a la sala personal usando el JWT verificado
    socket.join(`user_${id}`);
    io.emit('chat:user_joined', { name, id });
    console.log(`[Socket] ${name} (${id}) conectado: ${socket.id}`);

    // ── Mensaje directo — usa identidad del JWT, no del payload del cliente ──
    socket.on('chat:dm', async ({ recipientId, message }) => {
      if (!recipientId || !message?.trim()) return;
      try {
        const result = await db.query(
          `INSERT INTO chat_messages (user_id, user_name, recipient_id, message)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [id, name, recipientId, message.trim()]
        );
        const msg = result.rows[0];
        io.to(`user_${recipientId}`).emit('chat:dm', msg);
        socket.emit('chat:dm', msg);
      } catch (err) {
        console.error('[Chat] Error DM:', err);
        socket.emit('chat:error', { code: 'DM_FAILED', message: 'No se pudo enviar el mensaje' });
      }
    });

    // ── Indicador de escritura ──────────────────────────────────────────────
    socket.on('chat:typing', ({ recipientId, isTyping }) => {
      if (!recipientId) return;
      socket.to(`user_${recipientId}`).emit('chat:typing', { userId: id, isTyping });
    });

    // ── Desconexión ─────────────────────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      console.log(`[Socket] ${name} desconectado: ${socket.id} — ${reason}`);
      io.emit('chat:user_left', { name, id });
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