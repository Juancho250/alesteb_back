const db = require('../config/db');

// GET /api/chat/users — lista de admins para chatear
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
      WHERE u.id != $1 AND u.is_active = true
      ORDER BY last_message_at DESC NULLS LAST, u.name
    `, [req.user.id]);
    res.json({ users: result.rows });
  } catch (err) {
    console.error('[Chat] getChatUsers:', err);
    res.status(500).json({ error: 'Error obteniendo usuarios' });
  }
};

// GET /api/chat/conversation/:userId — historial con un usuario
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

const clearHistory = async (req, res) => {
  try {
    await db.query('DELETE FROM chat_messages');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Error limpiando historial' });
  }
};

module.exports = { getChatUsers, getConversation, clearHistory };