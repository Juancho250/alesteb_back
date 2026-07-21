const db = require("../src/platform/database");

function flag(name) {
  return String(process.env[name] || "false").toLowerCase() === "true";
}

function requireTenant(input) {
  const ownerAdminId = Number(input?.ownerAdminId);
  if (!Number.isInteger(ownerAdminId) || ownerAdminId <= 0) {
    const err = new Error("Contexto tenant AURA requerido");
    err.code = "AURA_OPERATIONS_TENANT_REQUIRED";
    err.status = 500;
    throw err;
  }
  return ownerAdminId;
}

function rowsByKey(rows, key) {
  return Object.fromEntries(rows.map((row) => [row[key], Number(row.count || 0)]));
}

async function getAuraOperationalHealth(input) {
  const ownerAdminId = requireTenant(input);
  const [queue, jobs, runs, predictions, voice] = await Promise.all([
    db.query(
      `SELECT status, COUNT(*)::int AS count,
              MIN(created_at) FILTER (WHERE status IN ('pending', 'sending')) AS oldest_active_at,
              COUNT(*) FILTER (
                WHERE status = 'sending'
                  AND locked_at < NOW() - INTERVAL '15 minutes'
              )::int AS stale_count
       FROM notification_queue
       WHERE owner_admin_id = $1
       GROUP BY status`,
      [ownerAdminId]
    ),
    db.query(
      `SELECT type, status, COUNT(*)::int AS count,
              COUNT(*) FILTER (
                WHERE status = 'running'
                  AND locked_at < NOW() - INTERVAL '30 minutes'
              )::int AS stale_count
       FROM ai_jobs
       WHERE owner_admin_id = $1
       GROUP BY type, status`,
      [ownerAdminId]
    ),
    db.query(
      `SELECT
         COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS runs_24h,
         COUNT(*) FILTER (
           WHERE created_at >= NOW() - INTERVAL '24 hours' AND status = 'failed'
         )::int AS failures_24h,
         COALESCE(SUM(total_tokens) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours'), 0)::bigint AS tokens_24h,
         COALESCE(SUM(estimated_cost) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours'), 0)::numeric AS cost_24h
       FROM aura_runs
       WHERE owner_admin_id = $1`,
      [ownerAdminId]
    ),
    db.query(
      `SELECT MAX(created_at) AS latest_prediction_at,
              COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '48 hours')::int AS fresh_results
       FROM prediction_results
       WHERE owner_admin_id = $1`,
      [ownerAdminId]
    ),
    db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'active' AND expires_at > NOW())::int AS active_sessions,
         COUNT(*) FILTER (WHERE status = 'active' AND expires_at <= NOW())::int AS expired_not_closed
       FROM aura_voice_sessions
       WHERE owner_admin_id = $1`,
      [ownerAdminId]
    ),
  ]);

  const queueRows = queue.rows || [];
  const jobRows = jobs.rows || [];
  const run = runs.rows[0] || {};
  const prediction = predictions.rows[0] || {};
  const voiceRow = voice.rows[0] || {};
  return {
    status: queueRows.some((row) => Number(row.stale_count || 0) > 0)
      || jobRows.some((row) => Number(row.stale_count || 0) > 0)
      ? "degraded"
      : "ok",
    checkedAt: new Date().toISOString(),
    tenantScoped: true,
    flags: {
      legacyAgentCron: flag("ENABLE_LEGACY_AGENT_CRON"),
      notificationWorker: flag("AURA_NOTIFICATION_WORKER_ENABLED"),
      imageWorker: flag("AURA_IMAGE_WORKER_ENABLED"),
      predictiveJobs: flag("AURA_PREDICTIVE_JOBS_ENABLED"),
      forecastWorker: flag("AURA_FORECAST_WORKER_ENABLED"),
      voice: flag("AURA_VOICE_ENABLED"),
    },
    notificationQueue: {
      byStatus: rowsByKey(queueRows, "status"),
      staleClaims: queueRows.reduce((sum, row) => sum + Number(row.stale_count || 0), 0),
      oldestActiveAt: queueRows.map((row) => row.oldest_active_at).filter(Boolean).sort()[0] || null,
    },
    aiJobs: {
      byTypeAndStatus: Object.fromEntries(
        jobRows.map((row) => [`${row.type}:${row.status}`, Number(row.count || 0)])
      ),
      staleClaims: jobRows.reduce((sum, row) => sum + Number(row.stale_count || 0), 0),
    },
    auraRuns: {
      last24Hours: Number(run.runs_24h || 0),
      failuresLast24Hours: Number(run.failures_24h || 0),
      tokensLast24Hours: Number(run.tokens_24h || 0),
      estimatedCostLast24Hours: Number(run.cost_24h || 0),
    },
    predictive: {
      latestPredictionAt: prediction.latest_prediction_at || null,
      freshResults: Number(prediction.fresh_results || 0),
    },
    voice: {
      activeSessions: Number(voiceRow.active_sessions || 0),
      expiredNotClosed: Number(voiceRow.expired_not_closed || 0),
    },
  };
}

module.exports = { getAuraOperationalHealth };
