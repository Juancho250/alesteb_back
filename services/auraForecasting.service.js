'use strict';

const crypto = require('crypto');
const db = require('../src/platform/database');
const { FEATURE_VERSION } = require('./auraPredictiveFeatures.service');

const FORECAST_MODEL_NAME = 'aura_statistical_baseline_forecaster';
const FORECAST_MODEL_VERSION = 'baseline_v1';
const FORECAST_HORIZONS = new Set([7, 14, 30]);
const MAX_FORECAST_LIMIT = 100;
const MIN_HISTORY_DAYS = 14;
const MIN_NONZERO_POINTS = 3;
const DEFAULT_HISTORY_DAYS = 180;

function createForecastError(message, code = 'AURA_FORECAST_ERROR', status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value, decimals = 4) {
  const factor = 10 ** decimals;
  return Math.round(numeric(value) * factor) / factor;
}

function toDateOnly(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return String(value || '').slice(0, 10);
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function normalizeHorizon(value, fallback = 7) {
  const parsed = Number(value ?? fallback);
  if (!FORECAST_HORIZONS.has(parsed)) {
    throw createForecastError('horizon debe ser 7, 14 o 30', 'AURA_FORECAST_INVALID_HORIZON', 400);
  }
  return parsed;
}

function normalizePositiveInteger(value, field, { required = false, max = 2_147_483_647 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw createForecastError(`${field} es requerido`, 'AURA_FORECAST_INVALID_INPUT', 400);
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    throw createForecastError(`${field} debe ser entero positivo`, 'AURA_FORECAST_INVALID_INPUT', 400);
  }
  return parsed;
}

function readBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    return ['true', '1', 'yes', 'y', 'on'].includes(value.trim().toLowerCase());
  }
  return defaultValue;
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + numeric(value), 0) / values.length;
}

function stddev(values) {
  if (!values.length) return 0;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (numeric(value) - avg) ** 2, 0) / values.length);
}

function clampForecast(value) {
  return Math.max(0, numeric(value));
}

function completeDailySeries(rows) {
  const sorted = [...rows]
    .map((row) => ({
      date: toDateOnly(row.feature_date || row.date),
      units: numeric(row.units_sold ?? row.units),
      stockouts: Number(row.stockouts || 0),
      stockAvailable: numeric(row.stock_available_final),
      leadTimeDays: row.lead_time_days === null || row.lead_time_days === undefined ? null : Number(row.lead_time_days),
      pendingPurchaseUnits: numeric(row.pending_purchase_units),
      dataQuality: row.data_quality || {},
      completenessScore: numeric(row.completeness_score),
      isDataSufficient: Boolean(row.is_data_sufficient),
    }))
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date))
    .sort((a, b) => a.date.localeCompare(b.date));

  if (!sorted.length) return [];
  const byDate = new Map(sorted.map((row) => [row.date, row]));
  const result = [];
  for (let date = sorted[0].date; date <= sorted[sorted.length - 1].date; date = addDays(date, 1)) {
    result.push(byDate.get(date) || {
      date,
      units: 0,
      stockouts: 0,
      stockAvailable: null,
      leadTimeDays: null,
      pendingPurchaseUnits: 0,
      dataQuality: { missingFeatureDayFilledAsZero: true },
      completenessScore: 0,
      isDataSufficient: false,
    });
  }
  return result;
}

function forecastNaive(history, horizon) {
  const last = history.length ? history[history.length - 1].units : 0;
  return Array.from({ length: horizon }, () => clampForecast(last));
}

function forecastSeasonalNaive(history, horizon) {
  return Array.from({ length: horizon }, (_, index) => {
    const seasonalIndex = history.length - 7 + (index % 7);
    const value = seasonalIndex >= 0 ? history[seasonalIndex]?.units : history[history.length - 1]?.units;
    return clampForecast(value || 0);
  });
}

function forecastMovingAverage(history, horizon, window = 14) {
  const slice = history.slice(-window).map((row) => row.units);
  const value = mean(slice);
  return Array.from({ length: horizon }, () => clampForecast(value));
}

function forecastWeightedAverage(history, horizon, window = 14) {
  const slice = history.slice(-window).map((row) => row.units);
  if (!slice.length) return Array.from({ length: horizon }, () => 0);
  const totalWeight = slice.reduce((sum, _value, index) => sum + index + 1, 0);
  const value = slice.reduce((sum, value, index) => sum + numeric(value) * (index + 1), 0) / totalWeight;
  return Array.from({ length: horizon }, () => clampForecast(value));
}

function forecastExponentialSmoothing(history, horizon, alpha = 0.35) {
  if (!history.length) return Array.from({ length: horizon }, () => 0);
  let level = numeric(history[0].units);
  for (const row of history.slice(1)) {
    level = alpha * numeric(row.units) + (1 - alpha) * level;
  }
  return Array.from({ length: horizon }, () => clampForecast(level));
}

