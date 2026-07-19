const crypto = require("crypto");
const db = require("../config/db");

const CUSTOMER_GROWTH_VERSION = "aura_customer_growth_v1";
const MAX_DETAIL_LIMIT = 100;
const MAX_TOOL_EXAMPLES = 8;

const PAID_VALID_SALES_SQL = `
  s.payment_status = 'paid'
  AND LOWER(COALESCE(s.payment_status::text, '')) NOT IN ('cancelled', 'canceled', 'anulado', 'annulled', 'void')
  AND LOWER(COALESCE(s.delivery_status::text, '')) NOT IN ('cancelled', 'canceled')
`;

const SEGMENT_LABELS = {
  campeones: "Campeones",
  leales: "Leales",
  nuevos: "Nuevos",
  potencialmente_leales: "Potencialmente leales",
  requieren_atencion: "Requieren atencion",
  en_riesgo: "En riesgo",
  dormidos: "Dormidos",
};

function createCustomerGrowthError(message, code = "AURA_CUSTOMER_GROWTH_ERROR", status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function requireCtx(input) {
  if (!input?.ownerAdminId || !input?.userId) {
    throw createCustomerGrowthError("Contexto AURA incompleto", "AURA_CUSTOMER_GROWTH_CONTEXT_REQUIRED", 500);
  }
  return {
    ownerAdminId: Number(input.ownerAdminId),
    userId: Number(input.userId),
    roles: Array.isArray(input.roles) ? input.roles : [],
  };
}

function isHighPermission(roles = []) {
  return roles.includes("admin") || roles.includes("superadmin");
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(numeric(value) * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(Math.max(numeric(value), min), max);
}

function toDateOnly(value = new Date(), field = "asOfDate") {
  const raw = value instanceof Date ? value.toISOString().slice(0, 10) : String(value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw createCustomerGrowthError(`${field} debe tener formato YYYY-MM-DD`, "AURA_CUSTOMER_GROWTH_INVALID_DATE", 400);
  }
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    throw createCustomerGrowthError(`${field} no es una fecha valida`, "AURA_CUSTOMER_GROWTH_INVALID_DATE", 400);
  }
  return raw;
}

function daysBetween(from, to) {
  const start = new Date(`${toDateOnly(from, "from")}T00:00:00.000Z`).getTime();
  const end = new Date(`${toDateOnly(to, "to")}T00:00:00.000Z`).getTime();
  return Math.max(0, Math.round((end - start) / 86_400_000));
}

function boundedInteger(value, fallback, min, max, field) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw createCustomerGrowthError(`${field} debe ser entero entre ${min} y ${max}`, "AURA_CUSTOMER_GROWTH_INVALID_INPUT", 400);
  }
  return parsed;
}

function optionalEnum(value, allowed, field) {
  if (value === undefined || value === null || value === "") return null;
  if (!allowed.has(value)) {
    throw createCustomerGrowthError(`${field} invalido`, "AURA_CUSTOMER_GROWTH_INVALID_INPUT", 400);
  }
  return value;
}

function percentileScore(value, values, higherIsBetter = true) {
  const clean = values.map(numeric).filter((item) => Number.isFinite(item));
  if (clean.length <= 1) return 3;
  const sorted = [...clean].sort((a, b) => a - b);
  const less = sorted.filter((item) => item < numeric(value)).length;
  const percentile = less / Math.max(sorted.length - 1, 1);
  const ascendingScore = clamp(Math.floor(percentile * 4) + 1, 1, 5);
  return higherIsBetter ? ascendingScore : 6 - ascendingScore;
}

function trendLabel(row) {
  const recent = numeric(row.recent_90_count);
  const previous = numeric(row.previous_90_count);
  if (recent === 0 && previous === 0) return "sin_movimiento";
  if (recent >= previous * 1.25 && recent > 0) return "creciente";
  if (recent <= previous * 0.75 && previous > 0) return "decreciente";
  return "estable";
}

