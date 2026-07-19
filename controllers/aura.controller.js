const auraChat = require("../services/auraChat.service");
const {
  listConversations: listStoredConversations,
  getConversation: getStoredConversation,
  deleteConversation: deleteStoredConversation,
} = require("../services/auraPersistence.service");
const { getAuraUsage } = require("../services/auraUsage.service");

const MAX_MESSAGE_LENGTH = 2000;

function validateMessage(value) {
  if (typeof value !== "string" || !value.trim()) {
    return { message: "message es requerido y debe ser texto", code: "INVALID_MESSAGE" };
  }
  if (value.length > MAX_MESSAGE_LENGTH) {
    return {
      message: `message no puede superar ${MAX_MESSAGE_LENGTH} caracteres`,
      code: "MESSAGE_TOO_LONG",
    };
  }
  return null;
}

function isValidConversationId(value) {
  try {
    auraChat.normalizeConversationId(value);
    return true;
  } catch {
    return false;
  }
}

function normalizePagination(query = {}) {
  const rawLimit = Number.parseInt(query.limit || "50", 10);
  const rawOffset = Number.parseInt(query.offset || "0", 10);
  return {
    limit: Number.isSafeInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 50,
    offset: Number.isSafeInteger(rawOffset) ? Math.min(Math.max(rawOffset, 0), 10_000) : 0,
  };
}

function insightsToArray(insights) {
  if (Array.isArray(insights)) return insights;
  if (!insights || typeof insights !== "object") return [];
  return Object.entries(insights).map(([key, value]) => ({ key, value }));
}

function quotaUsage(req) {
  const usage = req.auraUsage || {};
  return {
    requestsRemaining: Number(usage.requestsRemaining ?? usage.remaining ?? 0),
  };
}

function sendAuraError(req, res, err) {
  if (res.headersSent) return res;
  const known = {
    AURA_OPENAI_MISSING_KEY: [503, "OPENAI_API_KEY no configurada en el servidor"],
    AURA_OPENAI_RATE_LIMIT: [429, "Limite del proveedor de IA alcanzado. Intenta nuevamente mas tarde."],
    AURA_OPENAI_TIMEOUT: [504, "El proveedor de IA tardo demasiado en responder."],
    AURA_OPENAI_ERROR: [502, "El proveedor de IA no pudo procesar la solicitud."],
    AURA_DAILY_QUOTA_EXCEEDED: [429, "Limite diario de consultas AURA alcanzado."],
    AURA_QUOTA_UNAVAILABLE: [503, "No fue posible verificar la cuota de AURA."],
    AURA_CONVERSATION_NOT_FOUND: [404, "Conversacion no encontrada"],
    AURA_NO_SUBSCRIPTION: [403, "Sin suscripcion activa para AURA"],
    AURA_SUBSCRIPTION_INACTIVE: [403, "Suscripcion inactiva para AURA"],
    AURA_FEATURE_LOCKED: [403, "El plan no incluye AURA"],
    AURA_TOOL_LIMIT_EXCEEDED: [502, "AURA excedio el limite seguro de herramientas."],
    AURA_TOOL_LOOP_LIMIT: [502, "AURA excedio el ciclo seguro de herramientas."],
    INVALID_CONVERSATION_ID: [400, "conversationId invalido"],
  };
  const [status, message] = known[err.code] || [500, "Error al procesar la consulta de AURA"];
  return res.status(status).json({
    success: false,
    message,
    code: err.code || "AURA_CHAT_ERROR",
    requestId: req.id,
  });
}

exports.chat = async (req, res) => {
  const { message, conversationId = null } = req.body || {};
  const validationError = validateMessage(message);
  if (validationError) {
    return res.status(400).json({ success: false, ...validationError, requestId: req.id });
  }

  try {
    const result = await auraChat.executeAuraChat({
      ownerAdminId: req.auraAdminId,
      userId: req.user.id,
      roles: req.user.roles || [],
      message: message.trim(),
      conversationId,
      requestId: req.id,
    });

    if (res.headersSent) return res;
    return res.json({
      success: true,
      conversationId: result.conversationId,
      runId: result.runId,
      answer: result.answer || result.reply,
      reply: result.reply || result.answer,
      insights: insightsToArray(result.insights),
      suggestions: result.suggestions || result.suggestedActions || [],
      jobs: Array.isArray(result.jobs) ? result.jobs : [],
      requiresPolling: Boolean(result.requiresPolling),
      usage: quotaUsage(req),
    });
  } catch (err) {
    return sendAuraError(req, res, err);
  }
};

exports.validateChatRequest = (req, res, next) => {
  const { message, conversationId = null } = req.body || {};
  const validationError = validateMessage(message);
  if (validationError) {
    return res.status(400).json({ success: false, ...validationError, requestId: req.id });
  }
  if (!isValidConversationId(conversationId)) {
    return res.status(400).json({
      success: false,
      message: "conversationId invalido",
      code: "INVALID_CONVERSATION_ID",
      requestId: req.id,
    });
  }
  return next();
};

exports.listConversations = async (req, res) => {
  try {
    const rows = await listStoredConversations({
      ownerAdminId: req.auraAdminId,
      userId: req.user.id,
      ...normalizePagination(req.query),
    });
    return res.json({ success: true, data: rows, requestId: req.id });
  } catch (err) {
    return sendAuraError(req, res, err);
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
    return res.json({ success: true, data: conversation, requestId: req.id });
  } catch (err) {
    return sendAuraError(req, res, err);
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
    return sendAuraError(req, res, err);
  }
};

exports.getUsage = async (req, res) => {
  try {
    const usage = await getAuraUsage(req.auraAdminId);
    return res.json({
      success: true,
      data: {
        ...usage,
        dailyLimit: usage.limit,
      },
      requestId: req.id,
    });
  } catch (err) {
    return sendAuraError(req, res, err);
  }
};

exports.validateMessage = validateMessage;