const MODEL_DEFINITIONS = [
  { name: 'naive', minDays: 1, forecast: forecastNaive },
  { name: 'seasonal_naive', minDays: 14, forecast: forecastSeasonalNaive },
  { name: 'moving_average', minDays: 7, forecast: forecastMovingAverage },
  { name: 'weighted_average', minDays: 7, forecast: forecastWeightedAverage },
  { name: 'exponential_smoothing', minDays: 7, forecast: forecastExponentialSmoothing },
];

function scoreErrors(points) {
  const n = points.length;
  if (!n) return { mae: null, wape: null, bias: null, coverage: null, points: 0 };
  const abs = points.map((point) => Math.abs(point.actual - point.predicted));
  const errors = points.map((point) => point.predicted - point.actual);
  const totalActual = points.reduce((sum, point) => sum + Math.abs(point.actual), 0);
  const mae = mean(abs);
  const band = Math.max(mae * 1.28, 0.0001);
  const covered = points.filter((point) => point.actual >= Math.max(0, point.predicted - band) && point.actual <= point.predicted + band).length;
  return {
    mae: round(mae),
    wape: totalActual > 0 ? round(abs.reduce((sum, value) => sum + value, 0) / totalActual) : null,
    bias: round(mean(errors)),
    coverage: round(covered / n),
    points: n,
  };
}

function backtestModel(series, model) {
  const testDays = Math.min(30, Math.max(7, Math.floor(series.length * 0.25)));
  const startIndex = Math.max(model.minDays, series.length - testDays);
  const points = [];
  for (let i = startIndex; i < series.length; i++) {
    const history = series.slice(0, i);
    const predicted = model.forecast(history, 1)[0] || 0;
    points.push({
      date: series[i].date,
      actual: numeric(series[i].units),
      predicted: clampForecast(predicted),
    });
  }
  return {
    model: model.name,
    ...scoreErrors(points),
    predictions: points,
  };
}

function chooseBestModel(backtests) {
  const eligible = backtests.filter((row) => row.points > 0 && row.mae !== null);
  if (!eligible.length) return null;
  return eligible.sort((a, b) => {
    const aw = a.wape === null ? Number.POSITIVE_INFINITY : a.wape;
    const bw = b.wape === null ? Number.POSITIVE_INFINITY : b.wape;
    if (aw !== bw) return aw - bw;
    if (a.mae !== b.mae) return a.mae - b.mae;
    return a.model.localeCompare(b.model);
  })[0];
}

function fallbackForecast(series, horizon, reason) {
  const recent = series.slice(-Math.min(7, series.length)).map((row) => row.units);
  const daily = Array.from({ length: horizon }, () => clampForecast(mean(recent)));
  const total = daily.reduce((sum, value) => sum + value, 0);
  return {
    selectedModel: 'fallback_cold_start',
    reliable: false,
    coldStart: true,
    reason,
    dailyForecast: daily.map((value, index) => ({ date: addDays(series[series.length - 1]?.date || new Date().toISOString().slice(0, 10), index + 1), value: round(value) })),
    total: round(total),
    lower: 0,
    upper: round(total + Math.max(1, stddev(recent)) * Math.sqrt(horizon) * 1.28),
    backtests: [],
    metrics: { mae: null, wape: null, bias: null, coverage: null, points: 0 },
    limitations: ['Historial insuficiente; forecast marcado como cold start.'],
  };
}

