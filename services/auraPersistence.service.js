const crypto = require("crypto");
const db = require("../config/db");

const DEFAULT_HISTORY_LIMIT = 12;
const DEFAULT_CONTENT_LIMIT = 2_000;
const DEFAULT_CONVERSATION_LIMIT = 50;
const MAX_CONVERSATION_LIMIT = 100;
const DEFAULT_RETENTION_DAYS = 180;
const MAX_RETENTION_DAYS = 730;
const ALLOWED_HISTORY_ROLES = new Set(["user", "assistant"]);
const FINISH_STATUSES = new Set(["completed", "failed", "cancelled"]);

function required(value, field) {
  if (value === undefined || value === null || value === "") {
    throw new TypeError(`${field} is required`);
  }
  return value;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

function boundedString(value, maximum) {
  if (value === undefined || value === null) return "";
  return String(value).trim().slice(0, maximum);
}

function configuredRetentionDays() {
  return boundedInteger(
    process.env.AURA_CONVERSATION_RETENTION_DAYS,
    DEFAULT_RETENTION_DAYS,
    1,
    MAX_RETENTION_DAYS
  );
}

function contentToString(content) {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (typeof item?.text === "string") return item.text;
        if (typeof item?.content === "string") return item.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  if (content === undefined || content === null) return "";

  try {
    return JSON.stringify(content);
  } catch {
    return "";
  }
}

/**
 * Keeps only the recent user/assistant text needed by AURA. It intentionally
 * removes system/tool roles so persisted client input cannot become a system
 * instruction when the conversation is loaded again.
 */
function sanitizeHistory(
  history,
  limit = DEFAULT_HISTORY_LIMIT,
  contentLimit = DEFAULT_CONTENT_LIMIT
) {
  if (!Array.isArray(history)) return [];

  const safeLimit = boundedInteger(limit, DEFAULT_HISTORY_LIMIT, 1, 100);
  const safeContentLimit = boundedInteger(
    contentLimit,
    DEFAULT_CONTENT_LIMIT,
    1,
    10_000
  );

  return history
    .filter((message) => message && ALLOWED_HISTORY_ROLES.has(message.role))
    .map((message) => ({
      role: message.role,
      content: contentToString(message.content).slice(0, safeContentLimit),
    }))
    .filter((message) => message.content.length > 0)
    .slice(-safeLimit);
}

function envRate(name) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Returns an estimated USD cost using per-million-token rates. Both the object
 * form and two numeric arguments are supported to keep this helper easy to test.
 */
function estimateOpenAICost(inputOrUsage = 0, outputArgument = 0) {
  const usage = typeof inputOrUsage === "object" && inputOrUsage !== null
    ? inputOrUsage
    : { inputTokens: inputOrUsage, outputTokens: outputArgument };

  const inputTokens = Math.max(
    0,
    Number(usage.inputTokens ?? usage.input_tokens) || 0
  );
  const outputTokens = Math.max(
    0,
    Number(usage.outputTokens ?? usage.output_tokens) || 0
  );
  const inputRate = envRate("AURA_INPUT_USD_PER_1M");
  const outputRate = envRate("AURA_OUTPUT_USD_PER_1M");
  const cost = ((inputTokens * inputRate) + (outputTokens * outputRate)) / 1_000_000;

  return Number(cost.toFixed(8));
}

function parseMessages(messages) {
  if (typeof messages !== "string") return sanitizeHistory(messages);

  try {
    return sanitizeHistory(JSON.parse(messages));
  } catch {
    return [];
  }
}

function uuidOrNew(value, field) {
  const candidate = value || crypto.randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)) {
    throw new TypeError(`${field} must be a valid UUID`);
  }
  return candidate;
}

