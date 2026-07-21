const test = require("node:test");
const assert = require("node:assert/strict");

const dbPath = require.resolve("../src/platform/database");
const calls = [];
const jobStore = new Map();

function now() {
  return "2026-07-14T00:00:00Z";
}

function jobRow(row) {
  return {
    id: row.id,
    owner_admin_id: row.owner_admin_id,
    user_id: row.user_id,
    type: row.type,
    status: row.status,
    priority: row.priority || 50,
    input: row.input || {},
    output: row.output || {},
    attempts: row.attempts || 0,
    max_attempts: row.max_attempts || 2,
    available_at: row.available_at || now(),
    locked_at: row.locked_at || null,
    locked_by: row.locked_by || null,
    error_code: row.error_code || null,
    error_message_redacted: row.error_message_redacted || null,
    dedupe_key: row.dedupe_key || null,
    created_at: row.created_at || now(),
    started_at: row.started_at || null,
    completed_at: row.completed_at || null,
    updated_at: row.updated_at || now(),
  };
}

function storeJob(row) {
  const key = row.dedupe_key || `__no_dedupe__:${row.id}`;
  const list = jobStore.get(key) || [];
  list.push(row);
  jobStore.set(key, list);
}

function findLatestJob({ ownerAdminId, dedupeKey, statuses, type = "aura_prediction_recalculate" }) {
  const list = jobStore.get(dedupeKey) || [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const job = list[index];
    if (Number(job.owner_admin_id) !== Number(ownerAdminId)) continue;
    if (job.type !== type) continue;
    if (!statuses.includes(job.status)) continue;
    return job;
  }
  return null;
}

async function handleQuery(sql, params = []) {
  calls.push({ sql, params });

  if (sql.includes("FROM prediction_results pr")) {
    const ownerAdminId = Number(params[0]);
    return {
      rows: [{
        id: `prediction-${ownerAdminId}`,
        run_id: `run-${ownerAdminId}`,
        target_type: "product",
        product_id: ownerAdminId === 202 ? 2021 : 1011,
        variant_id: null,
        prediction_date: "2026-07-21",
        horizon_days: 7,
        metric: "demand_units",
        predicted_value: ownerAdminId === 202 ? 28 : 14,
        lower_bound: ownerAdminId === 202 ? 20 : 10,
        upper_bound: ownerAdminId === 202 ? 36 : 18,
        confidence_score: 0.75,
        features_snapshot: {
          selectedModel: "seasonal_naive",
          modelVersion: "baseline_v1",
          featureVersion: "predictive_features_v1",
          current: { pendingPurchaseUnits: ownerAdminId === 202 ? 6 : 3 },
          metrics: { mae: 1, wape: 0.1, bias: 0, coverage: 0.85 },
          dailyForecast: [],
          reliable: true,
          coldStart: false,
          limitations: [],
          reason: "Baseline seleccionado por menor WAPE en backtesting.",
        },
        product_name: `Producto tenant ${ownerAdminId}`,
        variant_sku: null,
        created_at: "2026-07-14T00:00:00Z",
      }],
      rowCount: 1,
    };
  }

  if (sql.includes("FROM ai_jobs") && sql.includes("status IN ('queued', 'running')")) {
    const job = findLatestJob({
      ownerAdminId: params[0],
      dedupeKey: params[1],
      statuses: ["queued", "running"],
    });
    return { rows: job ? [jobRow(job)] : [], rowCount: job ? 1 : 0 };
  }

  if (sql.includes("FROM ai_jobs") && sql.includes("status IN ('running')")) {
    const job = findLatestJob({
      ownerAdminId: params[0],
      dedupeKey: params[1],
      statuses: ["running"],
    });
    return { rows: job ? [jobRow(job)] : [], rowCount: job ? 1 : 0 };
  }

  if (sql.includes("FROM ai_jobs") && sql.includes("status = 'completed'")) {
    const job = findLatestJob({
      ownerAdminId: params[0],
      dedupeKey: params[1],
      statuses: ["completed"],
    });
    return { rows: job ? [jobRow(job)] : [], rowCount: job ? 1 : 0 };
  }

  if (sql.includes("FROM ai_jobs") && sql.includes("status IN ('completed')")) {
    const job = findLatestJob({
      ownerAdminId: params[0],
      dedupeKey: params[1],
      statuses: ["completed"],
    });
    return { rows: job ? [jobRow(job)] : [], rowCount: job ? 1 : 0 };
  }

  if (sql.includes("INSERT INTO ai_jobs")) {
    const job = jobRow({
      id: params[0],
      owner_admin_id: params[1],
      user_id: params[2],
      type: "aura_prediction_recalculate",
      status: "queued",
      priority: 50,
      input: JSON.parse(params[3]),
      attempts: 0,
      max_attempts: 2,
      available_at: now(),
      dedupe_key: params[4],
      created_at: now(),
      updated_at: now(),
    });
    const duplicate = findLatestJob({
      ownerAdminId: job.owner_admin_id,
      dedupeKey: job.dedupe_key,
      statuses: ["queued", "running"],
      type: job.type,
    });
    if (duplicate) return { rows: [], rowCount: 0 };
    storeJob(job);
    return { rows: [job], rowCount: 1 };
  }

  throw new Error(`Unexpected forecasting query: ${sql.slice(0, 120)}`);
}

