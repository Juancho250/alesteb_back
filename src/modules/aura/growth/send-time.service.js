const crypto = require("crypto");
const db = require("../../../platform/database");

const SEND_TIME_VERSION = "aura_send_time_v1";
const DIRECT_CHANNELS = new Set(["email", "whatsapp", "push"]);
const DEFAULT_TIMEZONE = "America/Bogota";
const DEFAULT_QUIET_START = "22:00";
const DEFAULT_QUIET_END = "08:00";
const DEFAULT_LOOKBACK_DAYS = 180;

const WEEKDAYS = {
  1: "lunes",
  2: "martes",
  3: "miercoles",
  4: "jueves",
  5: "viernes",
  6: "sabado",
  7: "domingo",
};

const TIME_BUCKETS = [
  { key: "08_10", label: "08:00-10:00", start: 8, end: 10 },
  { key: "10_12", label: "10:00-12:00", start: 10, end: 12 },
  { key: "12_14", label: "12:00-14:00", start: 12, end: 14 },
  { key: "14_16", label: "14:00-16:00", start: 14, end: 16 },
  { key: "16_18", label: "16:00-18:00", start: 16, end: 18 },
  { key: "18_20", label: "18:00-20:00", start: 18, end: 20 },
  { key: "20_22", label: "20:00-22:00", start: 20, end: 22 },
];

function createSendTimeError(message, code = "AURA_SEND_TIME_ERROR", status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function requireCtx(input) {
  if (!input?.ownerAdminId || !input?.userId) {
    throw createSendTimeError("Contexto AURA incompleto", "AURA_SEND_TIME_CONTEXT_REQUIRED", 500);
  }
  return {
    ownerAdminId: Number(input.ownerAdminId),
    userId: Number(input.userId),
    roles: Array.isArray(input.roles) ? input.roles : [],
  };
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value, decimals = 4) {
  const factor = 10 ** decimals;
  return Math.round(numeric(value) * factor) / factor;
}

function toDateOnly(value = new Date(), field = "asOfDate") {
  const raw = value instanceof Date ? value.toISOString().slice(0, 10) : String(value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw createSendTimeError(`${field} debe tener formato YYYY-MM-DD`, "AURA_SEND_TIME_INVALID_DATE", 400);
  }
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    throw createSendTimeError(`${field} no es una fecha valida`, "AURA_SEND_TIME_INVALID_DATE", 400);
  }
  return raw;
}

function boundedInteger(value, fallback, min, max, field) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw createSendTimeError(`${field} debe ser entero entre ${min} y ${max}`, "AURA_SEND_TIME_INVALID_INPUT", 400);
  }
  return parsed;
}

function cleanText(value, field, { max = 120 } = {}) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw createSendTimeError(`${field} debe ser texto`, "AURA_SEND_TIME_INVALID_INPUT", 400);
  }
  const text = value.trim();
  if (!text) return null;
  if (text.length > max) {
    throw createSendTimeError(`${field} no puede superar ${max} caracteres`, "AURA_SEND_TIME_INVALID_INPUT", 400);
  }
  return text;
}

function cleanChannel(value) {
  const channel = cleanText(value, "channel", { max: 30 });
  if (!channel) return null;
  if (!DIRECT_CHANNELS.has(channel)) {
    throw createSendTimeError("channel debe ser email, whatsapp o push", "AURA_SEND_TIME_INVALID_CHANNEL", 400);
  }
  return channel;
}

function configuredMinimumObservations() {
  return boundedInteger(
    process.env.AURA_SEND_TIME_MIN_OBSERVATIONS,
    30,
    5,
    10000,
    "AURA_SEND_TIME_MIN_OBSERVATIONS"
  );
}

function configuredMinimumCampaigns() {
  return boundedInteger(process.env.AURA_SEND_TIME_MIN_CAMPAIGNS, 2, 1, 1000, "AURA_SEND_TIME_MIN_CAMPAIGNS");
}

function configuredLookbackDays() {
  return boundedInteger(process.env.AURA_SEND_TIME_LOOKBACK_DAYS, DEFAULT_LOOKBACK_DAYS, 30, 730, "AURA_SEND_TIME_LOOKBACK_DAYS");
}

