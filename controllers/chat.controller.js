const db = require('../config/db');
const cloudinary = require('../config/cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');
const { getIO } = require('../config/socket');

// ── Multer/Cloudinary para imágenes de chat ──────────────────────────────────
const chatStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder: 'chat_images',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
    public_id: `chat-${Date.now()}-${file.originalname.split('.')[0]}`,
  }),
});
const uploadChatImage = multer({
  storage: chatStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
});

// GET /api/chat/users
const getChatUsers = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT u.id, u.name, u.email,
        (SELECT cm.message FROM chat_messages cm
         WHERE (cm.user_id = u.id AND cm.recipient_id = $1)
            OR (cm.user_id = $1 AND cm.recipient_id = u.id)
         ORDER BY cm.created_at DESC LIMIT 1) AS last_message,
        (SELECT cm.created_at FROM chat_messages cm
         WHERE (cm.user_id = u.id AND cm.recipient_id = $1)
            OR (cm.user_id = $1 AND cm.recipient_id = u.id)
         ORDER BY cm.created_at DESC LIMIT 1) AS last_message_at
      FROM users u
      INNER JOIN user_roles ur ON ur.user_id = u.id
      INNER JOIN roles r       ON r.id = ur.role_id AND r.name = 'admin'
      WHERE u.id != $1 AND u.is_active = true
      ORDER BY last_message_at DESC NULLS LAST, u.name
    `, [req.user.id]);
    res.json({ users: result.rows });
  } catch (err) {
    console.error('[Chat] getChatUsers:', err);
    res.status(500).json({ error: 'Error obteniendo usuarios' });
  }
};

// GET /api/chat/conversation/:userId
const getConversation = async (req, res) => {
  const { userId } = req.params;
  const myId = req.user.id;
  try {
    const result = await db.query(`
      SELECT * FROM chat_messages
      WHERE (user_id = $1 AND recipient_id = $2)
         OR (user_id = $2 AND recipient_id = $1)
      ORDER BY created_at ASC
      LIMIT 100
    `, [myId, userId]);
    res.json({ messages: result.rows });
  } catch (err) {
    console.error('[Chat] getConversation:', err);
    res.status(500).json({ error: 'Error obteniendo conversación' });
  }
};

// PUT /api/chat/message/:id
const editMessage = async (req, res) => {
  const { id } = req.params;
  const { message } = req.body;
  const myId = req.user.id;
  try {
    const result = await db.query(`
      UPDATE chat_messages
      SET message = $1, edited_at = NOW()
      WHERE id = $2 AND user_id = $3
      RETURNING *
    `, [message, id, myId]);

    if (result.rowCount === 0)
      return res.status(403).json({ error: 'No autorizado o mensaje no encontrado' });

    const updatedMsg = result.rows[0];

    // Notificar en tiempo real a ambos participantes de la conversación
    const io = getIO();
    if (io) {
      io.to(`user_${updatedMsg.recipient_id}`).emit('chat:message_edited', updatedMsg);
      io.to(`user_${updatedMsg.user_id}`).emit('chat:message_edited', updatedMsg);
    }

    res.json({ message: updatedMsg });
  } catch (err) {
    console.error('[Chat] editMessage:', err);
    res.status(500).json({ error: 'Error editando mensaje' });
  }
};

// POST /api/chat/image
const uploadImage = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió imagen' });

    const recipientId = req.body.recipientId || req.body.recipient_id;
    if (!recipientId) return res.status(400).json({ error: 'Falta recipientId' });

    const result = await db.query(
      `INSERT INTO chat_messages (user_id, recipient_id, message, image_url)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.user.id, recipientId, '', req.file.path]
    );

    const newMsg = result.rows[0];

    // Emitir imagen a ambos participantes por socket
    const io = getIO();
    if (io) {
      io.to(`user_${recipientId}`).emit('chat:dm', newMsg);
      io.to(`user_${req.user.id}`).emit('chat:dm', newMsg);
    }

    res.json({ message: newMsg });
  } catch (err) {
    console.error('[Chat] uploadImage error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

// DELETE /api/chat/history
const clearHistory = async (req, res) => {
  try {
    await db.query('DELETE FROM chat_messages');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Error limpiando historial' });
  }
};

module.exports = {
  getChatUsers, getConversation, editMessage,
  uploadImage, uploadChatImage, clearHistory,
};