function classifySegment({ recencyDays, frequency, recencyScore, frequencyScore, monetaryScore, habitualDays }) {
  const overdue = habitualDays ? recencyDays - habitualDays : null;
  if (frequency === 1 && recencyDays <= 30) return "nuevos";
  if (recencyDays >= 180 || recencyScore <= 1) return "dormidos";
  if (frequency >= 2 && ((habitualDays && overdue > habitualDays * 0.75) || recencyDays >= 90)) return "en_riesgo";
  if (recencyScore >= 4 && frequencyScore >= 4 && monetaryScore >= 4) return "campeones";
  if (recencyScore >= 3 && frequencyScore >= 4) return "leales";
  if (recencyScore >= 4 && frequencyScore <= 3) return "potencialmente_leales";
  if (recencyScore <= 2 && frequencyScore >= 3) return "requieren_atencion";
  return "potencialmente_leales";
}

function churnLevel(score, frequency) {
  if (frequency <= 0) return "insuficiente";
  if (score >= 85) return "critico";
  if (score >= 65) return "alto";
  if (score >= 35) return "medio";
  return "bajo";
}

function repurchaseLevel(score, frequency) {
  if (frequency <= 0) return "insuficiente";
  if (score >= 70) return "alta";
  if (score >= 40) return "media";
  return "baja";
}

function scoreCustomerGrowth(row, scoreContext) {
  const asOfDate = toDateOnly(scoreContext.asOfDate);
  const frequency = Number(row.frequency || 0);
  const monetary = numeric(row.monetary);
  const recencyDays = daysBetween(row.last_purchase_at, asOfDate);
  const habitualDays = row.habitual_repurchase_days === null || row.habitual_repurchase_days === undefined
    ? null
    : round(row.habitual_repurchase_days);
  const recencyScore = percentileScore(recencyDays, scoreContext.recencies, false);
  const frequencyScore = percentileScore(frequency, scoreContext.frequencies, true);
  const monetaryScore = percentileScore(monetary, scoreContext.monetaries, true);
  const rfmScore = round(recencyScore * 100 + frequencyScore * 10 + monetaryScore, 0);
  const trend = trendLabel(row);
  const trendPressure = trend === "decreciente" ? 1 : trend === "sin_movimiento" ? 0.75 : trend === "estable" ? 0.35 : 0;
  const recencyPressure = habitualDays
    ? clamp(recencyDays / Math.max(habitualDays * 2, 1), 0, 1)
    : clamp(recencyDays / 120, 0, 1);
  const frequencyProtection = 1 - clamp(frequency / 5, 0, 1);
  let churnScore = round((recencyPressure * 0.55 + trendPressure * 0.25 + frequencyProtection * 0.2) * 100);
  if (frequency === 1 && recencyDays <= 30) churnScore = Math.min(churnScore, 25);

  const recencyFit = habitualDays
    ? clamp(1 - Math.max(0, recencyDays - habitualDays) / Math.max(habitualDays, 1), 0, 1)
    : recencyDays <= 30 ? 0.6 : clamp(1 - recencyDays / 180, 0, 1);
  const repurchaseScore = round((
    recencyFit * 0.45
    + clamp(frequency / 5, 0, 1) * 0.3
    + (monetaryScore / 5) * 0.25
  ) * 100);
  const segmentKey = classifySegment({
    recencyDays,
    frequency,
    recencyScore,
    frequencyScore,
    monetaryScore,
    habitualDays,
  });
  const daysOverdue = habitualDays === null ? null : round(recencyDays - habitualDays);
  const limitations = [
    "Score heuristico explicable; no es probabilidad calibrada.",
    "No usa page_views ni comportamiento web.",
    "No autoriza contactos sin consentimiento vigente.",
  ];
  if (frequency < 2) limitations.push("Historial insuficiente para calcular intervalo habitual de recompra.");
  if (!row.primary_product_id) limitations.push("Sin producto dominante verificado en el historial.");

  const factors = [
    `Recencia: ${recencyDays} dias desde la ultima compra.`,
    `Frecuencia historica: ${frequency} compra${frequency === 1 ? "" : "s"}.`,
    `Valor monetario acumulado: COP ${Math.round(monetary)}.`,
    `Tendencia reciente: ${trend}.`,
  ];
  if (habitualDays !== null) {
    factors.push(`Intervalo habitual estimado: ${habitualDays} dias.`);
  }

  return {
    customerId: Number(row.customer_id),
    asOfDate,
    segmentVersion: CUSTOMER_GROWTH_VERSION,
    segmentKey,
    segmentLabel: SEGMENT_LABELS[segmentKey],
    recencyDays,
    frequency,
    monetary: round(monetary),
    recencyScore,
    frequencyScore,
    monetaryScore,
    rfmScore,
    habitualRepurchaseDays: habitualDays,
    daysOverdue,
    churnScore,
    churnLevel: churnLevel(churnScore, frequency),
    repurchaseScore,
    repurchaseLevel: repurchaseLevel(repurchaseScore, frequency),
    trendLabel: trend,
    primaryProductId: row.primary_product_id ? Number(row.primary_product_id) : null,
    primaryCategoryId: row.primary_category_id ? Number(row.primary_category_id) : null,
    factors,
    dataUsed: {
      firstPurchaseAt: row.first_purchase_at,
      lastPurchaseAt: row.last_purchase_at,
      recent90Purchases: Number(row.recent_90_count || 0),
      previous90Purchases: Number(row.previous_90_count || 0),
      paidNonCancelledSalesOnly: true,
    },
    limitations,
    consentSummary: row.consent_summary || {},
    exampleKey: anonymizeCustomer(row.customer_id, row.owner_admin_id || scoreContext.ownerAdminId),
  };
}

