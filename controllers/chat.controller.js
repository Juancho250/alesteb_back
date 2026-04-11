const { pool } = require('../config/db');

// GET /api/chat/history — últimos 50 mensajes
const getHistory = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT cm.id, cm.user_id, cm.user_name, cm.message, cm.created_at
       FROM chat_messages cm
       ORDER BY cm.created_at DESC
       LIMIT 50`
    );
    // Invertir para que lleguen en orden cronológico
    res.json({ messages: result.rows.reverse() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error obteniendo historial' });
  }
};

// DELETE /api/chat/history — limpiar sala (solo admin)
const clearHistory = async (req, res) => {
  try {
    await pool.query('DELETE FROM chat_messages');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Error limpiando historial' });
  }
};

module.exports = { getHistory, clearHistory };
