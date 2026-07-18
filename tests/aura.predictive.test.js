const test = require("node:test");
const assert = require("node:assert/strict");

const dbPath = require.resolve("../config/db");
const calls = [];

async function handleQuery(sql, params = []) {
  calls.push({ sql, params });

  if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
    return { rows: [], rowCount: 0 };
  }
  if (sql.includes("pg_try_advisory_xact_lock")) {
    return { rows: [{ locked: true }], rowCount: 1 };
  }
  if (sql.includes("information_schema.tables")) {
    return { rows: [{ exists: false }], rowCount: 1 };
  }
  if (sql.includes("INSERT INTO prediction_runs")) {
    return { rows: [], rowCount: 1 };
  }
  if (sql.includes("INSERT INTO daily_product_features")) {
    return { rows: [{ product_id: 1 }, { product_id: 2 }], rowCount: 2 };
  }
  if (sql.includes("INSERT INTO daily_variant_features")) {
    return { rows: [{ variant_id: 10 }], rowCount: 1 };
  }
  if (sql.includes("INSERT INTO daily_store_features")) {
    return { rows: [{ owner_admin_id: params[0] }], rowCount: 1 };
  }
  if (sql.includes("WITH sales_scope AS")) {
    return {
      rows: [{
        sales_count: 4,
        sale_items_count: 5,
        duplicate_sale_item_groups: 0,
        sale_item_anomalies: 0,
        products_missing_cost: 0,
        products_missing_lead_time: 0,
        negative_stock_events: 0,
        purchase_overreceived_items: 0,
      }],
      rowCount: 1,
    };
  }
  if (sql.includes("UPDATE prediction_runs")) {
    return { rows: [], rowCount: 1 };
  }

  throw new Error(`Unexpected query: ${sql.slice(0, 140)}`);
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

const predictive = require("../services/auraPredictiveFeatures.service");
const jobs = require("../services/auraPredictive.jobs");

test.beforeEach(() => {
  calls.length = 0;
});

test("manual product feature calculation excludes cancelled sales and allocates discounts", () => {
  const feature = predictive.buildProductFeatureSnapshot({
    ownerAdminId: 101,
    featureDate: "2026-07-14",
    product: {
      id: 1,
      owner_admin_id: 101,
      sale_price: 100,
      purchase_price: 60,
      stock: 5,
      stock_reserved: 1,
      stock_safety: 1,
      supplier_lead_time_days: 7,
    },
    sales: [
      { id: 1, owner_admin_id: 101, sale_date: "2026-07-14", subtotal: 200, discount_amount: 20, tax_amount: 38, payment_status: "paid", status: "completed", delivery_status: "delivered" },
      { id: 2, owner_admin_id: 101, sale_date: "2026-07-10", subtotal: 100, discount_amount: 0, tax_amount: 0, payment_status: "paid", status: "completed", delivery_status: "delivered" },
      { id: 3, owner_admin_id: 101, sale_date: "2026-07-01", subtotal: 50, discount_amount: 0, tax_amount: 0, payment_status: "paid", status: "completed", delivery_status: "delivered" },
      { id: 4, owner_admin_id: 101, sale_date: "2026-07-14", subtotal: 100, discount_amount: 0, tax_amount: 0, payment_status: "cancelled", status: "cancelled", delivery_status: "cancelled" },
      { id: 5, owner_admin_id: 202, sale_date: "2026-07-14", subtotal: 999, discount_amount: 0, tax_amount: 0, payment_status: "paid", status: "completed", delivery_status: "delivered" },
    ],
    saleItems: [
      { sale_id: 1, product_id: 1, quantity: 2, subtotal: 200, total_profit: 80 },
      { sale_id: 2, product_id: 1, quantity: 1, subtotal: 100, total_profit: 40 },
      { sale_id: 3, product_id: 1, quantity: 1, subtotal: 50, total_profit: 20 },
      { sale_id: 4, product_id: 1, quantity: 1, subtotal: 100, total_profit: 40 },
      { sale_id: 5, product_id: 1, quantity: 9, subtotal: 999, total_profit: 999 },
    ],
    stockLedger: [
      { owner_admin_id: 101, product_id: 1, movement_type: "sale_confirmed", qty_delta: -2, qty_before: 6, qty_after: 4, created_at: "2026-07-14T09:00:00Z" },
      { owner_admin_id: 101, product_id: 1, movement_type: "return", qty_delta: 1, qty_before: 4, qty_after: 5, created_at: "2026-07-14T15:00:00Z" },
    ],
    purchaseOrderItems: [
      { product_id: 1, quantity: 5, received_quantity: 2 },
    ],
    campaignEvents: [
      { owner_admin_id: 101, product_id: 1, occurred_at: "2026-07-14T12:00:00Z" },
      { owner_admin_id: 202, product_id: 1, occurred_at: "2026-07-14T12:00:00Z" },
    ],
  });

  assert.equal(feature.unitsSold, 2);
  assert.equal(feature.grossRevenue, 200);
  assert.equal(feature.discountsAllocated, 20);
  assert.equal(feature.netRevenue, 180);
  assert.equal(feature.estimatedMargin, 80);
  assert.equal(feature.cancelledUnits, 1);
  assert.equal(feature.returnsUnits, 1);
  assert.equal(feature.stockInitial, 6);
  assert.equal(feature.stockFinal, 5);
  assert.equal(feature.stockAvailableFinal, 3);
  assert.equal(feature.rollingUnits7, 3);
  assert.equal(feature.rollingUnits90, 4);
  assert.equal(feature.pendingPurchaseUnits, 3);
  assert.equal(feature.campaignEventsCount, 1);
  assert.equal(feature.isDataSufficient, true);
});

test("date range validation blocks unsafe historical rebuilds", () => {
  assert.deepEqual(predictive.eachDateInRange("2026-07-12", "2026-07-14"), [
    "2026-07-12",
    "2026-07-13",
    "2026-07-14",
  ]);
  assert.throws(
    () => predictive.eachDateInRange("2026-07-14", "2026-07-12"),
    /dateFrom no puede ser posterior/
  );
});

test("rebuildPredictiveFeatures is tenant-scoped, transactional and audited", async () => {
  const result = await predictive.rebuildPredictiveFeatures({
    ownerAdminId: 101,
    dateFrom: "2026-07-13",
    dateTo: "2026-07-14",
    userId: 11,
  });

  assert.equal(result.ownerAdminId, 101);
  assert.equal(result.rowsCount, 8);
  assert.equal(result.dataQuality.sales_count, 4);
  assert.ok(calls.some((call) => call.sql === "BEGIN"));
  assert.ok(calls.some((call) => call.sql === "COMMIT"));
  assert.ok(calls.some((call) => call.sql.includes("pg_try_advisory_xact_lock") && call.params[0].includes("101")));
  assert.ok(calls.filter((call) => call.sql.includes("INSERT INTO daily_product_features")).every((call) => call.params[0] === 101));
});

test("predictive daily job stays disabled unless explicitly enabled", () => {
  delete process.env.AURA_PREDICTIVE_JOBS_ENABLED;
  assert.equal(jobs.predictiveJobsEnabled(), false);
});