function normalizeTimeZone(value) {
  const timezone = value || DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

function parseTimeToMinutes(value, fallback) {
  const raw = String(value || fallback || "00:00").slice(0, 5);
  const match = raw.match(/^(\d{2}):(\d{2})$/);
  if (!match) return parseTimeToMinutes(fallback || "00:00", "00:00");
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return parseTimeToMinutes(fallback || "00:00", "00:00");
  }
  return hours * 60 + minutes;
}

function isMinuteInQuiet(minute, quietStart, quietEnd) {
  if (quietStart === quietEnd) return false;
  if (quietStart < quietEnd) return minute >= quietStart && minute < quietEnd;
  return minute >= quietStart || minute < quietEnd;
}

function slotOverlapsQuiet(bucket, quietStart, quietEnd) {
  const start = bucket.start * 60;
  const end = bucket.end * 60;
  for (let minute = start; minute < end; minute += 30) {
    if (isMinuteInQuiet(minute, quietStart, quietEnd)) return true;
  }
  return false;
}

function bucketByKey(key) {
  return TIME_BUCKETS.find((bucket) => bucket.key === key) || null;
}

function bucketSql() {
  return `CASE
    WHEN local_hour >= 8 AND local_hour < 10 THEN '08_10'
    WHEN local_hour >= 10 AND local_hour < 12 THEN '10_12'
    WHEN local_hour >= 12 AND local_hour < 14 THEN '12_14'
    WHEN local_hour >= 14 AND local_hour < 16 THEN '14_16'
    WHEN local_hour >= 16 AND local_hour < 18 THEN '16_18'
    WHEN local_hour >= 18 AND local_hour < 20 THEN '18_20'
    WHEN local_hour >= 20 AND local_hour < 22 THEN '20_22'
    ELSE 'quiet_or_untracked'
  END`;
}

function confidenceFor({ deliveredCount, campaignCount, minObservations, minCampaigns, score }) {
  if (deliveredCount < minObservations || campaignCount < minCampaigns) return "insuficiente";
  if (deliveredCount >= minObservations * 5 && campaignCount >= minCampaigns + 3 && score >= 0.08) return "alta";
  if (deliveredCount >= minObservations * 2 && campaignCount >= minCampaigns + 1) return "media";
  return "baja";
}

async function getTenantSettings(ownerAdminId) {
  const { rows } = await db.query(
    `SELECT
       ns.timezone AS notification_timezone,
       ns.quiet_hours_start,
       ns.quiet_hours_end,
       ap.timezone AS profile_timezone
     FROM (SELECT $1::int AS admin_id) seed
     LEFT JOIN notification_settings ns ON ns.admin_id = seed.admin_id
     LEFT JOIN admin_profiles ap ON ap.user_id = seed.admin_id
     LIMIT 1`,
    [ownerAdminId]
  );
  const row = rows[0] || {};
  const rawTimezone = row.notification_timezone || row.profile_timezone || DEFAULT_TIMEZONE;
  const timezone = normalizeTimeZone(rawTimezone);
  return {
    timezone,
    timezoneSource: row.notification_timezone ? "notification_settings" : row.profile_timezone ? "admin_profiles" : "default",
    quietHoursStart: String(row.quiet_hours_start || DEFAULT_QUIET_START).slice(0, 5),
    quietHoursEnd: String(row.quiet_hours_end || DEFAULT_QUIET_END).slice(0, 5),
    recipientTimezoneAvailable: false,
  };
}

