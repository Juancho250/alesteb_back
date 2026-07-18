// Deprecated compatibility adapter for the legacy /api/agent contract.
// It delegates to the safe, read-only AURA flow and never loads
// services/agent.service.js or its SQL-generating tools.
const auraChat = require("../services/auraChat.service");
const {
  listConversations: listStoredConversations,
  getConversation: getStoredConversation,
  deleteConversation: deleteStoredConversation,
  sanitizeHistory,
} = require("../services/auraPersistence.service");

function sendAgentError(req, res, err) {
  if (res.headersSent) return res;
  const knownStatus = {
    AURA_OPENAI_MISSING_KEY: 503,
    AURA_OPENAI_RATE_LIMIT: 429,
    AURA_OPENAI_TIMEOUT: 504,
    AURA_OPENAI_ERROR: 502,
    AURA_DAILY_QUOTA_EXCEEDED: 429,
    AURA_QUOTA_UNAVAILABLE: 503,
    AURA_CONVERSATION_NOT_FOUND: 404,
    AURA_TOOL_LIMIT_EXCEEDED: 502,
    AURA_TOOL_LOOP_LIMIT: 502,
    INVALID_CONVERSATION_ID: 400,
  };
  const messages = {
    AURA_OPENAI_MISSING_KEY: "OPENAI_API_KEY no configurada en el servidor",
    AURA_OPENAI_RATE_LIMIT: "Limite del proveedor de IA alcanzado.",
    AURA_OPENAI_TIMEOUT: "El proveedor de IA tardo demasiado en responder.",
    AURA_OPENAI_ERROR: "El proveedor de IA no pudo procesar la solicitud.",
    AURA_DAILY_QUOTA_EXCEEDED: "Limite diario de consultas AURA alcanzado.",
    AURA_QUOTA_UNAVAILABLE: "No fue posible verificar la cuota de AURA.",
    AURA_CONVERSATION_NOT_FOUND: "Conversacion no encontrada",
    AURA_TOOL_LIMIT_EXCEEDED: "AURA excedio el limite seguro de herramientas.",
    AURA_TOOL_LOOP_LIMIT: "AURA excedio el ciclo seguro de herramientas.",
    INVALID_CONVERSATION_ID: "conversationId invalido",
  };
  const status = knownStatus[err.code] || 500;
  return res.status(status).json({
    success: false,
    message: status === 500
      ? "Error al procesar la consulta del agente"
      : messages[err.code] || "Solicitud no valida",
    code: err.code || "AGENT_COMPAT_ERROR",
    requestId: req.id,
  });
}

exports.chat = async (req, res) => {
  try {
    const { messages, conversationId = null } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        success: false,
        message: "messages array requerido",
        code: "INVALID_MESSAGES",
        requestId: req.id,
      });
    }

    let lastUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "user" && typeof messages[i]?.content === "string") {
        lastUserIndex = i;
        break;
      }
    }

    if (lastUserIndex < 0 || !messages[lastUserIndex].content.trim()) {
      return res.status(400).json({
        success: false,
        message: "Se requiere un mensaje de usuario",
        code: "INVALID_MESSAGE",
        requestId: req.id,
      });
    }

    const message = messages[lastUserIndex].content.trim();
    if (message.length > 2000) {
      return res.status(400).json({
        success: false,
        message: "El mensaje no puede superar 2000 caracteres",
        code: "MESSAGE_TOO_LONG",
        requestId: req.id,
      });
    }

    const result = await auraChat.executeAuraChat({
      ownerAdminId: req.auraAdminId,
      userId: req.user.id,
      roles: req.user.roles || [],
      message,
      history: sanitizeHistory(messages.slice(0, lastUserIndex)),
      conversationId,
      requestId: req.id,
    });

    if (res.headersSent) return res;
    return res.json({
      success: true,
      reply: result.reply,
      history: result.history,
      needsConfirm: false,
      pendingAction: null,
      insights: result.insights,
      suggestedActions: result.suggestedActions,
      conversationId: result.conversationId,
      runId: result.runId,
      requestId: result.requestId,
    });
  } catch (err) {
    return sendAgentError(req, res, err);
  }
};

exports.validateChatRequest = (req, res, next) => {
  const { messages, conversationId = null } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 50) {
    return res.status(400).json({
      success: false,
      message: "messages debe contener entre 1 y 50 elementos",
      code: "INVALID_MESSAGES",
      requestId: req.id,
    });
  }
  const lastUserMessage = [...messages].reverse().find(
    (item) => item?.role === "user" && typeof item?.content === "string"
  );
  if (!lastUserMessage?.content.trim() || lastUserMessage.content.length > 2000) {
    return res.status(400).json({
      success: false,
      message: "Se requiere un mensaje de usuario valido de maximo 2000 caracteres",
      code: "INVALID_MESSAGE",
      requestId: req.id,
    });
  }
  try {
    auraChat.normalizeConversationId(conversationId);
  } catch {
    return res.status(400).json({
      success: false,
      message: "conversationId invalido",
      code: "INVALID_CONVERSATION_ID",
      requestId: req.id,
    });
  }
  return next();
};

exports.confirmAction = async (req, res) => {
  const message = "Las acciones automaticas del agente legacy estan deshabilitadas en el MVP seguro. AURA solo entrega recomendaciones y acciones sugeridas pendientes de confirmacion manual fuera del chat.";
  const priorHistory = sanitizeHistory(req.body?.messages || req.body?.history || []);

  return res.status(200).json({
    success: true,
    executed: false,
    needsConfirm: false,
    pendingAction: null,
    message,
    code: "AURA_ACTION_EXECUTION_DISABLED",
    history: [
      ...priorHistory,
      { role: "assistant", content: message },
    ],
    requestId: req.id,
  });
};

exports.listConversations = async (req, res) => {
  try {
    const rows = await listStoredConversations({
      ownerAdminId: req.auraAdminId,
      userId: req.user.id,
    });
    // Preserve the direct array expected by the legacy frontend.
    return res.json(rows);
  } catch (err) {
    return sendAgentError(req, res, err);
  }
};

exports.getConversation = async (req, res) => {
  try {
    const conversation = await getStoredConversation({
      ownerAdminId: req.auraAdminId,
      userId: req.user.id,
      conversationId: auraChat.normalizeConversationId(req.params.id),
    });
    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: "Conversacion no encontrada",
        code: "AURA_CONVERSATION_NOT_FOUND",
        requestId: req.id,
      });
    }
    return res.json({ messages: conversation.messages });
  } catch (err) {
    return sendAgentError(req, res, err);
  }
};

exports.deleteConversation = async (req, res) => {
  try {
    const deleted = await deleteStoredConversation({
      ownerAdminId: req.auraAdminId,
      userId: req.user.id,
      conversationId: auraChat.normalizeConversationId(req.params.id),
    });
    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: "Conversacion no encontrada",
        code: "AURA_CONVERSATION_NOT_FOUND",
        requestId: req.id,
      });
    }
    return res.json({ success: true, requestId: req.id });
  } catch (err) {
    return sendAgentError(req, res, err);
  }
};
