const test = require("node:test");
const assert = require("node:assert/strict");

const dbPath = require.resolve("../config/db");
const calls = [];
let forcedProductFeatureError = null;

function referencedColumns(sql, alias) {
  const matches = String(sql).matchAll(new RegExp(`\\b${alias}\\.([a-z_][a-z0-9_]*)`, "gi"));
  return [...new Set([...matches].map((match) => match[1].toLowerCase()))].sort();
}

function columnSet(columns) {
  return new Set(String(columns).trim().split(/\s+/));
}

function insertedColumns(sql, tableName) {
  const match = String(sql).match(
    new RegExp(`\\bINSERT\\s+INTO\\s+${tableName}\\s*\\(([^)]+)\\)`, "i")
  );
  return match
    ? match[1].split(",").map((column) => column.trim().toLowerCase()).filter(Boolean)
    : [];
}

const VERIFIED_SCHEMA_COLUMNS = Object.freeze({
  sales: columnSet(`
    id sale_number customer_id sale_date subtotal tax_amount discount_amount total
    payment_method payment_status sale_type created_by created_at shipping_address
    shipping_city shipping_notes shipping_lat shipping_lng customer_phone payment_proof_url
    payment_proof_uploaded_at credit_due_date credit_notes amount_paid owner_admin_id
    discount_id procurement_status delivery_status delivered_at revenue_recognized_at
    estimated_delivery_date has_on_demand_items updated_at
  `),
  sale_items: columnSet(`
    id sale_id product_id quantity unit_price unit_cost subtotal discount_amount profit_per_unit
    total_profit created_at original_unit_price discount_percentage discount_id notes variant_id
    fulfillment_mode_snapshot supplier_cost_at_sale actual_supplier_cost estimated_delivery_date
    item_delivery_status delivered_at
  `),
  products: columnSet(`
    id name sku description category_id stock min_stock max_stock purchase_price sale_price
    markup_percentage is_active created_at updated_at markup_type markup_value has_variants
    is_bundle bundle_price created_by owner_admin_id stock_reserved stock_safety fulfillment_mode
    default_supplier_id supplier_lead_time_days supplier_cost_estimate requires_advance_payment
    auto_send_to_supplier
  `),
  product_variants: columnSet(`
    id product_id sku sale_price stock is_active created_at updated_at stock_reserved stock_safety
  `),
  stock_ledger: columnSet(`
    id product_id variant_id movement_type qty_delta qty_before qty_after reference_id
    reference_type notes created_by created_at owner_admin_id
  `),
  procurement_orders: columnSet(`
    id owner_admin_id sale_id sale_item_id product_id variant_id supplier_id purchase_order_id
    quantity estimated_unit_cost actual_unit_cost estimated_total actual_total status
    expected_delivery_date ordered_at received_at cancelled_at cancellation_reason notes
    created_by created_at updated_at
  `),
  purchase_orders: columnSet(`
    id order_number provider_id order_date expected_delivery_date received_date status subtotal
    tax_amount shipping_cost discount_amount total_cost payment_method payment_status notes
    created_by approved_by approved_at created_at updated_at owner_admin_id
  `),
  purchase_order_items: columnSet(`
    id purchase_order_id product_id quantity unit_cost subtotal suggested_sale_price
    markup_percentage expected_profit_per_unit expected_total_profit received_quantity notes
    created_at
  `),
  providers: columnSet(`
    id name category phone email address contact_person tax_id balance credit_limit
    payment_terms_days reliability_score lead_time_days is_active notes created_at updated_at
    created_by owner_admin_id
  `),
  campaign_events: columnSet(`
    id campaign_id owner_admin_id campaign_recipient_id recipient_user_id event_type
    external_event_id occurred_at metadata created_at
  `),
  marketing_campaigns: columnSet(`
    id owner_admin_id name objective channel status segment_id discount_id created_by approved_by
    scheduled_at started_at completed_at budget currency source_type ai_generated created_at updated_at
  `),
  campaign_assets: columnSet(`
    id owner_admin_id campaign_id product_id variant_id asset_type source status original_asset_url
    generated_asset_url cloudinary_public_id width height format prompt prompt_version model
    moderation_status metadata created_by created_at updated_at deleted_at
  `),
  daily_product_features: columnSet(`
    owner_admin_id feature_date product_id feature_version calculation_run_id units_sold
    gross_revenue net_revenue discounts_allocated tax_allocated returns_units
    returns_value_estimated cancelled_units estimated_margin stock_initial stock_final
    stock_reserved_final stock_available_final stockouts days_without_sale rolling_units_7
    rolling_units_14 rolling_units_30 rolling_units_90 rolling_revenue_7 rolling_revenue_14
    rolling_revenue_30 rolling_revenue_90 avg_units_30 median_units_30 stddev_units_30
    trend_units_30 day_of_week month campaign_events_count price price_changed lead_time_days
    pending_purchase_units is_data_sufficient completeness_score duplicate_sale_items_count
    anomaly_count data_quality source_fingerprint first_calculated_at last_calculated_at
    recalculation_count created_at updated_at
  `),
  daily_variant_features: columnSet(`
    owner_admin_id feature_date product_id variant_id feature_version calculation_run_id units_sold
    gross_revenue net_revenue discounts_allocated tax_allocated returns_units
    returns_value_estimated cancelled_units estimated_margin stock_initial stock_final
    stock_reserved_final stock_available_final stockouts days_without_sale rolling_units_7
    rolling_units_14 rolling_units_30 rolling_units_90 rolling_revenue_7 rolling_revenue_14
    rolling_revenue_30 rolling_revenue_90 avg_units_30 median_units_30 stddev_units_30
    trend_units_30 day_of_week month campaign_events_count price price_changed lead_time_days
    pending_purchase_units is_data_sufficient completeness_score duplicate_sale_items_count
    anomaly_count data_quality source_fingerprint first_calculated_at last_calculated_at
    recalculation_count created_at updated_at
  `),
  daily_store_features: columnSet(`
    owner_admin_id feature_date feature_version calculation_run_id units_sold gross_revenue
    net_revenue discounts_allocated tax_allocated returns_units cancelled_units estimated_margin
    active_products_count products_with_sales_count products_stockout_count pending_purchase_units
    campaign_events_count day_of_week month is_data_sufficient completeness_score
    duplicate_sale_items_count anomaly_count data_quality source_fingerprint first_calculated_at
    last_calculated_at recalculation_count created_at updated_at
  `),
});