const fakeDb = {
  query: handleQuery,
  async connect() {
    return {
      query: handleQuery,
      release() {},
    };
  },
};

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: fakeDb,
};

const forecasting = require("../services/auraForecasting.service");

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function makeRows(values, start = "2026-01-01", extra = {}) {
  return values.map((units, index) => ({
    feature_date: addDays(start, index),
    units_sold: units,
    stockouts: 0,
    completeness_score: 1,
    pending_purchase_units: 0,
    ...extra,
  }));
}

test.beforeEach(() => {
  calls.length = 0;
  jobStore.clear();
});

test("stable series forecasts with explainable non-negative baseline", () => {
  const rows = makeRows(Array.from({ length: 60 }, () => 10));
  const forecast = forecasting.forecastSeries(rows, { horizon: 7 });

  assert.equal(forecast.coldStart, false);
  assert.equal(forecast.reliable, true);
  assert.equal(forecast.total, 70);
  assert.ok(forecast.lower >= 0);
  assert.ok(forecast.upper >= forecast.total);
});

test("trend series produces a high recent-demand forecast without LLM", () => {
  const rows = makeRows(Array.from({ length: 60 }, (_, index) => index + 1));
  const forecast = forecasting.forecastSeries(rows, { horizon: 7 });

  assert.equal(forecast.coldStart, false);
  assert.ok(forecast.total > 300);
  assert.ok(["naive", "moving_average", "weighted_average", "exponential_smoothing"].includes(forecast.selectedModel));
});

test("weekly seasonal series selects seasonal naive in backtesting", () => {
  const week = [2, 2, 2, 2, 2, 20, 25];
  const rows = makeRows(Array.from({ length: 8 }).flatMap(() => week));
  const forecast = forecasting.forecastSeries(rows, { horizon: 7 });

  assert.equal(forecast.selectedModel, "seasonal_naive");
  assert.equal(forecast.total, 55);
});

test("zero-demand days avoid MAPE and keep bands non-negative", () => {
  const values = Array.from({ length: 60 }, (_, index) => (index % 3 === 0 ? 5 : 0));
  const forecast = forecasting.forecastSeries(makeRows(values), { horizon: 14 });

  assert.equal(forecast.coldStart, false);
  assert.ok(forecast.backtests.every((metric) => !Object.prototype.hasOwnProperty.call(metric, "mape")));
  assert.ok(forecast.dailyForecast.every((row) => row.lower >= 0 && row.value >= 0));
});

test("cold start is explicit when history is insufficient", () => {
  const forecast = forecasting.forecastSeries(makeRows(Array.from({ length: 10 }, () => 5)), { horizon: 7 });

  assert.equal(forecast.coldStart, true);
  assert.equal(forecast.reliable, false);
  assert.match(forecast.limitations.join(" "), /cold start/i);
});

test("stockout limitation is carried into the forecast", () => {
  const rows = makeRows(Array.from({ length: 60 }, () => 8));
  rows[50].stockouts = 1;
  const forecast = forecasting.forecastSeries(rows, { horizon: 7 });

  assert.equal(forecast.reliable, true);
  assert.ok(forecast.limitations.some((item) => item.includes("stockouts")));
});

