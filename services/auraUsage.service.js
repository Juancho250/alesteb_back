const db = require("../config/db");

const ACTIVE_STATUSES = new Set(["trial", "active", "past_due"]);
const DEFAULT_DAILY_LIMIT = 100;

function createUsageError(message, code, status = 500) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

function normalizeLimit(value) {
  return boundedInteger(value, DEFAULT_DAILY_LIMIT, 1, 1_000_000);
}

function getConfiguredDailyLimit() {
  return normalizeLimit(process.env.AURA_DAILY_REQUEST_LIMIT || DEFAULT_DAILY_LIMIT);
}

function envRate(name) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function estimateAuraCost(inputOrUsage = 0, outputArgument = 0) {
  const usage = typeof inputOrUsage === "object" && inputOrUsage !== null
    ? inputOrUsage
    : { inputTokens: inputOrUsage, outputTokens: outputArgument };
  const inputTokens = Math.max(0, Number(usage.inputTokens ?? usage.input_tokens) || 0);
  const outputTokens = Math.max(0, Number(usage.outputTokens ?? usage.output_tokens) || 0);
  const inputRate = envRate("AURA_INPUT_USD_PER_1M");
  const outputRate = envRate("AURA_OUTPUT_USD_PER_1M");
  return Number((((inputTokens * inputRate) + (outputTokens * outputRate)) / 1_000_000).toFixed(8));
}

function normalizeUsage(row, limit = getConfiguredDailyLimit(), allowed = undefined) {
  const requests = Number(row?.requests ?? row?.requests_count ?? 0);
  const normalized = {
    usageDate: row?.usage_date || null,
    requests,
    requestsCount: requests,
    inputTokens: Number(row?.input_tokens || 0),
    outputTokens: Number(row?.output_tokens || 0),
    totalTokens: Number(row?.total_tokens || 0),
    estimatedCost: Number(row?.estimated_cost ?? row?.estimated_cost_usd ?? 0),
    errors: Number(row?.errors || 0),
    limit,
    requestsRemaining: Math.max(0, limit - requests),
    remaining: Math.max(0, limit - requests),
  };
  if (allowed !== undefined) normalized.allowed = Boolean(allowed);
  return normalized;
}

async function getAuraQuotaLimit(ownerAdminId) {
  const limit = getConfiguredDailyLimit();
  const { rows } = await db.query(
    `SELECT s.status, sp.has_ai_agent
     FROM subscriptions s
     JOIN subscription_plans sp ON sp.id = s.plan_id
     WHERE s.admin_id = $1
     LIMIT 1`,
    [ownerAdminId]
  );

  const sub = rows[0];
  if (!sub) {
    throw createUsageError("Sin suscripcion activa para AURA", "AURA_NO_SUBSCRIPTION", 403);
  }
  if (!ACTIVE_STATUSES.has(sub.status)) {
    throw createUsageError("Suscripcion inactiva para AURA", "AURA_SUBSCRIPTION_INACTIVE", 403);
  }
  if (!sub.has_ai_agent) {
    throw createUsageError("El plan no incluye AURA", "AURA_FEATURE_LOCKED", 403);
  }

  return { limit, subscriptionStatus: sub.status };
}

