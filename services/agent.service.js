// services/agent.service.js
// DEPRECATED: legacy Groq/ReAct agent. Productive traffic must use the
// /api/agent compatibility adapter, which delegates to safe AURA services.
// This module no longer runs model-generated SQL or text-confirmed actions.

const SAFE_REPLY = "El agente legacy con herramientas SQL esta deshabilitado en el MVP seguro. Usa AURA 2070 para recomendaciones consultivas; las acciones automaticas quedan como sugeridas y requieren revision manual fuera del chat.";

function createLegacyAgentError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function isLegacyAgentSqlEnabled() {
  return process.env.ENABLE_LEGACY_AGENT_SQL === "true"
    && process.env.NODE_ENV !== "production";
}

function normalizeOwnerAdminId(ownerAdminId) {
  const parsed = Number(ownerAdminId);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function sanitizeLegacyMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((message) => ["user", "assistant"].includes(message?.role))
    .map((message) => ({
      role: message.role,
      content: String(message.content || "").slice(0, 2000),
    }))
    .filter((message) => message.content)
    .slice(-12);
}

async function runAgent(messages, options = {}) {
  const ownerAdminId = normalizeOwnerAdminId(options.ownerAdminId);
  if (!ownerAdminId) {
    throw createLegacyAgentError(
      "ownerAdminId explicito requerido para el agente legacy.",
      "LEGACY_AGENT_TENANT_REQUIRED"
    );
  }

  if (!isLegacyAgentSqlEnabled()) {
    throw createLegacyAgentError(
      SAFE_REPLY,
      "LEGACY_AGENT_SQL_DISABLED"
    );
  }

  const history = [
    ...sanitizeLegacyMessages(messages),
    { role: "assistant", content: SAFE_REPLY },
  ];

  return {
    reply: SAFE_REPLY,
    history,
    needsConfirm: false,
    pendingAction: null,
  };
}

module.exports = {
  runAgent,
  isLegacyAgentSqlEnabled,
};