test("restock recommendation never suggests negative purchases and reports missing inputs", () => {
  const recommendation = forecasting.buildRestockRecommendation({
    forecast: { total: 10, horizon: 7 },
    leadTimeDays: null,
    safetyStock: 0,
    stockAvailable: 100,
    pendingPurchaseUnits: 5,
    moq: null,
  });

  assert.equal(recommendation.recommendedPurchaseUnits, 0);
  assert.equal(recommendation.isComplete, false);
  assert.deepEqual(recommendation.missing.sort(), ["lead_time_days", "moq"]);
});

test("saved demand forecasts are tenant-scoped", async () => {
  const tenantA = await forecasting.getDemandForecasts({ ownerAdminId: 101, query: { horizon: 7 } });
  const tenantB = await forecasting.getDemandForecasts({ ownerAdminId: 202, query: { horizon: 7 } });

  assert.equal(tenantA[0].productId, 1011);
  assert.equal(tenantB[0].productId, 2021);
  assert.equal(tenantA[0].predictedValue, 14);
  assert.equal(tenantB[0].predictedValue, 28);
  assert.deepEqual(calls.map((call) => call.params[0]), [101, 202]);
});

test("backtesting is reproducible for the same series", () => {
  const values = Array.from({ length: 8 }).flatMap(() => [1, 1, 1, 1, 1, 10, 12]);
  const rows = makeRows(values);
  const first = forecasting.forecastSeries(rows, { horizon: 30 });
  const second = forecasting.forecastSeries(rows, { horizon: 30 });

  assert.deepEqual(
    {
      selectedModel: first.selectedModel,
      total: first.total,
      metrics: first.metrics,
      backtests: first.backtests,
    },
    {
      selectedModel: second.selectedModel,
      total: second.total,
      metrics: second.metrics,
      backtests: second.backtests,
    }
  );
});

test("forecast recalculation jobs are idempotent by tenant and target", async () => {
  const first = await forecasting.enqueueForecastRecalculation({
    ownerAdminId: 101,
    userId: 11,
    payload: { productId: 99, horizons: [7, 14, 30] },
  });
  const second = await forecasting.enqueueForecastRecalculation({
    ownerAdminId: 101,
    userId: 11,
    payload: { productId: 99, horizons: [30, 14, 7] },
  });

  assert.equal(first.id, second.id);
  assert.equal(first.dedupe_key, second.dedupe_key);
  assert.equal(first.created, true);
  assert.equal(second.deduped, true);
  assert.equal(calls.some((call) => call.sql.includes("FROM ai_jobs")), true);
});

test("forecast recalculation jobs do not let completed rows block a new run", async () => {
  const dedupeKey = forecasting.forecastJobDedupeKey({
    ownerAdminId: 101,
    targetType: "product",
    productId: 99,
    horizons: [7, 14, 30],
  });

  storeJob(jobRow({
    id: "forecast-completed",
    owner_admin_id: 101,
    user_id: 11,
    type: "aura_prediction_recalculate",
    status: "completed",
    priority: 50,
    input: { ownerAdminId: 101, userId: 11, targetType: "product", productId: 99, horizons: [7, 14, 30] },
    output: { ok: true },
    attempts: 1,
    max_attempts: 2,
    dedupe_key: dedupeKey,
    completed_at: now(),
  }));

  const fresh = await forecasting.enqueueForecastRecalculation({
    ownerAdminId: 101,
    userId: 11,
    payload: { productId: 99, horizons: [7, 14, 30] },
  });

  assert.notEqual(fresh.id, "forecast-completed");
  assert.equal(fresh.created, true);
  assert.equal(fresh.deduped, false);
  assert.equal((jobStore.get(dedupeKey) || []).length, 2);
});

test("forecast recalculation cache can reuse a valid completed job explicitly", async () => {
  const dedupeKey = forecasting.forecastJobDedupeKey({
    ownerAdminId: 101,
    targetType: "product",
    productId: 88,
    horizons: [7, 14, 30],
  });

  storeJob(jobRow({
    id: "forecast-cache",
    owner_admin_id: 101,
    user_id: 11,
    type: "aura_prediction_recalculate",
    status: "completed",
    priority: 50,
    input: { ownerAdminId: 101, userId: 11, targetType: "product", productId: 88, horizons: [7, 14, 30] },
    output: { ok: true },
    attempts: 1,
    max_attempts: 2,
    dedupe_key: dedupeKey,
    completed_at: now(),
  }));

  const cached = await forecasting.enqueueForecastRecalculation({
    ownerAdminId: 101,
    userId: 11,
    payload: { productId: 88, horizons: [7, 14, 30], cache: true },
  });

  assert.equal(cached.cached, true);
  assert.equal(cached.created, false);
  assert.equal(cached.deduped, true);
  assert.equal(cached.id, "forecast-cache");
  assert.equal((jobStore.get(dedupeKey) || []).length, 1);
});