async function fetchObservedMetrics({ ownerAdminId, asOfDate, timezone, lookbackDays }, client = db) {
  const { rows } = await client.query(
    `WITH raw_events AS (
       SELECT
         ce.owner_admin_id,
         ce.campaign_id,
         COALESCE(ce.recipient_user_id::text, 'cr:' || ce.campaign_recipient_id::text, 'event:' || ce.id::text) AS recipient_key,
         ce.event_type,
         ce.occurred_at
       FROM campaign_events ce
       WHERE ce.owner_admin_id = $1
         AND ce.occurred_at >= ($2::date - ($3::int * INTERVAL '1 day'))
         AND ce.occurred_at < ($2::date + INTERVAL '1 day')
         AND ce.event_type IN ('sent', 'delivered', 'opened', 'read', 'clicked', 'converted')
     ),
     recipient_events AS (
       SELECT
         owner_admin_id,
         campaign_id,
         recipient_key,
         COALESCE(
           MIN(occurred_at) FILTER (WHERE event_type = 'delivered'),
           MIN(occurred_at) FILTER (WHERE event_type = 'sent')
         ) AS delivered_at,
         BOOL_OR(event_type IN ('opened', 'read')) AS was_read,
         BOOL_OR(event_type = 'clicked') AS was_clicked,
         BOOL_OR(event_type = 'converted') AS was_converted
       FROM raw_events
       GROUP BY owner_admin_id, campaign_id, recipient_key
     ),
     local_events AS (
       SELECT
         re.*,
         mc.channel,
         LOWER(COALESCE(NULLIF(mc.objective, ''), 'generic')) AS campaign_type,
         COALESCE(ms.definition->>'type', 'all_customers') AS segment_key,
         EXTRACT(ISODOW FROM timezone($4, re.delivered_at))::int AS day_of_week,
         EXTRACT(HOUR FROM timezone($4, re.delivered_at))::int AS local_hour
       FROM recipient_events re
       JOIN marketing_campaigns mc
         ON mc.id = re.campaign_id
        AND mc.owner_admin_id = re.owner_admin_id
       LEFT JOIN marketing_segments ms
         ON ms.id = mc.segment_id
        AND ms.owner_admin_id = mc.owner_admin_id
       WHERE re.delivered_at IS NOT NULL
         AND mc.channel IN ('email', 'whatsapp', 'push')
     ),
     bucketed AS (
       SELECT
         *,
         ${bucketSql()} AS hour_bucket
       FROM local_events
     ),
     campaign_cells AS (
       SELECT
         owner_admin_id,
         campaign_id,
         channel,
         campaign_type,
         segment_key,
         day_of_week,
         hour_bucket,
         COUNT(*)::int AS delivered_count,
         COUNT(*) FILTER (WHERE was_read)::int AS read_count,
         COUNT(*) FILTER (WHERE was_clicked)::int AS clicked_count,
         COUNT(*) FILTER (WHERE was_converted)::int AS converted_count,
         (COUNT(*) FILTER (WHERE was_read)::numeric / NULLIF(COUNT(*), 0)) AS read_rate,
         (COUNT(*) FILTER (WHERE was_clicked)::numeric / NULLIF(COUNT(*), 0)) AS click_rate,
         (COUNT(*) FILTER (WHERE was_converted)::numeric / NULLIF(COUNT(*), 0)) AS conversion_rate
       FROM bucketed
       WHERE hour_bucket <> 'quiet_or_untracked'
       GROUP BY owner_admin_id, campaign_id, channel, campaign_type, segment_key, day_of_week, hour_bucket
     )
     SELECT
       channel,
       campaign_type,
       segment_key,
       day_of_week,
       hour_bucket,
       COUNT(*)::int AS campaign_count,
       COALESCE(SUM(delivered_count), 0)::int AS delivered_count,
       COALESCE(SUM(read_count), 0)::int AS read_count,
       COALESCE(SUM(clicked_count), 0)::int AS clicked_count,
       COALESCE(SUM(converted_count), 0)::int AS converted_count,
       COALESCE(AVG(read_rate), 0)::numeric AS avg_read_rate,
       COALESCE(AVG(click_rate), 0)::numeric AS avg_click_rate,
       COALESCE(AVG(conversion_rate), 0)::numeric AS avg_conversion_rate
     FROM campaign_cells
     GROUP BY channel, campaign_type, segment_key, day_of_week, hour_bucket
     ORDER BY channel, day_of_week, hour_bucket`,
    [ownerAdminId, asOfDate, lookbackDays, timezone]
  );
  return rows;
}

