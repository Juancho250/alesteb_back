const db = require('../config/db');

const getHistory = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT cm.id, cm.user_id, cm.user_name, cm.message, cm.created_at
       FROM chat_messages cm
       ORDER BY cm.created_at DESC
       LIMIT 50`
    );
    res.json({ messages: result.rows.reverse() });
  } catch (err) {
    console.error('[Chat] getHistory error:', err);
    res.status(500).json({ error: 'Error obteniendo historial' });
  }
};

const clearHistory = async (req, res) => {
  try {
    await db.query('DELETE FROM chat_messages');
    res.json({ success: true });
  } catch (err) {
    console.error('[Chat] clearHistory error:', err);
    res.status(500).json({ error: 'Error limpiando historial' });
  }
};

module.exports = { getHistory, clearHistory };