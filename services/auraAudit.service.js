const crypto = require("crypto");
const db = require("../config/db");
const { recordAuraUsage, estimateAuraCost } = require("./auraUsage.service");

const SENSITIVE_KEY_RE = /(password|token|secret|api[_-]?key|authorization|cookie|cedula|documento|phone|email)/i;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const TOKEN_RE = /\b(?:sk|ak|pk|Bearer)[A-Za-z0-9_\-]{12,}\b/g;
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/g;

function createAuditError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function boundedString(value, max = 1000) {
  if (value === undefined || value === null) return null;
  const clean = String(value).trim();
  return clean ? clean.slice(0, max) : null;
}

function redactText(value, max = 2000) {
  if (value === undefined || value === null) return null;
  return String(value)
    .replace(EMAIL_RE, "[redacted-email]")
    .replace(TOKEN_RE, "[redacted-secret]")
    .replace(PHONE_RE, "[redacted-phone]")
    .slice(0, max);
}

function redactObject(value, depth = 0) {
  if (depth > 4) return "[redacted-depth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactText(value, 2000);
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactObject(item, depth + 1));

  return Object.fromEntries(
    Object.entries(value).slice(0, 50).map(([key, item]) => [
      key,
      SENSITIVE_KEY_RE.test(key) ? "[redacted]" : redactObject(item, depth + 1),
    ])
  );
}

function normalizeTokens(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function normalizeCost(value, usage = {}) {
  if (value === undefined || value === null || value === "") {
    return estimateAuraCost(usage);
  }
  const parsed = Number(value);
  return Number((Number.isFinite(parsed) && parsed > 0 ? parsed : 0).toFixed(8));
}

async function recordAuraRunStart({
  runId = crypto.randomUUID(),
  requestId,
  ownerAdminId,
  userId,
  conversationId = null,
  model,
  redactedInput,
}) {
  if (!requestId) throw createAuditError("requestId requerido", "AURA_AUDIT_REQUEST_ID_REQUIRED");
  const { rows } = await db.query(
    `INSERT INTO aura_runs
       (id, request_id, owner_admin_id, user_id, conversation_id, provider,
        model, status, redacted_input, structured_output, tools_used,
        created_at)
     VALUES ($1, $2, $3, $4, $5, 'openai', $6, 'running', $7, '{}'::jsonb, '[]'::jsonb, NOW())
     RETURNING id, request_id AS "requestId", owner_admin_id AS "ownerAdminId",
               user_id AS "userId", conversation_id AS "conversationId",
               model, status, created_at AS "createdAt"`,
    [
      runId,
      requestId,
      ownerAdminId,
      userId,
      conversationId,
      boundedString(model, 100),
      JSON.stringify(redactObject(redactedInput || {})),
    ]
  );
  return rows[0];
}

async function recordAuraRunCompletion({
  runId,
  ownerAdminId,
  conversationId = null,
  output,
  toolsUsed = [],
  usage = {},
  estimatedCost,
  latencyMs = 0,
}) {
  const inputTokens = normalizeTokens(usage.inputTokens ?? usage.input_tokens);
  const outputTokens = normalizeTokens(usage.outputTokens ?? usage.output_tokens);
  const totalTokens = normalizeTokens(usage.totalTokens ?? usage.total_tokens ?? inputTokens + outputTokens);
  const cost = normalizeCost(estimatedCost, { inputTokens, outputTokens });

  const { rows } = await db.query(
    `UPDATE aura_runs
     SET status = 'completed',
         conversation_id = COALESCE($1, conversation_id),
         structured_output = $2,
         tools_used = $3,
         input_tokens = $4,
         output_tokens = $5,
         total_tokens = $6,
         estimated_cost = $7,
         estimated_cost_usd = $7,
         latency_ms = $8,
         completed_at = NOW(),
         finished_at = NOW()
     WHERE id = $9
       AND owner_admin_id = $10
       AND completed_at IS NULL
     RETURNING id, status, completed_at AS "completedAt"`,
    [
      conversationId,
      JSON.stringify(redactObject(output || {})),
      JSON.stringify(redactObject(toolsUsed || [])),
      inputTokens,
      outputTokens,
      totalTokens,
      cost,
      normalizeTokens(latencyMs),
      runId,
      ownerAdminId,
    ]
  );

  await recordAuraUsage({
    ownerAdminId,
    inputTokens,
    outputTokens,
    estimatedCost: cost,
    failed: false,
  });

  return rows[0] || null;
}

async function recordAuraRunFailure({
  runId,
  ownerAdminId,
  conversationId = null,
  error,
  toolsUsed = [],
  usage = {},
  estimatedCost,
  latencyMs = 0,
}) {
  const inputTokens = normalizeTokens(usage.inputTokens ?? usage.input_tokens);
  const outputTokens = normalizeTokens(usage.outputTokens ?? usage.output_tokens);
  const totalTokens = normalizeTokens(usage.totalTokens ?? usage.total_tokens ?? inputTokens + outputTokens);
  const cost = normalizeCost(estimatedCost, { inputTokens, outputTokens });
  const errorCode = boundedString(error?.auditCode || error?.code || "AURA_ERROR", 100);
  const errorMessageRedacted = redactText(error?.message || "AURA fallo", 1000);

  const { rows } = await db.query(
    `UPDATE aura_runs
     SET status = 'failed',
         conversation_id = COALESCE($1, conversation_id),
         tools_used = $2,
         input_tokens = $3,
         output_tokens = $4,
         total_tokens = $5,
         estimated_cost = $6,
         estimated_cost_usd = $6,
         latency_ms = $7,
         error_code = $8,
         error_message_redacted = $9,
         error_message = $9,
         completed_at = NOW(),
         finished_at = NOW()
     WHERE id = $10
       AND owner_admin_id = $11
       AND completed_at IS NULL
     RETURNING id, status, completed_at AS "completedAt"`,
    [
      conversationId,
      JSON.stringify(redactObject(toolsUsed || [])),
      inputTokens,
      outputTokens,
      totalTokens,
      cost,
      normalizeTokens(latencyMs),
      errorCode,
      errorMessageRedacted,
      runId,
      ownerAdminId,
    ]
  );

  await recordAuraUsage({
    ownerAdminId,
    inputTokens,
    outputTokens,
    estimatedCost: cost,
    failed: true,
  });

  return rows[0] || null;
}

module.exports = {
  recordAuraRunStart,
  recordAuraRunCompletion,
  recordAuraRunFailure,
  redactText,
  redactObject,
};