async function createMetricRun({ ownerAdminId, userId, asOfDate, settings, minObservations, minCampaigns }, client = db) {
  const runId = crypto.randomUUID();
  await client.query(
    `INSERT INTO aura_send_time_metric_runs
       (id, owner_admin_id, as_of_date, metric_version, timezone, timezone_source,
        min_observations, min_campaigns, status, created_by)
     VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,'running',$9)`,
    [
      runId,
      ownerAdminId,
      asOfDate,
      SEND_TIME_VERSION,
      settings.timezone,
      settings.timezoneSource,
      minObservations,
      minCampaigns,
      userId,
    ]
  );

  const metrics = await fetchObservedMetrics({
    ownerAdminId,
    asOfDate,
    timezone: settings.timezone,
    lookbackDays: configuredLookbackDays(),
  }, client);
  let inserted = 0;

  for (const row of metrics) {
    const bucket = bucketByKey(row.hour_bucket);
    if (!bucket) continue;
    const deliveredCount = Number(row.delivered_count || 0);
    const campaignCount = Number(row.campaign_count || 0);
    const avgReadRate = round(row.avg_read_rate, 6);
    const avgClickRate = round(row.avg_click_rate, 6);
    const avgConversionRate = round(row.avg_conversion_rate, 6);
    const score = round(avgReadRate * 0.2 + avgClickRate * 0.45 + avgConversionRate * 0.35, 6);
    const confidence = confidenceFor({
      deliveredCount,
      campaignCount,
      minObservations,
      minCampaigns,
      score,
    });
    const limitations = [
      "Rendimiento observado; no garantiza resultados futuros.",
      "Las tasas se promedian por campana para reducir sesgo por tamanos de audiencia.",
      "No programa ni envia campanas automaticamente.",
    ];
    if (!settings.recipientTimezoneAvailable) {
      limitations.push("No hay zona horaria verificada por destinatario; se usa la zona horaria del tenant.");
    }

    await client.query(
      `INSERT INTO aura_send_time_metric_snapshots
         (run_id, owner_admin_id, as_of_date, metric_version, channel, campaign_type,
          segment_key, day_of_week, hour_bucket, hour_start, hour_end, campaign_count,
          delivered_count, read_count, clicked_count, converted_count, avg_read_rate,
          avg_click_rate, avg_conversion_rate, performance_score, confidence_level,
          evidence, limitations)
       VALUES
         ($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,$23::jsonb)`,
      [
        runId,
        ownerAdminId,
        asOfDate,
        SEND_TIME_VERSION,
        row.channel,
        row.campaign_type || "generic",
        row.segment_key || "all_customers",
        Number(row.day_of_week),
        row.hour_bucket,
        bucket.start,
        bucket.end,
        campaignCount,
        deliveredCount,
        Number(row.read_count || 0),
        Number(row.clicked_count || 0),
        Number(row.converted_count || 0),
        avgReadRate,
        avgClickRate,
        avgConversionRate,
        score,
        confidence,
        JSON.stringify({
          biasControl: "campaign_normalized_rates",
          minObservations,
          minCampaigns,
          lookbackDays: configuredLookbackDays(),
        }),
        JSON.stringify(limitations),
      ]
    );
    inserted++;
  }

  await client.query(
    `UPDATE aura_send_time_metric_runs
     SET status = 'completed',
         rows_count = $2,
         data_quality = $3::jsonb,
         completed_at = NOW()
     WHERE id = $1`,
    [
      runId,
      inserted,
      JSON.stringify({
        source: "campaign_events",
        pageViewsUsed: false,
        recipientTimezoneApplied: settings.recipientTimezoneAvailable,
      }),
    ]
  );

  return { id: runId, rowsCount: inserted, asOfDate, metricVersion: SEND_TIME_VERSION };
}

async function getLatestRun({ ownerAdminId, asOfDate, minObservations, minCampaigns }) {
  const { rows } = await db.query(
    `SELECT *
     FROM aura_send_time_metric_runs
     WHERE owner_admin_id = $1
       AND as_of_date = $2::date
       AND metric_version = $3
       AND min_observations = $4
       AND min_campaigns = $5
       AND status = 'completed'
     ORDER BY completed_at DESC, created_at DESC
     LIMIT 1`,
    [ownerAdminId, asOfDate, SEND_TIME_VERSION, minObservations, minCampaigns]
  );
  return rows[0] || null;
}