function anonymizeCustomer(customerId, ownerAdminId) {
  return `anon-${crypto
    .createHash("sha256")
    .update(`${ownerAdminId}:${customerId}:${CUSTOMER_GROWTH_VERSION}`)
    .digest("hex")
    .slice(0, 12)}`;
}

async function fetchCustomerInputs(client, ownerAdminId, asOfDate) {
  const { rows } = await client.query(
    `WITH valid_sales AS (
       SELECT
         s.id,
         s.customer_id,
         s.sale_date::date AS sale_date,
         COALESCE(s.total, 0) AS total
       FROM sales s
       JOIN users u ON u.id = s.customer_id
        AND u.owner_admin_id = $1
       WHERE s.owner_admin_id = $1
         AND s.customer_id IS NOT NULL
         AND s.sale_date::date <= $2::date
         AND ${PAID_VALID_SALES_SQL}
         AND COALESCE(u.is_active, true) = true
         AND EXISTS (
           SELECT 1
           FROM user_roles ur
           JOIN roles r ON r.id = ur.role_id
           WHERE ur.user_id = u.id
             AND r.name = 'user'
         )
     ),
     intervals AS (
       SELECT
         customer_id,
         sale_date - LAG(sale_date) OVER (PARTITION BY customer_id ORDER BY sale_date) AS days_between
       FROM valid_sales
     ),
     interval_summary AS (
       SELECT
         customer_id,
         AVG(days_between)::numeric(8, 2) AS habitual_repurchase_days
       FROM intervals
       WHERE days_between IS NOT NULL
         AND days_between > 0
       GROUP BY customer_id
     ),
     customer_sales AS (
       SELECT
         vs.customer_id,
         MIN(vs.sale_date) AS first_purchase_at,
         MAX(vs.sale_date) AS last_purchase_at,
         COUNT(*)::int AS frequency,
         COALESCE(SUM(vs.total), 0)::numeric(14, 2) AS monetary,
         COUNT(*) FILTER (WHERE vs.sale_date > $2::date - INTERVAL '90 days')::int AS recent_90_count,
         COUNT(*) FILTER (
           WHERE vs.sale_date <= $2::date - INTERVAL '90 days'
             AND vs.sale_date > $2::date - INTERVAL '180 days'
         )::int AS previous_90_count
       FROM valid_sales vs
       GROUP BY vs.customer_id
     ),
     primary_products AS (
       SELECT DISTINCT ON (vs.customer_id)
         vs.customer_id,
         si.product_id AS primary_product_id,
         p.category_id AS primary_category_id
       FROM valid_sales vs
       JOIN sale_items si ON si.sale_id = vs.id
       LEFT JOIN products p ON p.id = si.product_id
        AND p.owner_admin_id = $1
       GROUP BY vs.customer_id, si.product_id, p.category_id
       ORDER BY vs.customer_id, SUM(COALESCE(si.quantity, 0)) DESC, si.product_id ASC
     ),
     consent AS (
       SELECT
         cc.user_id,
         jsonb_object_agg(cc.channel, cc.status) AS consent_summary
       FROM customer_consents cc
       WHERE cc.owner_admin_id = $1
       GROUP BY cc.user_id
     )
     SELECT
       cs.*,
       $1::int AS owner_admin_id,
       isumm.habitual_repurchase_days,
       pp.primary_product_id,
       pp.primary_category_id,
       COALESCE(consent.consent_summary, '{}'::jsonb) AS consent_summary
     FROM customer_sales cs
     LEFT JOIN interval_summary isumm ON isumm.customer_id = cs.customer_id
     LEFT JOIN primary_products pp ON pp.customer_id = cs.customer_id
     LEFT JOIN consent ON consent.user_id = cs.customer_id
     ORDER BY cs.customer_id ASC`,
    [ownerAdminId, asOfDate]
  );
  return rows;
}