function forecastSeries(rawRows, { horizon = 7, asOfDate = null } = {}) {
  const normalizedHorizon = normalizeHorizon(horizon);
  let series = completeDailySeries(rawRows);
  if (asOfDate) series = series.filter((row) => row.date <= toDateOnly(asOfDate));

  if (!series.length) {
    return fallbackForecast([{ date: toDateOnly(asOfDate || new Date()) || new Date().toISOString().slice(0, 10), units: 0 }], normalizedHorizon, 'Sin historial de features.');
  }

  const nonzero = series.filter((row) => row.units > 0).length;
  const hasStockout = series.some((row) => Number(row.stockouts || 0) > 0);
  const qualityLow = series.slice(-30).some((row) => row.completenessScore > 0 && row.completenessScore < 0.65);
  const limitations = [];
  if (hasStockout) limitations.push('La demanda puede estar censurada por stockouts; ventas perdidas no estan modeladas.');
  if (qualityLow) limitations.push('Algunos dias tienen completitud baja en features.');
  if (series.length < MIN_HISTORY_DAYS || nonzero < MIN_NONZERO_POINTS) {
    const fallback = fallbackForecast(series, normalizedHorizon, 'Historial insuficiente para seleccionar baseline confiable.');
    fallback.limitations.push(...limitations);
    return fallback;
  }

  const backtests = MODEL_DEFINITIONS
    .filter((model) => series.length >= model.minDays)
    .map((model) => backtestModel(series, model));
  const best = chooseBestModel(backtests);
  if (!best) {
    const fallback = fallbackForecast(series, normalizedHorizon, 'No hubo puntos suficientes para backtesting.');
    fallback.limitations.push(...limitations);
    return fallback;
  }

  const model = MODEL_DEFINITIONS.find((definition) => definition.name === best.model);
  const forecastValues = model.forecast(series, normalizedHorizon).map(clampForecast);
  const total = forecastValues.reduce((sum, value) => sum + value, 0);
  const residuals = best.predictions.map((point) => point.predicted - point.actual);
  const dailyUncertainty = Math.max(best.mae || 0, stddev(residuals));
  const totalBand = Math.max(0.5, dailyUncertainty * Math.sqrt(normalizedHorizon) * 1.28);
  const lastDate = series[series.length - 1].date;

  return {
    selectedModel: best.model,
    reliable: true,
    coldStart: false,
    reason: `Baseline seleccionado por menor ${best.wape === null ? 'MAE' : 'WAPE'} en backtesting.`,
    dailyForecast: forecastValues.map((value, index) => ({
      date: addDays(lastDate, index + 1),
      value: round(value),
      lower: round(Math.max(0, value - dailyUncertainty * 1.28)),
      upper: round(value + dailyUncertainty * 1.28),
    })),
    total: round(total),
    lower: round(Math.max(0, total - totalBand)),
    upper: round(total + totalBand),
    metrics: {
      mae: best.mae,
      wape: best.wape,
      bias: best.bias,
      coverage: best.coverage,
      points: best.points,
    },
    backtests: backtests.map(({ predictions, ...rest }) => rest),
    limitations,
  };
}

function buildRestockRecommendation({ forecast, leadTimeDays, safetyStock, stockAvailable, pendingPurchaseUnits, moq = null }) {
  const missing = [];
  if (leadTimeDays === null || leadTimeDays === undefined || !Number.isFinite(Number(leadTimeDays))) missing.push('lead_time_days');
  if (moq === null || moq === undefined) missing.push('moq');
  const usableLead = Number.isFinite(Number(leadTimeDays)) ? Math.max(0, Number(leadTimeDays)) : 0;
  const dailyDemand = numeric(forecast.total) / normalizeHorizon(forecast.horizon || 7);
  const demandDuringLeadTime = dailyDemand * usableLead;
  const raw = demandDuringLeadTime + numeric(safetyStock) - numeric(stockAvailable) - numeric(pendingPurchaseUnits);
  const recommended = Math.max(0, Math.ceil(raw));
  return {
    recommendedPurchaseUnits: recommended,
    isComplete: missing.length === 0,
    missing,
    components: {
      demandDuringLeadTime: round(demandDuringLeadTime),
      safetyStock: numeric(safetyStock),
      stockAvailable: numeric(stockAvailable),
      pendingPurchaseUnits: numeric(pendingPurchaseUnits),
      leadTimeDays: leadTimeDays ?? null,
      moq,
    },
    explanation: missing.length
      ? `Recomendacion incompleta: faltan ${missing.join(', ')}. No se inventaron esos valores.`
      : 'Compra sugerida = demanda esperada durante lead time + safety stock - stock disponible - compras pendientes.',
  };
}

async function getOrCreateModelVersion(client = db) {
  const requestedId = crypto.randomUUID();
  const { rows } = await client.query(
    `INSERT INTO model_versions
       (id, name, version, model_type, feature_version, status, metrics, metadata)
     VALUES ($1, $2, $3, 'statistical_baseline', $4, 'active', '{}'::jsonb, $5::jsonb)
     ON CONFLICT (name, version)
     DO UPDATE SET
       status = 'active',
       feature_version = EXCLUDED.feature_version,
       updated_at = NOW()
     RETURNING id`,
    [
      requestedId,
      FORECAST_MODEL_NAME,
      FORECAST_MODEL_VERSION,
      FEATURE_VERSION,
      JSON.stringify({
        baselines: MODEL_DEFINITIONS.map((model) => model.name),
        metrics: ['MAE', 'WAPE', 'bias', 'coverage'],
        noMape: true,
      }),
    ]
  );
  return {
    id: rows[0].id,
    created: String(rows[0].id) === requestedId,
  };
}