const PHYSICAL_ALIAS_TABLES = Object.freeze({
  s: "sales",
  si: "sale_items",
  p: "products",
  pv: "product_variants",
  sl: "stock_ledger",
  pro: "procurement_orders",
  po: "purchase_orders",
  poi: "purchase_order_items",
  pr: "providers",
  ce: "campaign_events",
  mc: "marketing_campaigns",
  ca: "campaign_assets",
  dpf: "daily_product_features",
});

const DERIVED_ALIAS_COLUMNS = Object.freeze({
  vs: columnSet("id sale_day subtotal discount_amount tax_amount"),
  pb: columnSet(`
    owner_admin_id product_id sale_price purchase_price stock stock_reserved stock_safety
    lead_time_days
  `),
  vb: columnSet(`
    owner_admin_id product_id variant_id price purchase_price stock stock_reserved stock_safety
    lead_time_days
  `),
  sd: columnSet(`
    product_id variant_id sale_day units_sold gross_revenue discounts_allocated tax_allocated
    net_revenue estimated_margin
  `),
  rd: columnSet("product_id variant_id returns_units"),
  cd: columnSet("product_id variant_id cancelled_units"),
  ld: columnSet("product_id variant_id stock_initial stock_final_from_ledger stockouts"),
  di: columnSet("product_id duplicate_sale_items_count"),
  an: columnSet("product_id anomaly_count"),
  pp: columnSet("product_id variant_id pending_purchase_units"),
  ced: columnSet("product_id campaign_events_count"),
  x: columnSet(`
    product_id variant_id sale_day units_sold gross_revenue discounts_allocated tax_allocated
    net_revenue estimated_margin
  `),
  last_sale: columnSet("last_sale_day"),
  f: columnSet(`
    owner_admin_id feature_date product_id variant_id feature_version calculation_run_id
    units_sold gross_revenue net_revenue discounts_allocated tax_allocated returns_units
    returns_value_estimated cancelled_units estimated_margin stock_initial stock_final
    stock_reserved_final stock_available_final stockouts days_without_sale rolling_units_7
    rolling_units_14 rolling_units_30 rolling_units_90 rolling_revenue_7 rolling_revenue_14
    rolling_revenue_30 rolling_revenue_90 avg_units_30 median_units_30 stddev_units_30
    trend_units_30 day_of_week month campaign_events_count price price_changed lead_time_days
    pending_purchase_units duplicate_sale_items_count anomaly_count data_quality
  `),
});