async function createSnapshotRun({ ownerAdminId, userId, asOfDate }, client) {
  const runId = crypto.randomUUID();
  await client.query(
    `INSERT INTO aura_customer_segment_runs
       (id, owner_admin_id, as_of_date, segment_version, status, created_by)
     VALUES ($1, $2, $3::date, $4, 'running', $5)`,
    [runId, ownerAdminId, asOfDate, CUSTOMER_GROWTH_VERSION, userId]
  );

  const inputRows = await fetchCustomerInputs(client, ownerAdminId, asOfDate);
  const scoreContext = {
    ownerAdminId,
    asOfDate,
    recencies: inputRows.map((row) => daysBetween(row.last_purchase_at, asOfDate)),
    frequencies: inputRows.map((row) => Number(row.frequency || 0)),
    monetaries: inputRows.map((row) => numeric(row.monetary)),
  };
  const scored = inputRows.map((row) => scoreCustomerGrowth(row, scoreContext));

  for (const item of scored) {
    await client.query(
      `INSERT INTO aura_customer_segment_snapshots
         (run_id, owner_admin_id, customer_id, as_of_date, segment_version,
          segment_key, segment_label, recency_days, frequency, monetary,
          recency_score, frequency_score, monetary_score, rfm_score,
          habitual_repurchase_days, days_overdue, churn_score, churn_level,
          repurchase_score, repurchase_level, trend_label, primary_product_id,
          primary_category_id, factors, data_used, limitations, consent_summary, example_key)
       VALUES
         ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24::jsonb,$25::jsonb,$26::jsonb,$27::jsonb,$28)`,
      [
        runId,
        ownerAdminId,
        item.customerId,
        asOfDate,
        item.segmentVersion,
        item.segmentKey,
        item.segmentLabel,
        item.recencyDays,
        item.frequency,
        item.monetary,
        item.recencyScore,
        item.frequencyScore,
        item.monetaryScore,
        item.rfmScore,
        item.habitualRepurchaseDays,
        item.daysOverdue,
        item.churnScore,
        item.churnLevel,
        item.repurchaseScore,
        item.repurchaseLevel,
        item.trendLabel,
        item.primaryProductId,
        item.primaryCategoryId,
        JSON.stringify(item.factors),
        JSON.stringify(item.dataUsed),
        JSON.stringify(item.limitations),
        JSON.stringify(item.consentSummary),
        item.exampleKey,
      ]
    );
  }

  await client.query(
    `UPDATE aura_customer_segment_runs
     SET status = 'completed',
         rows_count = $2,
         data_quality = $3::jsonb,
         completed_at = NOW()
     WHERE id = $1`,
    [
      runId,
      scored.length,
      JSON.stringify({
        customersWithPaidHistory: scored.length,
        customersWithoutRepeatInterval: scored.filter((item) => item.habitualRepurchaseDays === null).length,
        pageViewsUsed: false,
      }),
    ]
  );

  return { id: runId, rowsCount: scored.length, asOfDate, segmentVersion: CUSTOMER_GROWTH_VERSION };
}

async function getLatestCompletedRun(ownerAdminId, asOfDate) {
  const { rows } = await db.query(
    `SELECT *
     FROM aura_customer_segment_runs
     WHERE owner_admin_id = $1
       AND as_of_date = $2::date
       AND segment_version = $3
       AND status = 'completed'
     ORDER BY completed_at DESC, created_at DESC
     LIMIT 1`,
    [ownerAdminId, asOfDate, CUSTOMER_GROWTH_VERSION]
  );
  return rows[0] || null;
}