async function ensureMetricRun(ctx, query = {}) {
  const asOfDate = toDateOnly(query.asOfDate || new Date());
  const minObservations = configuredMinimumObservations();
  const minCampaigns = configuredMinimumCampaigns();
  const existing = await getLatestRun({ ownerAdminId: ctx.ownerAdminId, asOfDate, minObservations, minCampaigns });
  const settings = await getTenantSettings(ctx.ownerAdminId);
  if (existing) {
    return {
      id: existing.id,
      rowsCount: Number(existing.rows_count || 0),
      asOfDate,
      metricVersion: existing.metric_version,
      settings,
      minObservations,
      minCampaigns,
      reused: true,
    };
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const run = await createMetricRun({
      ownerAdminId: ctx.ownerAdminId,
      userId: ctx.userId,
      asOfDate,
      settings,
      minObservations,
      minCampaigns,
    }, client);
    await client.query("COMMIT");
    return { ...run, settings, minObservations, minCampaigns, reused: false };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function mapSnapshot(row) {
  const bucket = bucketByKey(row.hour_bucket);
  return {
    channel: row.channel,
    campaignType: row.campaign_type,
    segment: row.segment_key,
    dayOfWeek: Number(row.day_of_week),
    dayLabel: WEEKDAYS[Number(row.day_of_week)] || "desconocido",
    hourBucket: row.hour_bucket,
    timeWindow: bucket
      ? { key: bucket.key, label: bucket.label, startHour: bucket.start, endHour: bucket.end }
      : { key: row.hour_bucket, label: row.hour_bucket, startHour: row.hour_start, endHour: row.hour_end },
    sampleSize: Number(row.delivered_count || 0),
    campaignCount: Number(row.campaign_count || 0),
    rates: {
      read: round(row.avg_read_rate, 4),
      click: round(row.avg_click_rate, 4),
      conversion: round(row.avg_conversion_rate, 4),
    },
    counts: {
      delivered: Number(row.delivered_count || 0),
      read: Number(row.read_count || 0),
      clicked: Number(row.clicked_count || 0),
      converted: Number(row.converted_count || 0),
    },
    performanceScore: round(row.performance_score, 4),
    confidence: row.confidence_level,
    limitations: row.limitations || [],
  };
}

async function getCandidateSnapshots({ runId, ownerAdminId, query = {} }) {
  const channel = cleanChannel(query.channel);
  const campaignType = cleanText(query.campaignType, "campaignType", { max: 120 });
  const segment = cleanText(query.segment, "segment", { max: 80 });
  const params = [runId, ownerAdminId];
  const filters = ["run_id = $1", "owner_admin_id = $2"];
  if (channel) {
    params.push(channel);
    filters.push(`channel = $${params.length}`);
  }
  if (campaignType) {
    params.push(campaignType.toLowerCase());
    filters.push(`campaign_type = $${params.length}`);
  }
  if (segment) {
    params.push(segment);
    filters.push(`segment_key = $${params.length}`);
  }
  const { rows } = await db.query(
    `SELECT *
     FROM aura_send_time_metric_snapshots
     WHERE ${filters.join(" AND ")}
     ORDER BY performance_score DESC, delivered_count DESC, campaign_count DESC
     LIMIT 50`,
    params
  );
  return rows.map(mapSnapshot);
}

async function getConsentCounts(ownerAdminId) {
  const { rows } = await db.query(
    `SELECT
       channel,
       COUNT(*) FILTER (WHERE status = 'granted')::int AS granted
     FROM customer_consents
     WHERE owner_admin_id = $1
       AND channel IN ('email', 'whatsapp', 'push')
     GROUP BY channel`,
    [ownerAdminId]
  );
  return Object.fromEntries(rows.map((row) => [row.channel, Number(row.granted || 0)]));
}

function bestNeutralSlot(settings) {
  const quietStart = parseTimeToMinutes(settings.quietHoursStart, DEFAULT_QUIET_START);
  const quietEnd = parseTimeToMinutes(settings.quietHoursEnd, DEFAULT_QUIET_END);
  return TIME_BUCKETS.find((bucket) => !slotOverlapsQuiet(bucket, quietStart, quietEnd)) || TIME_BUCKETS[1];
}

function chooseNeutralChannel(query, consentCounts) {
  const requested = cleanChannel(query.channel);
  if (requested) return requested;
  return ["whatsapp", "email", "push"].sort((a, b) => (consentCounts[b] || 0) - (consentCounts[a] || 0))[0];
}

function quietHoursPayload(settings) {
  return {
    start: settings.quietHoursStart,
    end: settings.quietHoursEnd,
    timezone: settings.timezone,
    timezoneSource: settings.timezoneSource,
  };
}

function neutralRecommendation({ settings, query, consentCounts, run, reason }) {
  const slot = bestNeutralSlot(settings);
  const channel = chooseNeutralChannel(query, consentCounts);
  return {
    mode: "neutral",
    recommended: false,
    recommendedChannel: null,
    neutralFallback: {
      channel,
      dayOfWeek: 2,
      dayLabel: WEEKDAYS[2],
      timeWindow: { key: slot.key, label: slot.label, startHour: slot.start, endHour: slot.end },
    },
    evidence: {
      reason,
      sampleSize: 0,
      campaignCount: 0,
      minObservations: run.minObservations,
      minCampaigns: run.minCampaigns,
      consentedAudienceByChannel: consentCounts,
    },
    confidence: "insuficiente",
    limitations: [
      "Volumen insuficiente para recomendar canal u hora con datos observados.",
      "Fallback neutral: usar una franja diurna permitida y validar consentimiento antes de enviar.",
      "No se programa ninguna campana automaticamente.",
    ],
    quietHours: quietHoursPayload(settings),
    safety: {
      notScheduled: true,
      noAutomaticSend: true,
      consentRequired: true,
    },
  };
}

async function getSendTimeRecommendation(input) {
  const ctx = requireCtx(input);
  const query = input.query || {};
  const run = await ensureMetricRun(ctx, query);
  const settings = run.settings;
  const quietStart = parseTimeToMinutes(settings.quietHoursStart, DEFAULT_QUIET_START);
  const quietEnd = parseTimeToMinutes(settings.quietHoursEnd, DEFAULT_QUIET_END);
  const consentCounts = await getConsentCounts(ctx.ownerAdminId);
  const candidates = await getCandidateSnapshots({
    runId: run.id,
    ownerAdminId: ctx.ownerAdminId,
    query,
  });
  const eligible = candidates.filter((candidate) => {
    const bucket = bucketByKey(candidate.hourBucket);
    return candidate.sampleSize >= run.minObservations
      && candidate.campaignCount >= run.minCampaigns
      && bucket
      && !slotOverlapsQuiet(bucket, quietStart, quietEnd);
  });

  if (!eligible.length) {
    return {
      asOfDate: run.asOfDate,
      version: run.metricVersion,
      runId: run.id,
      ...neutralRecommendation({
        settings,
        query,
        consentCounts,
        run,
        reason: candidates.length
          ? "Hay metricas, pero no superan minimos o chocan con quiet hours."
          : "No hay metricas observadas para los filtros solicitados.",
      }),
    };
  }

  const best = eligible.sort((a, b) => {
    if (a.performanceScore !== b.performanceScore) return b.performanceScore - a.performanceScore;
    if (a.sampleSize !== b.sampleSize) return b.sampleSize - a.sampleSize;
    return b.campaignCount - a.campaignCount;
  })[0];

  return {
    asOfDate: run.asOfDate,
    version: run.metricVersion,
    runId: run.id,
    mode: "observed",
    recommended: true,
    recommendedChannel: best.channel,
    recommendedDay: {
      dayOfWeek: best.dayOfWeek,
      label: best.dayLabel,
    },
    recommendedTimeWindow: {
      ...best.timeWindow,
      timezone: settings.timezone,
    },
    evidence: {
      campaignType: best.campaignType,
      segment: best.segment,
      rates: best.rates,
      counts: best.counts,
      performanceScore: best.performanceScore,
      sampleSize: best.sampleSize,
      campaignCount: best.campaignCount,
      minObservations: run.minObservations,
      minCampaigns: run.minCampaigns,
      biasControl: "Tasas calculadas por campana y luego promediadas para reducir sesgo por tamanos de audiencia.",
      consentedAudienceByChannel: consentCounts,
    },
    sampleSize: best.sampleSize,
    confidence: best.confidence,
    limitations: [
      ...best.limitations,
      "No es una garantia; solo rendimiento observado historico.",
      "La ejecucion sigue requiriendo consentimiento vigente y aprobacion cuando aplique.",
    ],
    quietHours: quietHoursPayload(settings),
    safety: {
      notScheduled: true,
      noAutomaticSend: true,
      consentRequired: true,
    },
  };
}

module.exports = {
  SEND_TIME_VERSION,
  TIME_BUCKETS,
  WEEKDAYS,
  confidenceFor,
  slotOverlapsQuiet,
  ensureMetricRun,
  getSendTimeRecommendation,
};