function assertPhysicalAliasContract(sql) {
  for (const [alias, tableName] of Object.entries(PHYSICAL_ALIAS_TABLES)) {
    const unexpected = referencedColumns(sql, alias)
      .filter((column) => !VERIFIED_SCHEMA_COLUMNS[tableName].has(column));
    assert.deepEqual(
      unexpected,
      [],
      `Unexpected ${alias} (${tableName}) columns: ${unexpected.join(", ")}`
    );
  }
}

function assertDerivedAliasContract(sql) {
  for (const [alias, columns] of Object.entries(DERIVED_ALIAS_COLUMNS)) {
    const unexpected = referencedColumns(sql, alias)
      .filter((column) => !columns.has(column));
    assert.deepEqual(
      unexpected,
      [],
      `Unexpected derived alias ${alias} columns: ${unexpected.join(", ")}`
    );
  }
}

async function handleQuery(sql, params = []) {
  calls.push({ sql, params });

  if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
    return { rows: [], rowCount: 0 };
  }
  if (sql.includes("pg_try_advisory_xact_lock")) {
    return { rows: [{ locked: true }], rowCount: 1 };
  }
  if (sql.includes("information_schema.tables")) {
    return { rows: [{ exists: true }], rowCount: 1 };
  }
  if (sql.includes("SELECT DISTINCT u.id")) {
    return {
      rows: params[0] === null || params[0] === undefined
        ? [{ id: 101 }, { id: 202 }]
        : [{ id: Number(params[0]) }],
      rowCount: params[0] === null || params[0] === undefined ? 2 : 1,
    };
  }
  if (sql.includes("INSERT INTO prediction_runs")) {
    return { rows: [], rowCount: 1 };
  }
  if (sql.includes("INSERT INTO daily_product_features")) {
    if (forcedProductFeatureError) throw forcedProductFeatureError;
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
  forcedProductFeatureError = null;
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
      { id: 1, owner_admin_id: 101, sale_date: "2026-07-14", subtotal: 200, discount_amount: 20, tax_amount: 38, payment_status: "paid", delivery_status: "delivered" },
      { id: 2, owner_admin_id: 101, sale_date: "2026-07-10", subtotal: 100, discount_amount: 0, tax_amount: 0, payment_status: "paid", delivery_status: "delivered" },
      { id: 3, owner_admin_id: 101, sale_date: "2026-07-01", subtotal: 50, discount_amount: 0, tax_amount: 0, payment_status: "paid", delivery_status: "delivered" },
      { id: 4, owner_admin_id: 101, sale_date: "2026-07-14", subtotal: 100, discount_amount: 0, tax_amount: 0, payment_status: "pending", delivery_status: "cancelled" },
      { id: 5, owner_admin_id: 202, sale_date: "2026-07-14", subtotal: 999, discount_amount: 0, tax_amount: 0, payment_status: "paid", delivery_status: "delivered" },
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

test("manual features are stable with no sales, pending sales and real cancellation columns", () => {
  const base = {
    ownerAdminId: 101,
    featureDate: "2026-07-14",
    product: {
      id: 1,
      owner_admin_id: 101,
      sale_price: 100,
      purchase_price: 60,
      stock: 5,
      stock_reserved: 0,
      stock_safety: 0,
      supplier_lead_time_days: 7,
    },
  };

  const empty = predictive.buildProductFeatureSnapshot(base);
  assert.equal(empty.unitsSold, 0);
  assert.equal(empty.cancelledUnits, 0);

  const pending = predictive.buildProductFeatureSnapshot({
    ...base,
    sales: [{
      id: 10,
      owner_admin_id: 101,
      sale_date: "2026-07-14",
      subtotal: 100,
      discount_amount: 0,
      payment_status: "pending",
      delivery_status: "pending",
    }],
    saleItems: [{ sale_id: 10, product_id: 1, quantity: 1, subtotal: 100 }],
  });
  assert.equal(pending.unitsSold, 0);
  assert.equal(pending.cancelledUnits, 0);

  const deliveryCancelled = predictive.buildProductFeatureSnapshot({
    ...base,
    sales: [{
      id: 11,
      owner_admin_id: 101,
      sale_date: "2026-07-14",
      subtotal: 100,
      discount_amount: 0,
      payment_status: "partial",
      delivery_status: "cancelled",
    }],
    saleItems: [{ sale_id: 11, product_id: 1, quantity: 2, subtotal: 100 }],
  });
  assert.equal(deliveryCancelled.unitsSold, 0);
  assert.equal(deliveryCancelled.cancelledUnits, 2);
  assert.equal(predictive.isCancelledSale({
    payment_status: "partial",
    delivery_status: "pending",
  }), false);
});

test("product snapshots aggregate items with and without variants without crossing tenants", () => {
  const feature = predictive.buildProductFeatureSnapshot({
    ownerAdminId: 101,
    featureDate: "2026-07-14",
    product: {
      id: 1,
      owner_admin_id: 101,
      sale_price: 100,
      purchase_price: 60,
      stock: 9,
      stock_reserved: 0,
      stock_safety: 0,
      supplier_lead_time_days: 7,
    },
    sales: [
      {
        id: 20,
        owner_admin_id: 101,
        sale_date: "2026-07-14",
        subtotal: 300,
        discount_amount: 0,
        payment_status: "paid",
        delivery_status: "delivered",
      },
      {
        id: 21,
        owner_admin_id: 202,
        sale_date: "2026-07-14",
        subtotal: 900,
        discount_amount: 0,
        payment_status: "paid",
        delivery_status: "delivered",
      },
    ],
    saleItems: [
      { sale_id: 20, product_id: 1, variant_id: null, quantity: 1, subtotal: 100 },
      { sale_id: 20, product_id: 1, variant_id: 12, quantity: 2, subtotal: 200 },
      { sale_id: 21, product_id: 1, variant_id: 99, quantity: 9, subtotal: 900 },
    ],
  });

  assert.equal(feature.unitsSold, 3);
  assert.equal(feature.grossRevenue, 300);
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

test("predictive SQL obeys the consolidated source, CTE and destination schema contracts", async () => {
  await predictive.rebuildPredictiveFeatures({
    ownerAdminId: 101,
    dateFrom: "2026-07-14",
    dateTo: "2026-07-14",
    userId: 11,
  });

  const statementContracts = [
    {
      tableName: "daily_product_features",
      sql: calls.find((call) => call.sql.includes("INSERT INTO daily_product_features"))?.sql,
    },
    {
      tableName: "daily_variant_features",
      sql: calls.find((call) => call.sql.includes("INSERT INTO daily_variant_features"))?.sql,
    },
    {
      tableName: "daily_store_features",
      sql: calls.find((call) => call.sql.includes("INSERT INTO daily_store_features"))?.sql,
    },
  ];
  const auditSql = calls.find((call) => call.sql.includes("WITH sales_scope AS"))?.sql;
  assert.ok(auditSql);

  for (const { tableName, sql } of statementContracts) {
    assert.ok(sql, `Missing SQL for ${tableName}`);
    assertPhysicalAliasContract(sql);
    assertDerivedAliasContract(sql);

    const destinationColumns = insertedColumns(sql, tableName);
    assert.ok(destinationColumns.length > 0, `Missing INSERT columns for ${tableName}`);
    assert.deepEqual(
      destinationColumns.filter((column) => !VERIFIED_SCHEMA_COLUMNS[tableName].has(column)),
      [],
      `Unexpected INSERT columns for ${tableName}`
    );
    assert.deepEqual(
      referencedColumns(sql, "EXCLUDED")
        .filter((column) => !VERIFIED_SCHEMA_COLUMNS[tableName].has(column)),
      [],
      `Unexpected EXCLUDED columns for ${tableName}`
    );
  }

  assertPhysicalAliasContract(auditSql);
  const allSql = [...statementContracts.map((entry) => entry.sql), auditSql].join("\n");
  for (const alias of Object.keys(PHYSICAL_ALIAS_TABLES)) {
    assert.ok(
      referencedColumns(allSql, alias).length > 0,
      `Schema contract did not exercise ${alias} (${PHYSICAL_ALIAS_TABLES[alias]})`
    );
  }

  assert.doesNotMatch(allSql, /\bs\.status\b/i);
  assert.doesNotMatch(allSql, /\bsi\.status\b/i);
  assert.doesNotMatch(allSql, /\bp(?:v)?\.status\b/i);
  assert.doesNotMatch(allSql, /\bs\.payment_status::text\b/i);
  assert.doesNotMatch(allSql, /\bpoi\.variant_id\b/i);
  assert.match(allSql, /FROM procurement_orders pro[\s\S]*pro\.variant_id IS NOT NULL/);
  assert.match(allSql, /COALESCE\(s\.delivery_status::text, 'pending'\) = 'cancelled'/);
  assert.match(allSql, /SUM\(COALESCE\(si\.total_profit, 0\)\)/);
  assert.match(allSql, /x\.sale_day BETWEEN \$2::date - INTERVAL '89 days'/);
  assert.match(allSql, /sl\.qty_before[\s\S]*sl\.qty_after/);
});

test("predictive validation SQL contains no legacy sales status column", () => {
  const validationSql = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "scripts", "validate_predictive_features.sql"),
    "utf8"
  );
  assert.doesNotMatch(validationSql, /\bs\.status\b/i);
  assert.doesNotMatch(validationSql, /\bs\.payment_status::text\b/i);
  assert.match(validationSql, /s\.payment_status = 'paid'/i);
  assert.match(validationSql, /COALESCE\(s\.delivery_status::text, 'pending'\) <> 'cancelled'/i);
});

test("sale cancellation flow writes only the compatible delivery status", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const salesController = fs.readFileSync(
    path.join(__dirname, "..", "controllers", "sales.controller.js"),
    "utf8"
  );
  const wompiController = fs.readFileSync(
    path.join(__dirname, "..", "controllers", "wompi.controller.js"),
    "utf8"
  );

  assert.doesNotMatch(salesController, /payment_status\s*=\s*['"]cancelled['"]/i);
  assert.match(salesController, /SET delivery_status = 'cancelled'/);
  assert.match(salesController, /order\.delivery_status === "cancelled"/);
  assert.match(salesController, /sale\.delivery_status === "cancelled"/);
  assert.doesNotMatch(wompiController, /sale\.payment_status === "cancelled"/);
  assert.match(wompiController, /sale\.delivery_status === "cancelled"/);
});

test("daily predictive features process only the requested tenant", async () => {
  const result = await predictive.runDailyPredictiveFeatureJob({
    targetDate: "2026-07-14",
    ownerAdminId: 101,
  });

  assert.equal(result.tenants, 1);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].ownerAdminId, 101);
  assert.equal(result.results[0].success, true);

  const tenantLookup = calls.find((call) => call.sql.includes("SELECT DISTINCT u.id"));
  assert.deepEqual(tenantLookup.params, [101]);
  const writes = calls.filter((call) => /INSERT INTO daily_(?:product|variant|store)_features/.test(call.sql));
  assert.ok(writes.length >= 3);
  assert.ok(writes.every((call) => Number(call.params[0]) === 101));
  assert.equal(calls.some((call) => call.params[0] === 202), false);
});