async function listConversations({
  ownerAdminId,
  userId,
  limit = DEFAULT_CONVERSATION_LIMIT,
  offset = 0,
}) {
  required(ownerAdminId, "ownerAdminId");
  required(userId, "userId");
  const safeLimit = boundedInteger(
    limit,
    DEFAULT_CONVERSATION_LIMIT,
    1,
    MAX_CONVERSATION_LIMIT
  );
  const safeOffset = boundedInteger(offset, 0, 0, 10_000);
  const retentionDays = configuredRetentionDays();

  const { rows } = await db.query(
    `SELECT id, preview, updated_at
     FROM agent_conversations
     WHERE owner_admin_id = $1
       AND user_id = $2
       AND updated_at >= NOW() - ($5::integer * INTERVAL '1 day')
     ORDER BY updated_at DESC
     LIMIT $3 OFFSET $4`,
    [ownerAdminId, userId, safeLimit, safeOffset, retentionDays]
  );

  return rows;
}

async function getConversation({ ownerAdminId, userId, conversationId }) {
  required(ownerAdminId, "ownerAdminId");
  required(userId, "userId");
  required(conversationId, "conversationId");

  const { rows } = await db.query(
    `SELECT id, preview, messages, updated_at
     FROM agent_conversations
     WHERE id = $1
       AND owner_admin_id = $2
       AND user_id = $3
       AND updated_at >= NOW() - ($4::integer * INTERVAL '1 day')
     LIMIT 1`,
    [conversationId, ownerAdminId, userId, configuredRetentionDays()]
  );

  if (!rows[0]) return null;
  return { ...rows[0], messages: parseMessages(rows[0].messages) };
}

async function saveConversation({
  ownerAdminId,
  userId,
  conversationId = null,
  history,
  firstUserMessage = "",
}) {
  required(ownerAdminId, "ownerAdminId");
  required(userId, "userId");

  const safeHistory = sanitizeHistory(history);
  const firstPersistedUserMessage = safeHistory.find(
    (message) => message.role === "user"
  )?.content;
  const preview = boundedString(
    firstUserMessage || firstPersistedUserMessage || "Consulta",
    80
  ) || "Consulta";
  const messages = JSON.stringify(safeHistory);

  if (conversationId) {
    const { rows } = await db.query(
      `UPDATE agent_conversations
       SET messages = $1,
           updated_at = NOW()
       WHERE id = $2
         AND owner_admin_id = $3
         AND user_id = $4
       RETURNING id`,
      [messages, conversationId, ownerAdminId, userId]
    );

    return rows[0]?.id || null;
  }

  const { rows } = await db.query(
    `INSERT INTO agent_conversations
       (owner_admin_id, user_id, messages, preview, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     RETURNING id`,
    [ownerAdminId, userId, messages, preview]
  );

  return rows[0].id;
}

async function deleteConversation({ ownerAdminId, userId, conversationId }) {
  required(ownerAdminId, "ownerAdminId");
  required(userId, "userId");
  required(conversationId, "conversationId");

  const { rowCount } = await db.query(
    `DELETE FROM agent_conversations
     WHERE id = $1
       AND owner_admin_id = $2
       AND user_id = $3`,
    [conversationId, ownerAdminId, userId]
  );

  return rowCount > 0;
}

function normalizeUsage(row, limit = null, allowed = undefined) {
  const requestsCount = Number(row?.requests_count || 0);
  const normalized = {
    usageDate: row?.usage_date || null,
    requestsCount,
    inputTokens: Number(row?.input_tokens || 0),
    outputTokens: Number(row?.output_tokens || 0),
    totalTokens: Number(row?.total_tokens || 0),
    estimatedCostUsd: Number(row?.estimated_cost_usd || 0),
  };

  if (limit !== null) {
    normalized.limit = limit;
    normalized.remaining = Math.max(0, limit - requestsCount);
  }
  if (allowed !== undefined) normalized.allowed = Boolean(allowed);

  return normalized;
}

/**
 * Atomically consumes one request from today's tenant quota. The WHERE on the
 * conflict update is the concurrency boundary: only requests below the limit
 * receive a row from the reservation CTE.
 */