function groupByTarget(rows, keyField) {
  const grouped = new Map();
  for (const row of rows) {
    const key = String(row[keyField]);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return grouped;
}

async function fetchFeatureRows({ ownerAdminId, targetType, productId = null, variantId = null, historyDays = DEFAULT_HISTORY_DAYS }, client = db) {
  const table = targetType === 'variant' ? 'daily_variant_features' : 'daily_product_features';
  const idColumn = targetType === 'variant' ? 'variant_id' : 'product_id';
  const params = [ownerAdminId, FEATURE_VERSION, Math.min(Math.max(Number(historyDays) || DEFAULT_HISTORY_DAYS, 30), 730)];
  let filter = '';
  if (targetType === 'product' && productId) {
    params.push(productId);
    filter = `AND product_id = $${params.length}`;
  }
  if (targetType === 'variant' && variantId) {
    params.push(variantId);
    filter = `AND variant_id = $${params.length}`;
  } else if (targetType === 'variant' && productId) {
    params.push(productId);
    filter = `AND product_id = $${params.length}`;
  }

  const { rows } = await client.query(
    `WITH ranked AS (
       SELECT *,
              ROW_NUMBER() OVER (PARTITION BY ${idColumn} ORDER BY feature_date DESC) AS rn
       FROM ${table}
       WHERE owner_admin_id = $1
         AND feature_version = $2
         ${filter}
     )
     SELECT *
     FROM ranked
     WHERE rn <= $3
     ORDER BY ${idColumn}, feature_date ASC`,
    params
  );
  return rows;
}

async function saveForecastRun({
  ownerAdminId,
  userId = null,
  targetType = 'product',
  productId = null,
  variantId = null,
  horizons = [7, 14, 30],
  auditTag = null,
}, client = db) {
  const safeHorizons = [...new Set(horizons.map((h) => normalizeHorizon(h)))];
  const modelVersion = await getOrCreateModelVersion(client);
  const modelVersionId = modelVersion.id;
  const rows = await fetchFeatureRows({ ownerAdminId, targetType, productId, variantId }, client);
  const keyField = targetType === 'variant' ? 'variant_id' : 'product_id';
  const grouped = groupByTarget(rows, keyField);
  const runId = crypto.randomUUID();
  const dates = rows.map((row) => toDateOnly(row.feature_date)).sort();

  await client.query(
    `INSERT INTO prediction_runs
       (id, owner_admin_id, run_type, feature_version, model_version_id, status,
        date_from, date_to, requested_by, metadata)
     VALUES ($1, $2, 'prediction', $3, $4, 'running', $5, $6, $7, $8::jsonb)`,
    [
      runId,
      ownerAdminId,
      FEATURE_VERSION,
      modelVersionId,
      dates[0] || null,
      dates[dates.length - 1] || null,
      userId,
      JSON.stringify({
        targetType,
        productId,
        variantId,
        horizons: safeHorizons,
        modelVersionCreated: modelVersion.created,
        ...(auditTag ? { auditTag: String(auditTag).slice(0, 80) } : {}),
      }),
    ]
  );

  let inserted = 0;
  const quality = { series: grouped.size, coldStart: 0, insufficient: 0 };
  for (const [targetId, seriesRows] of grouped.entries()) {
    for (const horizon of safeHorizons) {
      const forecast = forecastSeries(seriesRows, { horizon });
      forecast.horizon = horizon;
      if (forecast.coldStart) quality.coldStart++;
      if (!forecast.reliable) quality.insufficient++;
      const lastRow = seriesRows[seriesRows.length - 1] || {};
      const predictionDate = addDays(toDateOnly(lastRow.feature_date || new Date()), horizon);
      const resultId = crypto.randomUUID();
      await client.query(
        `INSERT INTO prediction_results
           (id, run_id, owner_admin_id, model_version_id, target_type,
            product_id, variant_id, prediction_date, horizon_days, metric,
            predicted_value, lower_bound, upper_bound, confidence_score,
            features_snapshot, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'demand_units',$10,$11,$12,$13,$14::jsonb,$15::jsonb)`,
        [
          resultId,
          runId,
          ownerAdminId,
          modelVersionId,
          targetType,
          targetType === 'product' ? Number(targetId) : Number(lastRow.product_id),
          targetType === 'variant' ? Number(targetId) : null,
          predictionDate,
          horizon,
          forecast.total,
          forecast.lower,
          forecast.upper,
          forecast.reliable ? Math.max(0, Math.min(1, 1 - numeric(forecast.metrics.wape))) : 0,
          JSON.stringify({
            selectedModel: forecast.selectedModel,
            modelVersion: FORECAST_MODEL_VERSION,
            featureVersion: FEATURE_VERSION,
            sampleSize: seriesRows.length,
            dateRange: {
              from: seriesRows[0]?.feature_date ? toDateOnly(seriesRows[0].feature_date) : null,
              to: lastRow.feature_date ? toDateOnly(lastRow.feature_date) : null,
            },
            generatedAt: new Date().toISOString(),
            current: {
              featureDate: lastRow.feature_date ? toDateOnly(lastRow.feature_date) : null,
              stockFinal: numeric(lastRow.stock_final),
              stockReservedFinal: numeric(lastRow.stock_reserved_final),
              stockAvailableFinal: numeric(lastRow.stock_available_final),
              pendingPurchaseUnits: numeric(lastRow.pending_purchase_units),
              leadTimeDays: lastRow.lead_time_days === null || lastRow.lead_time_days === undefined
                ? null
                : Number(lastRow.lead_time_days),
            },
            dailyForecast: forecast.dailyForecast,
            metrics: forecast.metrics,
            backtests: forecast.backtests,
            reliable: forecast.reliable,
            coldStart: forecast.coldStart,
            uncertainty: { lower: forecast.lower, upper: forecast.upper },
            limitations: forecast.limitations,
            reason: forecast.reason,
          }),
          JSON.stringify({ generatedBy: 'aura_statistical_baseline', noLlm: true }),
        ]
      );
      inserted++;
    }
  }

  await client.query(
    `UPDATE prediction_runs
     SET status = 'completed',
         rows_count = $2,
         data_quality = $3::jsonb,
         completed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [runId, inserted, JSON.stringify(quality)]
  );

  return {
    runId,
    inserted,
    quality,
    modelVersionId,
    modelVersionCreated: modelVersion.created,
  };
}

async function recalculateForecasts(input) {
  if (!input?.ownerAdminId) throw createForecastError('ownerAdminId requerido', 'AURA_FORECAST_TENANT_REQUIRED', 500);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await saveForecastRun(input, client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function forecastJobDedupeKey({ ownerAdminId, targetType = 'product', productId = null, variantId = null, horizons = [7, 14, 30], asOfDate = null }) {
  const date = asOfDate || new Date().toISOString().slice(0, 10);
  const safeHorizons = [...new Set(horizons.map((h) => normalizeHorizon(h)))].sort((a, b) => a - b).join(',');
  return `forecast:${ownerAdminId}:${targetType}:${productId || 'all'}:${variantId || 'all'}:${safeHorizons}:${date}`;
}

async function findForecastJobByStatuses(client, { ownerAdminId, dedupeKey, statuses }) {
  const safeStatuses = (Array.isArray(statuses) ? statuses : []).filter(Boolean);
  if (!safeStatuses.length) return null;
  const statusSql = safeStatuses.map((status) => `'${String(status)}'`).join(', ');
  const { rows } = await client.query(
    `SELECT *
     FROM ai_jobs
     WHERE owner_admin_id = $1
       AND type = 'aura_prediction_recalculate'
       AND dedupe_key = $2
       AND status IN (${statusSql})
     ORDER BY created_at DESC
     LIMIT 1`,
    [ownerAdminId, dedupeKey]
  );
  return rows[0] || null;
}

async function enqueueForecastRecalculation({ ownerAdminId, userId, payload = {} }) {
  const targetType = payload.variantId ? 'variant' : 'product';
  const productId = normalizePositiveInteger(payload.productId, 'productId', { required: false });
  const variantId = normalizePositiveInteger(payload.variantId, 'variantId', { required: false });
  const horizons = Array.isArray(payload.horizons) && payload.horizons.length
    ? payload.horizons.map((h) => normalizeHorizon(h))
    : [7, 14, 30];
  const force = readBoolean(payload.force);
  const cacheRequested = !force && readBoolean(payload.cache || payload.reuseCompleted || payload.useCache);
  const input = {
    ownerAdminId,
    userId,
    targetType,
    productId,
    variantId,
    horizons,
    force,
    cacheRequested,
  };
  const baseDedupeKey = forecastJobDedupeKey(input);
  const activeStatuses = force ? ['running'] : ['queued', 'running'];
  const activeJob = await findForecastJobByStatuses(db, {
    ownerAdminId,
    dedupeKey: baseDedupeKey,
    statuses: activeStatuses,
  });
  if (activeJob) {
    return {
      ...activeJob,
      deduped: true,
      created: false,
      cached: false,
      forced: force,
      reusedActive: true,
      baseDedupeKey,
    };
  }

  if (cacheRequested) {
    const cachedJob = await findForecastJobByStatuses(db, {
      ownerAdminId,
      dedupeKey: baseDedupeKey,
      statuses: ['completed'],
    });
    if (cachedJob) {
      return {
        ...cachedJob,
        deduped: true,
        created: false,
        cached: true,
        forced: false,
        reusedActive: false,
        baseDedupeKey,
      };
    }
  }

  const jobId = crypto.randomUUID();
  const dedupeKey = force ? `force:${baseDedupeKey}:${jobId}` : baseDedupeKey;
  const { rows } = await db.query(
    `INSERT INTO ai_jobs
       (id, owner_admin_id, user_id, type, status, priority, input, attempts, max_attempts,
        available_at, dedupe_key, created_at, updated_at)
     VALUES ($1,$2,$3,'aura_prediction_recalculate','queued',50,$4::jsonb,0,2,NOW(),$5,NOW(),NOW())
     ON CONFLICT DO NOTHING
     RETURNING id, owner_admin_id, user_id, type, status, priority, input, attempts, max_attempts,
               available_at, locked_at, locked_by, error_code, error_message_redacted, dedupe_key,
               created_at, started_at, completed_at, updated_at`,
    [jobId, ownerAdminId, userId, JSON.stringify(input), dedupeKey]
  );

  if (rows[0]) {
    return {
      ...rows[0],
      deduped: false,
      created: true,
      cached: false,
      forced: force,
      reusedActive: false,
      baseDedupeKey,
    };
  }

  const fallback = await findForecastJobByStatuses(db, {
    ownerAdminId,
    dedupeKey: baseDedupeKey,
    statuses: ['queued', 'running'],
  });
  if (fallback) {
    return {
      ...fallback,
      deduped: true,
      created: false,
      cached: false,
      forced: force,
      reusedActive: true,
      baseDedupeKey,
    };
  }

  throw createForecastError('No se pudo crear el job de recálculo', 'AURA_FORECAST_JOB_INSERT_FAILED', 409);
}

function mapPredictionRow(row) {
  const snapshot = row.features_snapshot || {};
  const freshnessHours = Math.min(
    Math.max(Number(process.env.AURA_PREDICTION_FRESHNESS_HOURS || 48), 1),
    720
  );
  const generatedAt = snapshot.generatedAt || row.created_at;
  const generatedMs = generatedAt ? new Date(generatedAt).getTime() : 0;
  const stale = !generatedMs || Date.now() - generatedMs > freshnessHours * 60 * 60 * 1000;
  const confidenceScore = row.confidence_score === null ? null : round(row.confidence_score);
  return {
    id: row.id,
    runId: row.run_id,
    targetType: row.target_type,
    productId: row.product_id || null,
    variantId: row.variant_id || null,
    horizonDays: Number(row.horizon_days),
    predictionDate: row.prediction_date,
    metric: row.metric,
    predictedValue: round(row.predicted_value),
    lowerBound: row.lower_bound === null ? null : round(row.lower_bound),
    upperBound: row.upper_bound === null ? null : round(row.upper_bound),
    confidenceScore,
    confidence: {
      score: confidenceScore,
      level: !snapshot.reliable
        ? 'insuficiente'
        : confidenceScore >= 0.8
          ? 'alta'
          : confidenceScore >= 0.55
            ? 'media'
            : 'baja',
    },
    sampleSize: Number(snapshot.sampleSize || snapshot.metrics?.points || 0),
    dateRange: snapshot.dateRange || null,
    selectedModel: snapshot.selectedModel || null,
    reliable: Boolean(snapshot.reliable),
    coldStart: Boolean(snapshot.coldStart),
    metrics: snapshot.metrics || {},
    uncertainty: snapshot.uncertainty || {},
    dailyForecast: snapshot.dailyForecast || [],
    limitations: snapshot.limitations || [],
    explanation: snapshot.reason || null,
    pendingPurchaseUnits: numeric(snapshot.current?.pendingPurchaseUnits),
    featureVersion: snapshot.featureVersion || null,
    modelVersion: snapshot.modelVersion || null,
    generatedAt,
    stale,
    productName: row.product_name || null,
    variantSku: row.variant_sku || null,
    createdAt: row.created_at,
  };
}

async function getDemandForecasts({ ownerAdminId, query = {} }) {
  const horizon = query.horizon ? normalizeHorizon(query.horizon) : null;
  const productId = normalizePositiveInteger(query.productId, 'productId', { required: false });
  const variantId = normalizePositiveInteger(query.variantId, 'variantId', { required: false });
  const limit = Math.min(Math.max(Number.parseInt(query.limit || '50', 10) || 50, 1), MAX_FORECAST_LIMIT);
  const params = [ownerAdminId];
  const filters = ["pr.owner_admin_id = $1", "pr.metric = 'demand_units'"];
  if (horizon) {
    params.push(horizon);
    filters.push(`pr.horizon_days = $${params.length}`);
  }
  if (productId) {
    params.push(productId);
    filters.push(`pr.product_id = $${params.length}`);
  }
  if (variantId) {
    params.push(variantId);
    filters.push(`pr.variant_id = $${params.length}`);
  }
  params.push(limit);
  const { rows } = await db.query(
    `WITH latest AS (
       SELECT DISTINCT ON (pr.target_type, COALESCE(pr.product_id, 0), COALESCE(pr.variant_id, 0), pr.horizon_days)
         pr.*
       FROM prediction_results pr
       WHERE ${filters.join(' AND ')}
       ORDER BY pr.target_type, COALESCE(pr.product_id, 0), COALESCE(pr.variant_id, 0), pr.horizon_days, pr.created_at DESC
     )
     SELECT l.*, p.name AS product_name, pv.sku AS variant_sku
     FROM latest l
     LEFT JOIN products p
       ON p.id = l.product_id
      AND p.owner_admin_id = l.owner_admin_id
     LEFT JOIN product_variants pv
       ON pv.id = l.variant_id
      AND pv.product_id = l.product_id
     ORDER BY l.created_at DESC
     LIMIT $${params.length}`,
    params
  );
  return rows.map(mapPredictionRow);
}

async function getInventoryForPrediction(row) {
  if (row.targetType === 'variant' && row.variantId) {
    const { rows } = await db.query(
      `SELECT
         p.id AS product_id,
         p.name AS product_name,
         pv.id AS variant_id,
         pv.sku AS variant_sku,
         COALESCE(pv.stock, 0) AS stock,
         COALESCE(pv.stock_reserved, 0) AS stock_reserved,
         COALESCE(pv.stock_safety, 0) AS safety_stock,
         GREATEST(0, COALESCE(pv.stock, 0) - COALESCE(pv.stock_reserved, 0) - COALESCE(pv.stock_safety, 0)) AS stock_available,
         COALESCE(p.supplier_lead_time_days, pr.lead_time_days)::int AS lead_time_days,
         NULL::numeric AS moq
       FROM product_variants pv
       JOIN products p ON p.id = pv.product_id
       LEFT JOIN providers pr ON pr.id = p.default_supplier_id AND pr.owner_admin_id = p.owner_admin_id
       WHERE p.owner_admin_id = $1
         AND pv.id = $2
       LIMIT 1`,
      [row.ownerAdminId, row.variantId]
    );
    return rows[0] || null;
  }

  const { rows } = await db.query(
    `SELECT
       p.id AS product_id,
       p.name AS product_name,
       NULL::integer AS variant_id,
       NULL::text AS variant_sku,
       COALESCE(p.stock, 0) AS stock,
       COALESCE(p.stock_reserved, 0) AS stock_reserved,
       COALESCE(p.stock_safety, 0) AS safety_stock,
       GREATEST(0, COALESCE(p.stock, 0) - COALESCE(p.stock_reserved, 0) - COALESCE(p.stock_safety, 0)) AS stock_available,
       COALESCE(p.supplier_lead_time_days, pr.lead_time_days)::int AS lead_time_days,
       NULL::numeric AS moq
     FROM products p
     LEFT JOIN providers pr ON pr.id = p.default_supplier_id AND pr.owner_admin_id = p.owner_admin_id
     WHERE p.owner_admin_id = $1
       AND p.id = $2
     LIMIT 1`,
    [row.ownerAdminId, row.productId]
  );
  return rows[0] || null;
}

async function getRestockRecommendations({ ownerAdminId, query = {} }) {
  const demand = await getDemandForecasts({ ownerAdminId, query: { ...query, horizon: query.horizon || 7 } });
  const rows = [];
  for (const item of demand) {
    const inventory = await getInventoryForPrediction({ ...item, ownerAdminId });
    if (!inventory) continue;
    const recommendation = buildRestockRecommendation({
      forecast: { total: item.predictedValue, horizon: item.horizonDays },
      leadTimeDays: inventory.lead_time_days,
      safetyStock: inventory.safety_stock,
      stockAvailable: inventory.stock_available,
      pendingPurchaseUnits: item.pendingPurchaseUnits || 0,
      moq: inventory.moq,
    });
    rows.push({
      ...item,
      productName: inventory.product_name || item.productName,
      variantSku: inventory.variant_sku || item.variantSku,
      inventory: {
        stock: numeric(inventory.stock),
        stockReserved: numeric(inventory.stock_reserved),
        safetyStock: numeric(inventory.safety_stock),
        stockAvailable: numeric(inventory.stock_available),
        leadTimeDays: inventory.lead_time_days === null ? null : Number(inventory.lead_time_days),
        moq: inventory.moq === null ? null : Number(inventory.moq),
      },
      restock: recommendation,
    });
  }
  return rows;
}

function normalizeForecastClaimScope({ ownerAdminId = null, jobId = null } = {}) {
  const hasOwner = ownerAdminId !== undefined && ownerAdminId !== null;
  const hasJob = jobId !== undefined && jobId !== null;
  if (!hasOwner && !hasJob) return null;
  if (!hasOwner || !hasJob) {
    throw createForecastError(
      'Un claim acotado requiere ownerAdminId y jobId',
      'AURA_FORECAST_CLAIM_SCOPE_INCOMPLETE',
      500
    );
  }
  const parsedOwner = Number(ownerAdminId);
  if (
    !Number.isSafeInteger(parsedOwner)
    || parsedOwner <= 0
    || typeof jobId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)
  ) {
    throw createForecastError(
      'Alcance de claim invalido',
      'AURA_FORECAST_CLAIM_SCOPE_INVALID',
      500
    );
  }
  return { ownerAdminId: parsedOwner, jobId };
}

async function claimForecastJobs(
  limit = 5,
  workerId = `forecast-worker:${process.pid}`,
  claimScope = {}
) {
  const scope = normalizeForecastClaimScope(claimScope);
  const params = [limit, workerId];
  let scopeSql = '';
  if (scope) {
    params.push(scope.ownerAdminId, scope.jobId);
    scopeSql = `
         AND owner_admin_id = $3
         AND id = $4`;
  }

  const { rows } = await db.query(
    `WITH next_jobs AS (
       SELECT id
       FROM ai_jobs
       WHERE type = 'aura_prediction_recalculate'
         AND status = 'queued'
         AND COALESCE(available_at, NOW()) <= NOW()
         AND COALESCE(attempts, 0) < COALESCE(max_attempts, 2)
         ${scopeSql}
       ORDER BY priority ASC, created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE ai_jobs j
     SET status = 'running',
         attempts = COALESCE(j.attempts, 0) + 1,
         locked_at = NOW(),
         locked_by = $2,
         started_at = COALESCE(started_at, NOW()),
         updated_at = NOW()
     FROM next_jobs
     WHERE j.id = next_jobs.id
     RETURNING j.*`,
    params
  );
  return rows;
}

async function processForecastJob(job) {
  try {
    const result = await recalculateForecasts(job.input || {});
    await db.query(
      `UPDATE ai_jobs
       SET status = 'completed',
           output = $2::jsonb,
           completed_at = NOW(),
           locked_at = NULL,
           locked_by = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [job.id, JSON.stringify(result)]
    );
    return { success: true, jobId: job.id, result };
  } catch (err) {
    const terminal = Number(job.attempts || 1) >= Number(job.max_attempts || 2);
    const backoffMinutes = Math.min(60, 2 ** Math.max(Number(job.attempts || 1) - 1, 0));
    await db.query(
      `UPDATE ai_jobs
       SET status = $2,
           error_code = $3,
           error_message_redacted = $4,
           available_at = CASE
             WHEN $2 = 'queued' THEN NOW() + ($5::int * INTERVAL '1 minute')
             ELSE available_at
           END,
           completed_at = CASE WHEN $2 = 'failed' THEN NOW() ELSE completed_at END,
           locked_at = NULL,
           locked_by = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [
        job.id,
        terminal ? 'failed' : 'queued',
        String(err.code || 'AURA_FORECAST_JOB_FAILED').slice(0, 80),
        String(err.status && err.status < 500 ? err.message : 'Error recalculando forecast').slice(0, 500),
        backoffMinutes,
      ]
    );
    return { success: false, jobId: job.id, code: err.code || 'AURA_FORECAST_JOB_FAILED' };
  }
}

async function recoverStaleForecastJobs(staleMinutes = Number(process.env.AURA_FORECAST_STALE_JOB_MINUTES || 30)) {
  const minutes = Number.isFinite(Number(staleMinutes))
    ? Math.min(Math.max(Number(staleMinutes), 5), 1440)
    : 30;
  const { rows } = await db.query(
    `UPDATE ai_jobs
     SET status = 'failed',
         error_code = 'AURA_FORECAST_STALE_CLAIM',
         error_message_redacted = 'Claim abandonado; requiere revision antes de recalcular',
         completed_at = COALESCE(completed_at, NOW()),
         locked_at = NULL,
         locked_by = NULL,
         updated_at = NOW()
     WHERE type = 'aura_prediction_recalculate'
       AND status = 'running'
       AND locked_at < NOW() - ($1::int * INTERVAL '1 minute')
     RETURNING id`,
    [minutes]
  );
  return { recovered: rows.length, strategy: 'quarantine_for_manual_review' };
}

async function processForecastJobs(limit = 5, workerId, claimScope = {}) {
  const jobs = await claimForecastJobs(limit, workerId, claimScope);
  const results = [];
  for (const job of jobs) {
    results.push(await processForecastJob(job));
  }
  return { processed: results.length, results };
}

module.exports = {
  FORECAST_MODEL_NAME,
  FORECAST_MODEL_VERSION,
  FORECAST_HORIZONS,
  completeDailySeries,
  forecastSeries,
  backtestModel,
  buildRestockRecommendation,
  forecastJobDedupeKey,
  enqueueForecastRecalculation,
  recalculateForecasts,
  getDemandForecasts,
  getRestockRecommendations,
  normalizeForecastClaimScope,
  claimForecastJobs,
  recoverStaleForecastJobs,
  processForecastJobs,
};