test("forecast recalculation force creates a new job after completed rows", async () => {
  const dedupeKey = forecasting.forecastJobDedupeKey({
    ownerAdminId: 101,
    targetType: "product",
    productId: 77,
    horizons: [7, 14, 30],
  });

  storeJob(jobRow({
    id: "forecast-completed-force",
    owner_admin_id: 101,
    user_id: 11,
    type: "aura_prediction_recalculate",
    status: "completed",
    priority: 50,
    input: { ownerAdminId: 101, userId: 11, targetType: "product", productId: 77, horizons: [7, 14, 30] },
    output: { ok: true },
    attempts: 1,
    max_attempts: 2,
    dedupe_key: dedupeKey,
    completed_at: now(),
  }));

  const forced = await forecasting.enqueueForecastRecalculation({
    ownerAdminId: 101,
    userId: 11,
    payload: { productId: 77, horizons: [7, 14, 30], force: true },
  });

  assert.equal(forced.forced, true);
  assert.equal(forced.deduped, false);
  assert.equal(forced.created, true);
  assert.notEqual(forced.dedupe_key, dedupeKey);
  assert.equal((jobStore.get(dedupeKey) || []).length, 1);
});

test("forecast recalculation fails over failed and cancelled rows without blocking retries", async () => {
  const failedKey = forecasting.forecastJobDedupeKey({
    ownerAdminId: 101,
    targetType: "product",
    productId: 66,
    horizons: [7, 14, 30],
  });
  storeJob(jobRow({
    id: "forecast-failed",
    owner_admin_id: 101,
    user_id: 11,
    type: "aura_prediction_recalculate",
    status: "failed",
    priority: 50,
    input: { ownerAdminId: 101, userId: 11, targetType: "product", productId: 66, horizons: [7, 14, 30] },
    output: {},
    attempts: 2,
    max_attempts: 2,
    dedupe_key: failedKey,
    completed_at: now(),
  }));

  const retryFailed = await forecasting.enqueueForecastRecalculation({
    ownerAdminId: 101,
    userId: 11,
    payload: { productId: 66, horizons: [7, 14, 30] },
  });

  assert.equal(retryFailed.created, true);
  assert.notEqual(retryFailed.id, "forecast-failed");

  const cancelledKey = forecasting.forecastJobDedupeKey({
    ownerAdminId: 101,
    targetType: "product",
    productId: 65,
    horizons: [7, 14, 30],
  });
  storeJob(jobRow({
    id: "forecast-cancelled",
    owner_admin_id: 101,
    user_id: 11,
    type: "aura_prediction_recalculate",
    status: "cancelled",
    priority: 50,
    input: { ownerAdminId: 101, userId: 11, targetType: "product", productId: 65, horizons: [7, 14, 30] },
    output: {},
    attempts: 1,
    max_attempts: 2,
    dedupe_key: cancelledKey,
    completed_at: now(),
  }));

  const retryCancelled = await forecasting.enqueueForecastRecalculation({
    ownerAdminId: 101,
    userId: 11,
    payload: { productId: 65, horizons: [7, 14, 30] },
  });

  assert.equal(retryCancelled.created, true);
  assert.notEqual(retryCancelled.id, "forecast-cancelled");
});

test("forecast recalculation jobs stay tenant-scoped with identical payloads", async () => {
  const tenantA = await forecasting.enqueueForecastRecalculation({
    ownerAdminId: 101,
    userId: 11,
    payload: { productId: 99, horizons: [7, 14, 30] },
  });
  const tenantB = await forecasting.enqueueForecastRecalculation({
    ownerAdminId: 202,
    userId: 22,
    payload: { productId: 99, horizons: [7, 14, 30] },
  });

  assert.notEqual(tenantA.id, tenantB.id);
  assert.notEqual(tenantA.dedupe_key, tenantB.dedupe_key);
  assert.equal(tenantA.owner_admin_id, 101);
  assert.equal(tenantB.owner_admin_id, 202);
});
