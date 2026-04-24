import { runAgent } from "../services/agent.service.js";

export const chat = async (req, res) => {
  try {
    const { messages } = req.body;
    const result = await runAgent(messages);
    res.json(result);
  } catch (err) {
    console.error("Error en agente:", err);
    res.status(500).json({ error: "Error interno del agente" });
  }
};