async function ensureSnapshotRun(ctx, query = {}) {
  const asOfDate = toDateOnly(query.asOfDate || new Date());
  const existing = await getLatestCompletedRun(ctx.ownerAdminId, asOfDate);
  if (existing) {
    return {
      id: existing.id,
      rowsCount: Number(existing.rows_count || 0),
      asOfDate,
      segmentVersion: existing.segment_version,
      createdAt: existing.created_at,
      completedAt: existing.completed_at,
      reused: true,
    };
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const run = await createSnapshotRun({ ownerAdminId: ctx.ownerAdminId, userId: ctx.userId, asOfDate }, client);
    await client.query("COMMIT");
    return { ...run, reused: false };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function parseDetail(input) {
  return input === true || input === "true" || input === "1";
}

function normalizePagination(query = {}) {
  return {
    limit: boundedInteger(query.limit, 50, 1, MAX_DETAIL_LIMIT, "limit"),
    offset: boundedInteger(query.offset, 0, 0, 10_000, "offset"),
  };
}

function mapSnapshotDetail(row, includeCustomerId = false) {
  const data = {
    exampleKey: row.example_key,
    segment: { key: row.segment_key, label: row.segment_label },
    recencyDays: row.recency_days === null ? null : Number(row.recency_days),
    frequency: Number(row.frequency || 0),
    monetary: round(row.monetary),
    scores: {
      recency: row.recency_score === null ? null : Number(row.recency_score),
      frequency: row.frequency_score === null ? null : Number(row.frequency_score),
      monetary: row.monetary_score === null ? null : Number(row.monetary_score),
      rfm: round(row.rfm_score),
      churn: round(row.churn_score),
      repurchase: round(row.repurchase_score),
    },
    churnLevel: row.churn_level,
    repurchaseLevel: row.repurchase_level,
    trend: row.trend_label,
    primaryProductId: row.primary_product_id || null,
    factors: row.factors || [],
    dataUsed: row.data_used || {},
    limitations: row.limitations || [],
    consent: row.consent_summary || {},
    calculatedAt: row.created_at,
    version: row.segment_version,
  };
  if (includeCustomerId) data.customerId = Number(row.customer_id);
  return data;
}

async function aggregateBySegment(runId, ownerAdminId) {
  const { rows } = await db.query(
    `SELECT
       segment_key,
       segment_label,
       COUNT(*)::int AS customers,
       ROUND(AVG(recency_days), 2) AS avg_recency_days,
       ROUND(AVG(frequency), 2) AS avg_frequency,
       ROUND(AVG(monetary), 0) AS avg_monetary,
       ROUND(SUM(monetary), 0) AS total_monetary,
       ROUND(AVG(churn_score), 2) AS avg_churn_score,
       ROUND(AVG(repurchase_score), 2) AS avg_repurchase_score,
       COUNT(*) FILTER (WHERE consent_summary->>'email' = 'granted')::int AS email_consented,
       COUNT(*) FILTER (WHERE consent_summary->>'whatsapp' = 'granted')::int AS whatsapp_consented,
       COUNT(*) FILTER (WHERE consent_summary->>'push' = 'granted')::int AS push_consented
     FROM aura_customer_segment_snapshots
     WHERE run_id = $1
       AND owner_admin_id = $2
     GROUP BY segment_key, segment_label
     ORDER BY customers DESC, segment_label ASC`,
    [runId, ownerAdminId]
  );
  return rows.map((row) => ({
    key: row.segment_key,
    label: row.segment_label,
    customers: Number(row.customers || 0),
    averages: {
      recencyDays: round(row.avg_recency_days),
      frequency: round(row.avg_frequency),
      monetary: round(row.avg_monetary, 0),
      churnScore: round(row.avg_churn_score),
      repurchaseScore: round(row.avg_repurchase_score),
    },
    totalMonetary: round(row.total_monetary, 0),
    consentedAudience: {
      email: Number(row.email_consented || 0),
      whatsapp: Number(row.whatsapp_consented || 0),
      push: Number(row.push_consented || 0),
    },
  }));
}

async function aggregateByLevel(runId, ownerAdminId, levelColumn) {
  const safeColumn = levelColumn === "repurchase_level" ? "repurchase_level" : "churn_level";
  const scoreColumn = safeColumn === "repurchase_level" ? "repurchase_score" : "churn_score";
  const { rows } = await db.query(
    `SELECT
       ${safeColumn} AS level,
       COUNT(*)::int AS customers,
       ROUND(AVG(${scoreColumn}), 2) AS avg_score,
       ROUND(AVG(recency_days), 2) AS avg_recency_days,
       ROUND(AVG(frequency), 2) AS avg_frequency,
       COUNT(*) FILTER (WHERE consent_summary->>'email' = 'granted')::int AS email_consented,
       COUNT(*) FILTER (WHERE consent_summary->>'whatsapp' = 'granted')::int AS whatsapp_consented,
       COUNT(*) FILTER (WHERE consent_summary->>'push' = 'granted')::int AS push_consented
     FROM aura_customer_segment_snapshots
     WHERE run_id = $1
       AND owner_admin_id = $2
     GROUP BY ${safeColumn}
     ORDER BY avg_score DESC`,
    [runId, ownerAdminId]
  );
  return rows.map((row) => ({
    level: row.level,
    customers: Number(row.customers || 0),
    averageScore: round(row.avg_score),
    averages: {
      recencyDays: round(row.avg_recency_days),
      frequency: round(row.avg_frequency),
    },
    consentedAudience: {
      email: Number(row.email_consented || 0),
      whatsapp: Number(row.whatsapp_consented || 0),
      push: Number(row.push_consented || 0),
    },
  }));
}

async function getSnapshotDetails({ runId, ownerAdminId, query = {}, includeCustomerId = false, mode = "segments" }) {
  const { limit, offset } = normalizePagination(query);
  const params = [runId, ownerAdminId];
  const filters = ["run_id = $1", "owner_admin_id = $2"];
  const segment = optionalEnum(query.segment, new Set(Object.keys(SEGMENT_LABELS)), "segment");
  const churn = optionalEnum(query.churnLevel, new Set(["bajo", "medio", "alto", "critico", "insuficiente"]), "churnLevel");
  const repurchase = optionalEnum(query.repurchaseLevel, new Set(["baja", "media", "alta", "insuficiente"]), "repurchaseLevel");
  if (segment) {
    params.push(segment);
    filters.push(`segment_key = $${params.length}`);
  }
  if (churn) {
    params.push(churn);
    filters.push(`churn_level = $${params.length}`);
  }
  if (repurchase) {
    params.push(repurchase);
    filters.push(`repurchase_level = $${params.length}`);
  }
  params.push(limit, offset);

  const orderBy = mode === "repurchase"
    ? "repurchase_score DESC, recency_days ASC"
    : mode === "churn"
      ? "churn_score DESC, recency_days DESC"
      : "segment_label ASC, rfm_score DESC";

  const { rows } = await db.query(
    `SELECT *
     FROM aura_customer_segment_snapshots
     WHERE ${filters.join(" AND ")}
     ORDER BY ${orderBy}
     LIMIT $${params.length - 1}
     OFFSET $${params.length}`,
    params
  );
  return rows.map((row) => mapSnapshotDetail(row, includeCustomerId));
}

async function getCustomerSegments(input) {
  const ctx = requireCtx(input);
  const run = await ensureSnapshotRun(ctx, input.query || {});
  const detail = parseDetail(input.query?.detail);
  if (detail && !isHighPermission(ctx.roles)) {
    throw createCustomerGrowthError("El detalle individual requiere rol admin", "AURA_CUSTOMER_DETAIL_FORBIDDEN", 403);
  }
  const segments = await aggregateBySegment(run.id, ctx.ownerAdminId);
  const response = {
    asOfDate: run.asOfDate,
    version: run.segmentVersion,
    runId: run.id,
    totals: {
      customers: segments.reduce((sum, row) => sum + row.customers, 0),
      segments: segments.length,
    },
    segments,
    campaignIntegration: {
      estimateOnly: true,
      noAutomaticSending: true,
      contactRequiresConsent: true,
    },
    methodology: "RFM tenant-aware basado solo en ventas pagadas/no canceladas. No usa page_views.",
  };
  if (detail) {
    response.detail = await getSnapshotDetails({
      runId: run.id,
      ownerAdminId: ctx.ownerAdminId,
      query: input.query,
      includeCustomerId: true,
      mode: "segments",
    });
  }
  return response;
}

async function getChurnSummary(input) {
  const ctx = requireCtx(input);
  const run = await ensureSnapshotRun(ctx, input.query || {});
  const detail = parseDetail(input.query?.detail);
  if (detail && !isHighPermission(ctx.roles)) {
    throw createCustomerGrowthError("El detalle individual requiere rol admin", "AURA_CUSTOMER_DETAIL_FORBIDDEN", 403);
  }
  const levels = await aggregateByLevel(run.id, ctx.ownerAdminId, "churn_level");
  const response = {
    asOfDate: run.asOfDate,
    version: run.segmentVersion,
    runId: run.id,
    levels,
    methodology: "Churn heuristico por recencia vs intervalo habitual, frecuencia y tendencia. No es certeza ni probabilidad calibrada.",
    limitations: [
      "No usa page_views.",
      "No modela causas externas ni quiebres de stock por cliente.",
      "No autoriza contacto sin consentimiento vigente.",
    ],
  };
  if (detail) {
    response.detail = await getSnapshotDetails({
      runId: run.id,
      ownerAdminId: ctx.ownerAdminId,
      query: input.query,
      includeCustomerId: true,
      mode: "churn",
    });
  }
  return response;
}

async function getRepurchaseOpportunities(input) {
  const ctx = requireCtx(input);
  const run = await ensureSnapshotRun(ctx, input.query || {});
  const detail = parseDetail(input.query?.detail);
  if (detail && !isHighPermission(ctx.roles)) {
    throw createCustomerGrowthError("El detalle individual requiere rol admin", "AURA_CUSTOMER_DETAIL_FORBIDDEN", 403);
  }
  const levels = await aggregateByLevel(run.id, ctx.ownerAdminId, "repurchase_level");
  const response = {
    asOfDate: run.asOfDate,
    version: run.segmentVersion,
    runId: run.id,
    levels,
    methodology: "Score explicable de oportunidad de recompra; no es una probabilidad calibrada.",
    campaignIntegration: {
      estimateOnly: true,
      noAutomaticSending: true,
      consentRequired: true,
    },
  };
  if (detail) {
    response.detail = await getSnapshotDetails({
      runId: run.id,
      ownerAdminId: ctx.ownerAdminId,
      query: input.query,
      includeCustomerId: true,
      mode: "repurchase",
    });
  }
  return response;
}

async function getCustomerGrowthOpportunities(input) {
  const ctx = requireCtx(input);
  const query = input.query || {};
  const run = await ensureSnapshotRun(ctx, query);
  const [segments, churnLevels, repurchaseLevels, examples] = await Promise.all([
    aggregateBySegment(run.id, ctx.ownerAdminId),
    aggregateByLevel(run.id, ctx.ownerAdminId, "churn_level"),
    aggregateByLevel(run.id, ctx.ownerAdminId, "repurchase_level"),
    getSnapshotDetails({
      runId: run.id,
      ownerAdminId: ctx.ownerAdminId,
      query: { ...query, limit: boundedInteger(query.limit, 5, 1, MAX_TOOL_EXAMPLES, "limit") },
      includeCustomerId: false,
      mode: "repurchase",
    }),
  ]);

  return {
    asOfDate: run.asOfDate,
    version: run.segmentVersion,
    aggregates: {
      segments,
      churnLevels,
      repurchaseLevels,
    },
    anonymizedExamples: examples.map((item) => ({
      exampleKey: item.exampleKey,
      segment: item.segment,
      scores: item.scores,
      churnLevel: item.churnLevel,
      repurchaseLevel: item.repurchaseLevel,
      factors: item.factors,
      limitations: item.limitations,
      consentedChannels: Object.entries(item.consent || {})
        .filter(([, status]) => status === "granted")
        .map(([channel]) => channel),
    })),
    safety: {
      noPii: true,
      noAutomaticContact: true,
      consentRequiredBeforeCampaign: true,
      pageViewsUsed: false,
    },
  };
}

module.exports = {
  CUSTOMER_GROWTH_VERSION,
  SEGMENT_LABELS,
  scoreCustomerGrowth,
  classifySegment,
  ensureSnapshotRun,
  getCustomerSegments,
  getChurnSummary,
  getRepurchaseOpportunities,
  getCustomerGrowthOpportunities,
};
