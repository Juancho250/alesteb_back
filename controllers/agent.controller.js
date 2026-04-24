const { runAgent } = require("../services/agent.service");
const db = require("../config/db");

const chat = async (req, res) => {
  try {
    const { messages, conversationId } = req.body;
    const userId = req.user.id;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages debe ser un array" });
    }

    const result = await runAgent(messages);

    // Guardar o actualizar conversación
    if (conversationId) {
      await db.query(
        `UPDATE agent_conversations 
         SET messages = $1, updated_at = NOW()
         WHERE id = $2 AND user_id = $3`,
        [JSON.stringify(result.history), conversationId, userId]
      );
      res.json({ ...result, conversationId });
    } else {
      const saved = await db.query(
        `INSERT INTO agent_conversations (user_id, messages)
         VALUES ($1, $2) RETURNING id`,
        [userId, JSON.stringify(result.history)]
      );
      res.json({ ...result, conversationId: saved.rows[0].id });
    }

  } catch (err) {
    console.error("[Agent Error]", err.message);
    res.status(500).json({ error: "Error interno del agente" });
  }
};

// Cargar conversación existente
const getConversation = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const result = await db.query(
      `SELECT * FROM agent_conversations WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Conversación no encontrada" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Error al cargar conversación" });
  }
};

// Listar todas las conversaciones del usuario
const listConversations = async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await db.query(
      `SELECT id, updated_at,
        (messages->0->>'content') as preview
       FROM agent_conversations
       WHERE user_id = $1
       ORDER BY updated_at DESC
       LIMIT 20`,
      [userId]
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Error al listar conversaciones" });
  }
};

// Eliminar conversación
const deleteConversation = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    await db.query(
      `DELETE FROM agent_conversations WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Error al eliminar conversación" });
  }
};

module.exports = { chat, getConversation, listConversations, deleteConversation };