async function reserveDailyRequest(ownerAdminId, limit) {
  required(ownerAdminId, "ownerAdminId");
  const safeLimit = boundedInteger(limit, 0, 0, 1_000_000);

  const { rows } = await db.query(
    `WITH reservation AS (
       INSERT INTO ai_usage_daily
         (owner_admin_id, usage_date, requests_count, input_tokens,
          output_tokens, total_tokens, estimated_cost_usd, updated_at)
       SELECT $1, CURRENT_DATE, 1, 0, 0, 0, 0, NOW()
       WHERE $2::integer > 0
       ON CONFLICT (owner_admin_id, usage_date)
       DO UPDATE SET
         requests_count = ai_usage_daily.requests_count + 1,
         updated_at = NOW()
       WHERE ai_usage_daily.requests_count < $2::integer
       RETURNING usage_date, requests_count, input_tokens, output_tokens,
                 total_tokens, estimated_cost_usd
     )
     SELECT TRUE AS allowed, reservation.*
     FROM reservation
     UNION ALL
     SELECT FALSE AS allowed,
            usage.usage_date,
            usage.requests_count,
            usage.input_tokens,
            usage.output_tokens,
            usage.total_tokens,
            usage.estimated_cost_usd
     FROM ai_usage_daily usage
     WHERE usage.owner_admin_id = $1
       AND usage.usage_date = CURRENT_DATE
       AND NOT EXISTS (SELECT 1 FROM reservation)
     LIMIT 1`,
    [ownerAdminId, safeLimit]
  );

  return normalizeUsage(rows[0], safeLimit, rows[0]?.allowed || false);
}

async function recordRunStart({
  runId,
  requestId,
  ownerAdminId,
  userId,
  conversationId = null,
  provider,
  model,
}) {
  required(ownerAdminId, "ownerAdminId");
  required(userId, "userId");

  const safeRunId = uuidOrNew(runId, "runId");
  const safeRequestId = uuidOrNew(requestId, "requestId");
  const safeProvider = boundedString(required(provider, "provider"), 50);
  const safeModel = boundedString(required(model, "model"), 100);
  const safeConversationId = conversationId === null
    ? null
    : boundedString(conversationId, 100) || null;
  if (!safeProvider) throw new TypeError("provider is required");
  if (!safeModel) throw new TypeError("model is required");

  const { rows } = await db.query(
    `INSERT INTO aura_runs
       (id, request_id, owner_admin_id, user_id, conversation_id,
        provider, model, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'running', NOW())
     RETURNING id,
               request_id AS "requestId",
               owner_admin_id AS "ownerAdminId",
               user_id AS "userId",
               conversation_id AS "conversationId",
               provider,
               model,
               status,
               created_at AS "createdAt"`,
    [
      safeRunId,
      safeRequestId,
      ownerAdminId,
      userId,
      safeConversationId,
      safeProvider,
      safeModel,
    ]
  );

  return rows[0];
}

