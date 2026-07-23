const test = require("node:test");
const assert = require("node:assert/strict");

const dbPath = require.resolve("../src/platform/database");
const calls = [];
const runs = [];
const snapshots = [];
let inputRows = [];
let forcedError = null;

function asNumber(value) {
  return Number(value || 0);
}

function aggregateSnapshots(runId, ownerAdminId, key) {
  const grouped = new Map();
  for (const row of snapshots.filter((item) => item.run_id === runId && Number(item.owner_admin_id) === Number(ownerAdminId))) {
    const groupKey = row[key];
    if (!grouped.has(groupKey)) grouped.set(groupKey, []);
    grouped.get(groupKey).push(row);
  }
  return [...grouped.entries()].map(([level, rows]) => {
    const count = rows.length || 1;
    return {
      segment_key: key === "segment_key" ? level : undefined,
      segment_label: key === "segment_key" ? rows[0].segment_label : undefined,
      level,
      customers: rows.length,
      avg_recency_days: rows.reduce((sum, row) => sum + asNumber(row.recency_days), 0) / count,
      avg_frequency: rows.reduce((sum, row) => sum + asNumber(row.frequency), 0) / count,
      avg_monetary: rows.reduce((sum, row) => sum + asNumber(row.monetary), 0) / count,
      total_monetary: rows.reduce((sum, row) => sum + asNumber(row.monetary), 0),
      avg_churn_score: rows.reduce((sum, row) => sum + asNumber(row.churn_score), 0) / count,
      avg_repurchase_score: rows.reduce((sum, row) => sum + asNumber(row.repurchase_score), 0) / count,
      avg_score: rows.reduce((sum, row) => sum + asNumber(key === "repurchase_level" ? row.repurchase_score : row.churn_score), 0) / count,
      email_consented: rows.filter((row) => row.consent_summary?.email === "granted").length,
      whatsapp_consented: rows.filter((row) => row.consent_summary?.whatsapp === "granted").length,
      push_consented: rows.filter((row) => row.consent_summary?.push === "granted").length,
    };
  });
}

async function handleQuery(sql, params = []) {
  calls.push({ sql, params });
  if (forcedError) throw forcedError;

  if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };

  if (sql.includes("FROM aura_customer_segment_runs") && sql.includes("LIMIT 1")) {
    const row = runs
      .filter((item) =>
        Number(item.owner_admin_id) === Number(params[0])
        && item.as_of_date === params[1]
        && item.segment_version === params[2]
        && item.status === "completed"
      )
      .at(-1);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }

  if (sql.includes("INSERT INTO aura_customer_segment_runs")) {
    runs.push({
      id: params[0],
      owner_admin_id: Number(params[1]),
      as_of_date: params[2],
      segment_version: params[3],
      status: "running",
      rows_count: 0,
      created_at: "2026-07-14T00:00:00Z",
      completed_at: null,
    });
    return { rows: [], rowCount: 1 };
  }

  if (sql.includes("WITH valid_sales AS")) {
    return {
      rows: inputRows.filter((row) => Number(row.owner_admin_id) === Number(params[0])),
      rowCount: inputRows.length,
    };
  }

  if (sql.includes("INSERT INTO aura_customer_segment_snapshots")) {
    snapshots.push({
      run_id: params[0],
      owner_admin_id: Number(params[1]),
      customer_id: Number(params[2]),
      as_of_date: params[3],
      segment_version: params[4],
      segment_key: params[5],
      segment_label: params[6],
      recency_days: params[7],
      frequency: params[8],
      monetary: params[9],
      recency_score: params[10],
      frequency_score: params[11],
      monetary_score: params[12],
      rfm_score: params[13],
      habitual_repurchase_days: params[14],
      days_overdue: params[15],
      churn_score: params[16],
      churn_level: params[17],
      repurchase_score: params[18],
      repurchase_level: params[19],
      trend_label: params[20],
      primary_product_id: params[21],
      primary_category_id: params[22],
      factors: JSON.parse(params[23]),
      data_used: JSON.parse(params[24]),
      limitations: JSON.parse(params[25]),
      consent_summary: JSON.parse(params[26]),
      example_key: params[27],
      created_at: "2026-07-14T00:00:00Z",
    });
    return { rows: [], rowCount: 1 };
  }

  if (sql.includes("UPDATE aura_customer_segment_runs")) {
    const run = runs.find((item) => item.id === params[0]);
    if (run) {
      run.status = "completed";
      run.rows_count = Number(params[1]);
      run.data_quality = JSON.parse(params[2]);
      run.completed_at = "2026-07-14T00:01:00Z";
    }
    return { rows: [], rowCount: run ? 1 : 0 };
  }

  if (sql.includes("GROUP BY segment_key")) {
    return { rows: aggregateSnapshots(params[0], params[1], "segment_key"), rowCount: snapshots.length };
  }

  if (sql.includes("GROUP BY churn_level")) {
    return { rows: aggregateSnapshots(params[0], params[1], "churn_level"), rowCount: snapshots.length };
  }

  if (sql.includes("GROUP BY repurchase_level")) {
    return { rows: aggregateSnapshots(params[0], params[1], "repurchase_level"), rowCount: snapshots.length };
  }

  if (sql.includes("FROM aura_customer_segment_snapshots") && sql.includes("ORDER BY")) {
    return {
      rows: snapshots
        .filter((row) => row.run_id === params[0] && Number(row.owner_admin_id) === Number(params[1]))
        .slice(0, Number(params.at(-2) || 50)),
      rowCount: snapshots.length,
    };
  }

  throw new Error(`Unexpected customer growth query: ${sql.slice(0, 120)}`);
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

