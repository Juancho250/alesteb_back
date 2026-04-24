const { runAgent } = require("../services/agent.service");

const chat = async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages debe ser un array" });
    }
    const result = await runAgent(messages);
    res.json(result);
  } catch (err) {
    console.error("[Agent Error]", err.message);
    res.status(500).json({ error: "Error interno del agente" });
  }
};

module.exports = { chat };