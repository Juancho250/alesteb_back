// config/socket.js
const { Server }            = require('socket.io');
const jwt                   = require('jsonwebtoken');
const db                    = require('../src/platform/database');
const { registerChatSocketHandlers } = require('../src/modules/chat').socket;

let io;

const initSocket = (httpServer) => {
  const allowedOrigins = (
    process.env.CLIENT_URL ||
    'https://alestebadmin.vercel.app,http://localhost:5173,http://localhost:5174'
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

  // Autenticación JWT obligatoria + resolución de adminId para rooms de tenant
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error('AUTH_REQUIRED'));
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET, {
        issuer:   'alesteb-api',
        audience: 'alesteb-client',
      });
      // owner_admin_id: null = admin raíz, valor = sub-usuario
      const { rows } = await db.query(
        'SELECT owner_admin_id FROM users WHERE id = $1 AND is_active = true',
        [decoded.id]
      );
      if (!rows.length) return next(new Error('USER_NOT_FOUND'));
      socket.user = {
        ...decoded,
        adminId: rows[0].owner_admin_id ?? decoded.id,
      };
      next();
    } catch {
      next(new Error('INVALID_TOKEN'));
    }
  });

  io.on('connection', (socket) => {
    const { id, name, roles, adminId } = socket.user;

    // Sala personal (chat DM)
    socket.join(`user_${id}`);
    // Sala de tenant — recibe todos los data:update de ese admin
    socket.join(`admin_${adminId}`);
    // Superadmin ve actualizaciones de TODOS los tenants
    if (roles?.includes('superadmin')) socket.join('superadmin');

    console.log(`[Socket] ${name} (${id}) admin:${adminId} conectado: ${socket.id}`);

    // Eventos pertenecientes al dominio Chat.
    registerChatSocketHandlers({ io, socket });

    // ── Desconexión ─────────────────────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      console.log(`[Socket] ${name} desconectado: ${socket.id} — ${reason}`);
    });
  });

  return io;
};

const getIO = () => io;

/**
 * Emite un evento data:update al room del tenant correcto.
 * @param {string} resource  - "products" | "sales" | "providers" | etc.
 * @param {string} action    - "created" | "updated" | "deleted"
 * @param {*}      payload   - datos del registro
 * @param {number|null} adminId - owner_admin_id del tenant (req.adminId)
 */
const emitDataUpdate = (resource, action, payload = null, adminId = null) => {
  if (!io) return;
  const event = { resource, action, payload };
  if (adminId) {
    // Emite al admin dueño + superadmin (quien ve todo)
    io.to(`admin_${adminId}`).to('superadmin').emit('data:update', event);
  } else {
    // Sin tenant (ej. superadmin operando) → solo sala superadmin
    io.to('superadmin').emit('data:update', event);
  }
};

module.exports = { initSocket, getIO, emitDataUpdate };