function normalizeTokens(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function normalizeCost(value, inputTokens, outputTokens) {
  if (value === undefined || value === null || value === "") {
    return estimateOpenAICost({ inputTokens, outputTokens });
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new TypeError("estimatedCostUsd must be a non-negative number");
  }
  return Number(parsed.toFixed(8));
}

async function recordRunFinish({
  runId,
  ownerAdminId,
  conversationId,
  status = "completed",
  inputTokens = 0,
  outputTokens = 0,
  totalTokens,
  estimatedCostUsd,
  latencyMs = 0,
  error = null,
  errorCode = null,
  errorMessage = null,
}) {
  required(ownerAdminId, "ownerAdminId");
  const safeRunId = uuidOrNew(required(runId, "runId"), "runId");
  const safeConversationId = conversationId === undefined || conversationId === null
    ? null
    : boundedString(conversationId, 100) || null;
  if (!FINISH_STATUSES.has(status)) {
    throw new TypeError("status must be completed, failed or cancelled");
  }

  const safeInputTokens = normalizeTokens(inputTokens);
  const safeOutputTokens = normalizeTokens(outputTokens);
  const calculatedTotal = safeInputTokens + safeOutputTokens;
  const safeTotalTokens = totalTokens === undefined || totalTokens === null
    ? calculatedTotal
    : normalizeTokens(totalTokens);
  const safeCost = normalizeCost(
    estimatedCostUsd,
    safeInputTokens,
    safeOutputTokens
  );
  const safeLatencyMs = normalizeTokens(latencyMs);
  const safeErrorCode = boundedString(errorCode || error?.code, 100) || null;
  const safeErrorMessage = boundedString(
    errorMessage || error?.message || (typeof error === "string" ? error : ""),
    1_000
  ) || null;

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `UPDATE aura_runs
       SET status = $1,
           input_tokens = $2,
           output_tokens = $3,
           total_tokens = $4,
           estimated_cost_usd = $5,
           latency_ms = $6,
           error_code = $7,
           error_message = $8,
           conversation_id = COALESCE($9, conversation_id),
           finished_at = NOW()
       WHERE id = $10
         AND owner_admin_id = $11
         AND finished_at IS NULL
       RETURNING id,
                 request_id AS "requestId",
                 owner_admin_id AS "ownerAdminId",
                 status,
                 input_tokens AS "inputTokens",
                 output_tokens AS "outputTokens",
                 total_tokens AS "totalTokens",
                 estimated_cost_usd AS "estimatedCostUsd",
                 latency_ms AS "latencyMs",
                 error_code AS "errorCode",
                 error_message AS "errorMessage",
                 created_at::date AS usage_date,
                 finished_at AS "finishedAt"`,
      [
        status,
        safeInputTokens,
        safeOutputTokens,
        safeTotalTokens,
        safeCost,
        safeLatencyMs,
        safeErrorCode,
        safeErrorMessage,
        safeConversationId,
        safeRunId,
        ownerAdminId,
      ]
    );

    if (!rows[0]) {
      const existing = await client.query(
        `SELECT id,
                request_id AS "requestId",
                owner_admin_id AS "ownerAdminId",
                status,
                input_tokens AS "inputTokens",
                output_tokens AS "outputTokens",
                total_tokens AS "totalTokens",
                estimated_cost_usd AS "estimatedCostUsd",
                latency_ms AS "latencyMs",
                error_code AS "errorCode",
                error_message AS "errorMessage",
                finished_at AS "finishedAt"
         FROM aura_runs
         WHERE id = $1 AND owner_admin_id = $2
         LIMIT 1`,
        [safeRunId, ownerAdminId]
      );
      await client.query("COMMIT");
      return existing.rows[0]
        ? { ...existing.rows[0], alreadyFinished: true }
        : null;
    }

    await client.query(
      `INSERT INTO ai_usage_daily
         (owner_admin_id, usage_date, requests_count, input_tokens,
          output_tokens, total_tokens, estimated_cost_usd, updated_at)
       VALUES ($1, $2, 1, $3, $4, $5, $6, NOW())
       ON CONFLICT (owner_admin_id, usage_date)
       DO UPDATE SET
         input_tokens = ai_usage_daily.input_tokens + EXCLUDED.input_tokens,
         output_tokens = ai_usage_daily.output_tokens + EXCLUDED.output_tokens,
         total_tokens = ai_usage_daily.total_tokens + EXCLUDED.total_tokens,
         estimated_cost_usd = ai_usage_daily.estimated_cost_usd
           + EXCLUDED.estimated_cost_usd,
         updated_at = NOW()`,
      [
        ownerAdminId,
        rows[0].usage_date,
        safeInputTokens,
        safeOutputTokens,
        safeTotalTokens,
        safeCost,
      ]
    );

    await client.query("COMMIT");
    const { usage_date: _usageDate, ...run } = rows[0];
    return run;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function getUsage(ownerAdminId) {
  required(ownerAdminId, "ownerAdminId");

  const { rows } = await db.query(
    `SELECT usage_date,
            requests_count,
            input_tokens,
            output_tokens,
            total_tokens,
            estimated_cost_usd
     FROM ai_usage_daily
     WHERE owner_admin_id = $1
       AND usage_date = CURRENT_DATE
     LIMIT 1`,
    [ownerAdminId]
  );

  return normalizeUsage(rows[0]);
}

module.exports = {
  listConversations,
  getConversation,
  saveConversation,
  deleteConversation,
  reserveDailyRequest,
  recordRunStart,
  recordRunFinish,
  getUsage,
  sanitizeHistory,
  estimateOpenAICost,
};
