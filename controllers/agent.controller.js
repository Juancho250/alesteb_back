// controllers/agent.controller.js  (versión actualizada)
const { runAgent } = require("../services/agent.service");
const db = require("../config/db");

// ── Endpoint principal ────────────────────────────────────────────────────────
const chat = async (req, res) => {
  try {
    const { messages, conversationId } = req.body;
    const userId = req.user.id;

    if (!Array.isArray(messages))
      return res.status(400).json({ error: "messages debe ser un array" });

    const result = await runAgent(messages);

    // Persistir conversación
    if (conversationId) {
      await db.query(
        `UPDATE agent_conversations SET messages=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3`,
        [JSON.stringify(result.history), conversationId, userId]
      );
      return res.json({ ...result, conversationId });
    }

    const saved = await db.query(
      `INSERT INTO agent_conversations (user_id, messages) VALUES ($1,$2) RETURNING id`,
      [userId, JSON.stringify(result.history)]
    );
    res.json({ ...result, conversationId: saved.rows[0].id });

  } catch (err) {
    console.error("[Agent Controller]", err.message);
    res.status(500).json({ error: "Error interno del agente" });
  }
};

// ── Confirmar acción pendiente ────────────────────────────────────────────────
// El frontend puede llamar esto directamente cuando el usuario confirma,
// o simplemente dejar que el agente lo maneje vía el mensaje "sí confirmo".
const confirmAction = async (req, res) => {
  try {
    const { sql, conversationId } = req.body;
    const userId = req.user.id;

    if (!sql) return res.status(400).json({ error: "sql requerido" });

    // Reenviar como mensaje de confirmación al agente
    const confirmMsg = { role: "user", content: "sí confirmo" };
    const conv = await db.query(
      `SELECT messages FROM agent_conversations WHERE id=$1 AND user_id=$2`,
      [conversationId, userId]
    );
    if (conv.rowCount === 0) return res.status(404).json({ error: "Conversación no encontrada" });

    const messages = [...conv.rows[0].messages, confirmMsg];
    const result   = await runAgent(messages);

    await db.query(
      `UPDATE agent_conversations SET messages=$1, updated_at=NOW() WHERE id=$2`,
      [JSON.stringify(result.history), conversationId]
    );

    res.json({ ...result, conversationId });
  } catch (err) {
    console.error("[Confirm Action]", err.message);
    res.status(500).json({ error: "Error al confirmar acción" });
  }
};

const getConversation = async (req, res) => {
  try {
    const { id } = req.params;
    const result  = await db.query(
      `SELECT * FROM agent_conversations WHERE id=$1 AND user_id=$2`,
      [id, req.user.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "No encontrada" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Error al cargar conversación" });
  }
};

const listConversations = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, updated_at, (messages->0->>'content') as preview
       FROM agent_conversations WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 20`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Error al listar conversaciones" });
  }
};

const deleteConversation = async (req, res) => {
  try {
    await db.query(
      `DELETE FROM agent_conversations WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Error al eliminar" });
  }
};

module.exports = { chat, confirmAction, getConversation, listConversations, deleteConversation };