const customerGrowth = require("../services/auraCustomerGrowth.service");
const customerController = require("../src/modules/aura/controllers/customers.controller");

function row(overrides) {
  return {
    owner_admin_id: 101,
    customer_id: 41,
    first_purchase_at: "2026-07-10",
    last_purchase_at: "2026-07-10",
    frequency: 1,
    monetary: 100000,
    recent_90_count: 1,
    previous_90_count: 0,
    habitual_repurchase_days: null,
    primary_product_id: 10,
    primary_category_id: 3,
    consent_summary: { email: "granted" },
    ...overrides,
  };
}

test.beforeEach(() => {
  calls.length = 0;
  runs.length = 0;
  snapshots.length = 0;
  inputRows = [];
  forcedError = null;
});

test("cliente nuevo queda marcado como nuevo y sin certeza de abandono", () => {
  const scored = customerGrowth.scoreCustomerGrowth(row({ customer_id: 41 }), {
    ownerAdminId: 101,
    asOfDate: "2026-07-14",
    recencies: [4, 20, 220],
    frequencies: [1, 5, 2],
    monetaries: [100000, 900000, 120000],
  });

  assert.equal(scored.segmentKey, "nuevos");
  assert.equal(scored.churnLevel, "bajo");
  assert.equal(scored.limitations.some((item) => item.includes("Historial insuficiente")), true);
});

test("cliente recurrente puede quedar como campeon o leal con recompra alta", () => {
  const scored = customerGrowth.scoreCustomerGrowth(row({
    customer_id: 42,
    first_purchase_at: "2026-01-01",
    last_purchase_at: "2026-07-10",
    frequency: 7,
    monetary: 950000,
    recent_90_count: 4,
    previous_90_count: 3,
    habitual_repurchase_days: 28,
  }), {
    ownerAdminId: 101,
    asOfDate: "2026-07-14",
    recencies: [4, 4, 220],
    frequencies: [1, 7, 2],
    monetaries: [100000, 950000, 120000],
  });

  assert.ok(["campeones", "leales"].includes(scored.segmentKey));
  assert.equal(scored.repurchaseLevel, "alta");
  assert.notEqual(scored.churnLevel, "critico");
});

