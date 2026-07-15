const { getAuraBusinessContext } = require("../services/auraContext.service");
const { generateAuraReply } = require("../services/auraOpenAI.service");

const MAX_MESSAGE_LENGTH = 2000;
const MAX_HISTORY_ITEMS = 12;

const normalizeHistory = (history) => {
  if (!Array.isArray(history)) return [];

  return history
    .slice(-MAX_HISTORY_ITEMS)
    .map((item) => ({
      role: item?.role === "assistant" ? "assistant" : "user",
      content: typeof item?.content === "string"
        ? item.content.slice(0, MAX_MESSAGE_LENGTH)
        : "",
    }))
    .filter((item) => item.content.trim().length > 0);
};

exports.chat = async (req, res) => {
  try {
    const { message, history = [] } = req.body || {};

    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({
        success: false,
        message: "message es requerido y debe ser texto",
        code: "INVALID_MESSAGE",
      });
    }

    if (message.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({
        success: false,
        message: `message no puede superar ${MAX_MESSAGE_LENGTH} caracteres`,
        code: "MESSAGE_TOO_LONG",
      });
    }

    const businessContext = await getAuraBusinessContext({
      adminId: req.adminId,
      isSuperAdmin: req.isSuperAdmin,
    });

    const aura = await generateAuraReply({
      message: message.trim(),
      history: normalizeHistory(history),
      businessContext,
    });

    return res.json({
      success: true,
      data: {
        reply: aura.reply,
        insights: businessContext.insights,
        suggestedActions: aura.suggestedActions,
      },
    });
  } catch (err) {
    console.error("[aura.controller] chat:", err.message);

    if (err.code === "AURA_OPENAI_MISSING_KEY") {
      return res.status(503).json({
        success: false,
        message: "OPENAI_API_KEY no configurada en el servidor",
        code: err.code,
      });
    }

    if (err.code === "AURA_OPENAI_RATE_LIMIT") {
      return res.status(429).json({
        success: false,
        message: "Limite de consultas de AURA alcanzado. Intenta nuevamente en unos minutos.",
        code: err.code,
      });
    }

    return res.status(500).json({
      success: false,
      message: "Error al procesar la consulta de AURA",
      code: "AURA_CHAT_ERROR",
    });
  }
};