async function reserveAuraRequest(ownerAdminId, limit = getConfiguredDailyLimit()) {
  const safeLimit = normalizeLimit(limit);
  const { rows } = await db.query(
    `WITH reservation AS (
       INSERT INTO ai_usage_daily
         (owner_admin_id, usage_date, requests, requests_count, input_tokens,
          output_tokens, total_tokens, estimated_cost, estimated_cost_usd,
          errors, created_at, updated_at, last_request_at)
       SELECT $1, CURRENT_DATE, 1, 1, 0, 0, 0, 0, 0, 0, NOW(), NOW(), NOW()
       WHERE $2::integer > 0
       ON CONFLICT (owner_admin_id, usage_date)
       DO UPDATE SET
         requests = ai_usage_daily.requests + 1,
         requests_count = ai_usage_daily.requests_count + 1,
         updated_at = NOW(),
         last_request_at = NOW()
       WHERE ai_usage_daily.requests < $2::integer
       RETURNING usage_date, requests, requests_count, input_tokens, output_tokens,
                 total_tokens, estimated_cost, estimated_cost_usd, errors
     )
     SELECT TRUE AS allowed, reservation.*
     FROM reservation
     UNION ALL
     SELECT FALSE AS allowed,
            usage.usage_date,
            usage.requests,
            usage.requests_count,
            usage.input_tokens,
            usage.output_tokens,
            usage.total_tokens,
            usage.estimated_cost,
            usage.estimated_cost_usd,
            usage.errors
     FROM ai_usage_daily usage
     WHERE usage.owner_admin_id = $1
       AND usage.usage_date = CURRENT_DATE
       AND NOT EXISTS (SELECT 1 FROM reservation)
     LIMIT 1`,
    [ownerAdminId, safeLimit]
  );

  return normalizeUsage(rows[0], safeLimit, rows[0]?.allowed || false);
}

async function recordAuraUsage({
  ownerAdminId,
  inputTokens = 0,
  outputTokens = 0,
  estimatedCost = 0,
  failed = false,
}) {
  const safeInputTokens = Math.max(0, Math.floor(Number(inputTokens) || 0));
  const safeOutputTokens = Math.max(0, Math.floor(Number(outputTokens) || 0));
  const safeTotalTokens = safeInputTokens + safeOutputTokens;
  const safeCost = Number(Math.max(0, Number(estimatedCost) || 0).toFixed(8));
  const { rows } = await db.query(
    `INSERT INTO ai_usage_daily
       (owner_admin_id, usage_date, requests, requests_count, input_tokens,
        output_tokens, total_tokens, estimated_cost, estimated_cost_usd,
        errors, created_at, updated_at)
     VALUES ($1, CURRENT_DATE, 0, 0, $2, $3, $4, $5, $5, $6, NOW(), NOW())
     ON CONFLICT (owner_admin_id, usage_date)
     DO UPDATE SET
       input_tokens = ai_usage_daily.input_tokens + EXCLUDED.input_tokens,
       output_tokens = ai_usage_daily.output_tokens + EXCLUDED.output_tokens,
       total_tokens = ai_usage_daily.total_tokens + EXCLUDED.total_tokens,
       estimated_cost = ai_usage_daily.estimated_cost + EXCLUDED.estimated_cost,
       estimated_cost_usd = ai_usage_daily.estimated_cost_usd + EXCLUDED.estimated_cost_usd,
       errors = ai_usage_daily.errors + EXCLUDED.errors,
       updated_at = NOW()
     RETURNING usage_date, requests, requests_count, input_tokens, output_tokens,
               total_tokens, estimated_cost, estimated_cost_usd, errors`,
    [ownerAdminId, safeInputTokens, safeOutputTokens, safeTotalTokens, safeCost, failed ? 1 : 0]
  );

  return normalizeUsage(rows[0]);
}

async function getAuraUsage(ownerAdminId, limit = getConfiguredDailyLimit()) {
  const { rows } = await db.query(
    `SELECT usage_date, requests, requests_count, input_tokens, output_tokens,
            total_tokens, estimated_cost, estimated_cost_usd, errors
     FROM ai_usage_daily
     WHERE owner_admin_id = $1
       AND usage_date = CURRENT_DATE
     LIMIT 1`,
    [ownerAdminId]
  );
  return normalizeUsage(rows[0], normalizeLimit(limit));
}

module.exports = {
  getAuraQuotaLimit,
  reserveAuraRequest,
  recordAuraUsage,
  getAuraUsage,
  estimateAuraCost,
  normalizeUsage,
  getConfiguredDailyLimit,
};