test("cliente dormido queda en riesgo alto sin afirmar certeza", () => {
  const scored = customerGrowth.scoreCustomerGrowth(row({
    customer_id: 43,
    first_purchase_at: "2025-08-01",
    last_purchase_at: "2025-11-01",
    frequency: 3,
    monetary: 220000,
    recent_90_count: 0,
    previous_90_count: 0,
    habitual_repurchase_days: 35,
  }), {
    ownerAdminId: 101,
    asOfDate: "2026-07-14",
    recencies: [4, 20, 255],
    frequencies: [1, 5, 3],
    monetaries: [100000, 950000, 220000],
  });

  assert.equal(scored.segmentKey, "dormidos");
  assert.ok(["alto", "critico"].includes(scored.churnLevel));
  assert.equal(scored.limitations.some((item) => item.includes("probabilidad calibrada")), true);
});

test("tenant sin historial devuelve agregados vacios y snapshot trazable", async () => {
  const result = await customerGrowth.getCustomerSegments({
    ownerAdminId: 303,
    userId: 30,
    roles: ["gerente"],
    query: { asOfDate: "2026-07-14" },
  });

  assert.equal(result.totals.customers, 0);
  assert.equal(result.segments.length, 0);
  assert.equal(runs[0].owner_admin_id, 303);
  assert.equal(runs[0].rows_count, 0);
  const salesQuery = calls.find((call) => call.sql.includes("WITH valid_sales AS"));
  assert.ok(salesQuery);
  assert.doesNotMatch(salesQuery.sql, /\bs\.status\b/);
  assert.match(salesQuery.sql, /s\.payment_status = 'paid'/);
  assert.match(salesQuery.sql, /s\.delivery_status::text/);
  assert.deepEqual(salesQuery.params, [303, "2026-07-14"]);
});

test("snapshots y agregados quedan aislados por tenant", async () => {
  inputRows = [
    row({ owner_admin_id: 101, customer_id: 41, monetary: 100000 }),
    row({ owner_admin_id: 202, customer_id: 51, monetary: 500000, consent_summary: { whatsapp: "granted" } }),
  ];

  const tenantA = await customerGrowth.getCustomerSegments({
    ownerAdminId: 101,
    userId: 11,
    roles: ["admin"],
    query: { asOfDate: "2026-07-14", detail: "true" },
  });
  const tenantB = await customerGrowth.getCustomerSegments({
    ownerAdminId: 202,
    userId: 22,
    roles: ["admin"],
    query: { asOfDate: "2026-07-14", detail: "true" },
  });

  assert.equal(tenantA.detail[0].customerId, 41);
  assert.equal(tenantB.detail[0].customerId, 51);
  assert.equal(snapshots.every((item) => item.owner_admin_id === 101 || item.owner_admin_id === 202), true);
  assert.equal(calls.some((call) => call.sql.includes("page_views")), false);
});

test("detalle individual requiere admin", async () => {
  inputRows = [row({ owner_admin_id: 101, customer_id: 41 })];

  await assert.rejects(
    () => customerGrowth.getCustomerSegments({
      ownerAdminId: 101,
      userId: 12,
      roles: ["gerente"],
      query: { asOfDate: "2026-07-14", detail: "true" },
    }),
    /requiere rol admin/
  );
});

test("error SQL devuelve 500 estable sin exponer detalles internos", async () => {
  forcedError = Object.assign(
    new Error('column "s.status" does not exist'),
    { code: "42703", detail: "Undefined column" }
  );
  const req = {
    id: "req-customer-segments-error",
    auraAdminId: 101,
    user: { id: 11, roles: ["admin"] },
    query: { ownerAdminId: 202 },
  };
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };

  await customerController.getSegments(req, res);

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, {
    success: false,
    message: "Error procesando analitica de clientes AURA",
    code: "AURA_CUSTOMER_GROWTH_ERROR",
    requestId: "req-customer-segments-error",
  });
  assert.doesNotMatch(JSON.stringify(res.body), /s\.status|42703|Undefined column/i);
  assert.equal(calls[0].params[0], 101);
  assert.match(calls[0].params[1], /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(calls[0].params[2], customerGrowth.CUSTOMER_GROWTH_VERSION);
  assert.equal(calls[0].params.includes(202), false);
});
