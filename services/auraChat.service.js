const crypto = require("crypto");
const auraContext = require("./auraContext.service");
const auraOpenAI = require("./auraOpenAI.service");
const {
  getConversation,
  saveConversation,
  sanitizeHistory,
} = require("./auraPersistence.service");
const {
  recordAuraRunStart,
  recordAuraRunCompletion,
  recordAuraRunFailure,
} = require("./auraAudit.service");
const { estimateAuraCost } = require("./auraUsage.service");

function createServiceError(message, code, status = 500) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function normalizeConversationId(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = String(value).trim();
  // Legacy DDL was not versioned: integer, bigint and UUID-like opaque IDs are accepted.
  if (!/^[A-Za-z0-9-]{1,100}$/.test(parsed)) {
    throw createServiceError("conversationId invalido", "INVALID_CONVERSATION_ID", 400);
  }
  return parsed;
}

function logAura(level, event, data = {}) {
  const writer = level === "error" ? console.error : console.log;
  writer(JSON.stringify({ level, event, ...data }));
}

async function loadServerHistory({ ownerAdminId, userId, conversationId }) {
  if (!conversationId) return [];

  const stored = await getConversation({
    ownerAdminId,
    userId,
    conversationId,
  });

  if (!stored) {
    throw createServiceError("Conversacion no encontrada", "AURA_CONVERSATION_NOT_FOUND", 404);
  }

  return sanitizeHistory(stored.messages);
}

async function executeAuraChat({
  ownerAdminId,
  userId,
  roles = [],
  message,
  conversationId,
  requestId,
}) {
  const safeConversationId = normalizeConversationId(conversationId);
  const runId = crypto.randomUUID();
  const startedAt = Date.now();
  const configuredModel = process.env.OPENAI_MODEL || "gpt-5-mini";
  let persistedConversationId = safeConversationId;
  let providerUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let providerCost = 0;

  const conversationHistory = await loadServerHistory({
    ownerAdminId,
    userId,
    conversationId: safeConversationId,
  });

  await recordAuraRunStart({
    runId,
    requestId,
    ownerAdminId,
    userId,
    conversationId: safeConversationId,
    model: configuredModel,
    redactedInput: {
      message,
      conversationId: safeConversationId,
    },
  });

  try {
    const businessContext = await auraContext.getAuraBusinessContext({
      adminId: ownerAdminId,
      // Superadmin must select an explicit tenant before this point.
      isSuperAdmin: false,
    });

    const aura = await auraOpenAI.generateAuraReply({
      message,
      history: conversationHistory,
      businessContext,
      toolContext: {
        ownerAdminId,
        userId,
        roles,
        requestId,
      },
    });
    providerUsage = aura.usage || providerUsage;
    providerCost = estimateAuraCost(providerUsage);

    const nextHistory = sanitizeHistory([
      ...conversationHistory,
      { role: "user", content: message },
      { role: "assistant", content: aura.reply },
    ]);

    persistedConversationId = await saveConversation({
      ownerAdminId,
      userId,
      conversationId: safeConversationId,
      history: nextHistory,
      firstUserMessage: message,
    });

    const latencyMs = Date.now() - startedAt;
    await recordAuraRunCompletion({
      runId,
      ownerAdminId,
      conversationId: persistedConversationId,
      output: {
        answer: aura.reply,
        insights: businessContext.insights,
        suggestions: aura.suggestedActions,
      },
      toolsUsed: aura.toolsUsed || [],
      usage: providerUsage,
      estimatedCost: providerCost,
      latencyMs,
    });

    logAura("info", "aura_run_completed", {
      requestId,
      runId,
      ownerAdminId,
      userId,
      model: aura.model,
      totalTokens: providerUsage.totalTokens,
      latencyMs,
    });

    return {
      runId,
      requestId,
      conversationId: persistedConversationId,
      history: nextHistory,
      answer: aura.reply,
      reply: aura.reply,
      insights: businessContext.insights,
      suggestions: aura.suggestedActions,
      suggestedActions: aura.suggestedActions,
      model: aura.model,
      usage: providerUsage,
    };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    try {
      await recordAuraRunFailure({
        runId,
        ownerAdminId,
        conversationId: persistedConversationId,
        error: err,
        toolsUsed: err.toolsUsed || [],
        usage: providerUsage,
        estimatedCost: providerCost,
        latencyMs,
      });
    } catch (auditErr) {
      logAura("error", "aura_run_audit_failed", {
        requestId,
        runId,
        ownerAdminId,
        userId,
        errorCode: auditErr.code || "DB_ERROR",
      });
    }

    logAura("error", "aura_run_failed", {
      requestId,
      runId,
      ownerAdminId,
      userId,
      errorCode: err.code || "AURA_PROVIDER_ERROR",
      latencyMs,
    });
    throw err;
  }
}

module.exports = {
  executeAuraChat,
  normalizeConversationId,
};