test("daily predictive features propagate PostgreSQL 42703 in strict smoke mode", async () => {
  forcedProductFeatureError = Object.assign(new Error('column "p.unknown_column" does not exist'), {
    code: "42703",
    table: "products",
    column: "unknown_column",
    routine: "errorMissingColumn",
    position: "842",
    query: "SELECT private_data FROM sales",
    detail: "customer@example.test",
  });
  const logged = [];
  const originalConsoleError = console.error;
  console.error = (value) => logged.push(String(value));
  try {
    await assert.rejects(
      () => predictive.runDailyPredictiveFeatureJob({
        targetDate: "2026-07-14",
        ownerAdminId: 101,
        throwOnError: true,
      }),
      (err) => {
        assert.equal(err, forcedProductFeatureError);
        assert.equal(err.auraStatementName, "insertProductFeatures");
        assert.match(err.auraSql, /INSERT INTO daily_product_features/);
        assert.equal(Object.keys(err).includes("auraSql"), false);
        return true;
      }
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(logged.length, 1);
  assert.match(logged[0], /"code":"42703"/);
  assert.doesNotMatch(logged[0], /private_data|customer@example|SELECT/i);
});

test("predictive daily job stays disabled unless explicitly enabled", () => {
  delete process.env.AURA_PREDICTIVE_JOBS_ENABLED;
  assert.equal(jobs.predictiveJobsEnabled(), false);
});
