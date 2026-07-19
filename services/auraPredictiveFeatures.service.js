'use strict';

const crypto = require('crypto');
const db = require('../config/db');

const FEATURE_VERSION = 'predictive_features_v1';
const MAX_BACKFILL_DAYS = 370;
const CANCELLED_DELIVERY_STATUS = 'cancelled';
const PREDICTIVE_STATEMENT_NAMES = Object.freeze({
  productFeatures: 'insertProductFeatures',
  variantFeatures: 'insertVariantFeatures',
  storeFeatures: 'insertStoreFeatures',
  dataQuality: 'auditPredictiveDataQuality',
});

function createPredictiveError(message, code = 'AURA_PREDICTIVE_ERROR', status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function attachPredictiveStatementContext(err, statementName, sql) {
  if (!err || (typeof err !== 'object' && typeof err !== 'function')) return err;
  try {
    if (!Object.prototype.hasOwnProperty.call(err, 'auraStatementName')) {
      Object.defineProperty(err, 'auraStatementName', {
        value: statementName,
        enumerable: false,
        configurable: true,
      });
    }
    if (!Object.prototype.hasOwnProperty.call(err, 'auraSql')) {
      Object.defineProperty(err, 'auraSql', {
        value: sql,
        enumerable: false,
        configurable: true,
      });
    }
  } catch {
    // Preserve the original database error even if it is not extensible.
  }
  return err;
}

async function executePredictiveStatement(client, statementName, sql, params) {
  try {
    return await client.query(sql, params);
  } catch (err) {
    throw attachPredictiveStatementContext(err, statementName, sql);
  }
}

function toDateOnly(value, field = 'date') {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw createPredictiveError(`${field} debe tener formato YYYY-MM-DD`, 'AURA_PREDICTIVE_INVALID_DATE');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw createPredictiveError(`${field} no es una fecha valida`, 'AURA_PREDICTIVE_INVALID_DATE');
  }
  return value;
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  const start = new Date(`${from}T00:00:00.000Z`).getTime();
  const end = new Date(`${to}T00:00:00.000Z`).getTime();
  return Math.round((end - start) / 86_400_000);
}

function eachDateInRange(dateFrom, dateTo) {
  const from = toDateOnly(dateFrom, 'dateFrom');
  const to = toDateOnly(dateTo, 'dateTo');
  const days = daysBetween(from, to);
  if (days < 0) throw createPredictiveError('dateFrom no puede ser posterior a dateTo', 'AURA_PREDICTIVE_INVALID_RANGE');
  if (days > MAX_BACKFILL_DAYS) {
    throw createPredictiveError(`El rango maximo es ${MAX_BACKFILL_DAYS} dias`, 'AURA_PREDICTIVE_RANGE_TOO_LARGE');
  }
  return Array.from({ length: days + 1 }, (_, index) => addDays(from, index));
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeStatus(value) {
  return String(value || '').toLowerCase();
}

function isPaidNonCancelledSale(sale) {
  return normalizeStatus(sale.payment_status) === 'paid'
    && normalizeStatus(sale.delivery_status) !== CANCELLED_DELIVERY_STATUS;
}

function isCancelledSale(sale) {
  return normalizeStatus(sale.delivery_status) === CANCELLED_DELIVERY_STATUS;
}

function saleDateOnly(sale) {
  return toDateOnly(String(sale.sale_date || sale.created_at).slice(0, 10), 'sale_date');
}

function allocateItemDiscount(sale, item) {
  const saleSubtotal = numeric(sale.subtotal);
  if (saleSubtotal <= 0) return 0;
  return numeric(sale.discount_amount) * (numeric(item.subtotal) / saleSubtotal);
}

function median(values) {
  const sorted = values.map(numeric).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stddev(values) {
  if (!values.length) return 0;
  const avg = values.reduce((sum, value) => sum + numeric(value), 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (numeric(value) - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function rollingSum(daily, featureDate, days, field) {
  const start = addDays(featureDate, -(days - 1));
  return daily
    .filter((row) => row.date >= start && row.date <= featureDate)
    .reduce((sum, row) => sum + numeric(row[field]), 0);
}

function buildProductFeatureSnapshot({
  ownerAdminId,
  featureDate,
  product,
  sales = [],
  saleItems = [],
  stockLedger = [],
  purchaseOrderItems = [],
  campaignEvents = [],
}) {
  const date = toDateOnly(featureDate, 'featureDate');
  const productId = Number(product.id);
  const scopedSales = sales.filter((sale) => Number(sale.owner_admin_id) === Number(ownerAdminId));
  const saleById = new Map(scopedSales.map((sale) => [Number(sale.id), sale]));
  const productItems = saleItems.filter((item) => Number(item.product_id) === productId && saleById.has(Number(item.sale_id)));
  const paidItems = productItems.filter((item) => isPaidNonCancelledSale(saleById.get(Number(item.sale_id))));
  const cancelledItems = productItems.filter((item) => isCancelledSale(saleById.get(Number(item.sale_id))));

  const daily = [];
  for (let i = 89; i >= 0; i--) {
    const d = addDays(date, -i);
    const itemsForDate = paidItems.filter((item) => saleDateOnly(saleById.get(Number(item.sale_id))) === d);
    daily.push({
      date: d,
      units: itemsForDate.reduce((sum, item) => sum + numeric(item.quantity), 0),
      netRevenue: itemsForDate.reduce((sum, item) => {
        const sale = saleById.get(Number(item.sale_id));
        return sum + numeric(item.subtotal) - allocateItemDiscount(sale, item);
      }, 0),
    });
  }

  const featurePaidItems = paidItems.filter((item) => saleDateOnly(saleById.get(Number(item.sale_id))) === date);
  const featureCancelledItems = cancelledItems.filter((item) => saleDateOnly(saleById.get(Number(item.sale_id))) === date);
  const ledgerForDate = stockLedger
    .filter((row) =>
      Number(row.owner_admin_id) === Number(ownerAdminId)
      && Number(row.product_id) === productId
      && String(row.created_at).slice(0, 10) === date
    )
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

  const returnsUnits = ledgerForDate
    .filter((row) => normalizeStatus(row.movement_type) === 'return')
    .reduce((sum, row) => sum + Math.max(0, numeric(row.qty_delta ?? row.quantity)), 0);
  const stockInitial = ledgerForDate.length ? numeric(ledgerForDate[0].qty_before) : null;
  const stockFinal = ledgerForDate.length
    ? numeric(ledgerForDate[ledgerForDate.length - 1].qty_after)
    : numeric(product.stock);
  const reserved = numeric(product.stock_reserved);
  const safety = numeric(product.stock_safety);
  const available = Math.max(0, stockFinal - reserved - safety);
  const rolling30Units = daily.slice(-30).map((row) => row.units);
  const lastSale = [...daily].reverse().find((row) => row.units > 0);
  const duplicateSaleItemsCount = Object.values(productItems.reduce((acc, item) => {
    const key = `${item.sale_id}:${item.product_id}:${item.variant_id || 0}`;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {})).filter((count) => count > 1).length;
  const anomalyCount = productItems.filter((item) => numeric(item.quantity) < 0 || numeric(item.subtotal) < 0).length
    + (stockFinal < 0 ? 1 : 0)
    + (reserved > stockFinal ? 1 : 0);
  const missingCost = product.purchase_price === null || product.purchase_price === undefined;
  const missingLeadTime = product.supplier_lead_time_days === null || product.supplier_lead_time_days === undefined;
  const historicalStockEstimated = ledgerForDate.length === 0;
  const completenessScore = Math.max(
    0,
    1
      - (missingCost ? 0.2 : 0)
      - (missingLeadTime ? 0.15 : 0)
      - (historicalStockEstimated ? 0.2 : 0)
      - (anomalyCount ? 0.2 : 0)
  );

  return {
    ownerAdminId: Number(ownerAdminId),
    featureDate: date,
    productId,
    unitsSold: featurePaidItems.reduce((sum, item) => sum + numeric(item.quantity), 0),
    grossRevenue: featurePaidItems.reduce((sum, item) => sum + numeric(item.subtotal), 0),
    discountsAllocated: featurePaidItems.reduce((sum, item) => sum + allocateItemDiscount(saleById.get(Number(item.sale_id)), item), 0),
    netRevenue: featurePaidItems.reduce((sum, item) => sum + numeric(item.subtotal) - allocateItemDiscount(saleById.get(Number(item.sale_id)), item), 0),
    estimatedMargin: featurePaidItems.reduce((sum, item) => sum + numeric(item.total_profit), 0),
    cancelledUnits: featureCancelledItems.reduce((sum, item) => sum + numeric(item.quantity), 0),
    returnsUnits,
    returnsValueEstimated: 0,
    stockInitial,
    stockFinal,
    stockReservedFinal: reserved,
    stockAvailableFinal: available,
    stockouts: ledgerForDate.filter((row) => numeric(row.qty_after) <= 0).length + (available <= 0 ? 1 : 0),
    daysWithoutSale: lastSale ? daysBetween(lastSale.date, date) : null,
    rollingUnits7: rollingSum(daily, date, 7, 'units'),
    rollingUnits14: rollingSum(daily, date, 14, 'units'),
    rollingUnits30: rollingSum(daily, date, 30, 'units'),
    rollingUnits90: rollingSum(daily, date, 90, 'units'),
    rollingRevenue7: rollingSum(daily, date, 7, 'netRevenue'),
    rollingRevenue14: rollingSum(daily, date, 14, 'netRevenue'),
    rollingRevenue30: rollingSum(daily, date, 30, 'netRevenue'),
    rollingRevenue90: rollingSum(daily, date, 90, 'netRevenue'),
    avgUnits30: rolling30Units.reduce((sum, value) => sum + value, 0) / 30,
    medianUnits30: median(rolling30Units),
    stddevUnits30: stddev(rolling30Units),
    trendUnits30: (rollingSum(daily, date, 7, 'units') / 7) - (rollingSum(daily.slice(0, -7), addDays(date, -7), 23, 'units') / 23),
    campaignEventsCount: campaignEvents.filter((event) =>
      Number(event.owner_admin_id) === Number(ownerAdminId)
      && Number(event.product_id) === productId
      && String(event.occurred_at).slice(0, 10) === date
    ).length,
    price: numeric(product.sale_price),
    priceChanged: false,
    leadTimeDays: product.supplier_lead_time_days ?? null,
    pendingPurchaseUnits: purchaseOrderItems
      .filter((item) => Number(item.product_id) === productId)
      .reduce((sum, item) => sum + Math.max(0, numeric(item.quantity) - numeric(item.received_quantity)), 0),
    isDataSufficient: paidItems.length >= 3 && completenessScore >= 0.65,
    completenessScore: Math.round(completenessScore * 10_000) / 10_000,
    duplicateSaleItemsCount,
    anomalyCount,
    dataQuality: {
      missingCost,
      missingLeadTime,
      historicalStockEstimated,
      duplicateSaleItemsCount,
      anomalyCount,
      returnsValueEstimated: true,
      refundsModeled: false,
    },
  };
}

async function tableExists(client, tableName) {
  const { rows } = await client.query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = $1
     ) AS exists`,
    [tableName]
  );
  return Boolean(rows[0]?.exists);
}

async function acquireRangeLock(client, ownerAdminId, dateFrom, dateTo) {
  const key = `aura_predictive:${ownerAdminId}:${dateFrom}:${dateTo}:${FEATURE_VERSION}`;
  const { rows } = await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked', [key]);
  if (!rows[0]?.locked) {
    throw createPredictiveError('Otro recalculo predictivo esta en curso para este tenant/rango', 'AURA_PREDICTIVE_LOCKED', 409);
  }
}

function campaignEventsCte(hasCampaignTables) {
  if (!hasCampaignTables) {
    return `campaign_events_daily AS (
      SELECT NULL::integer AS product_id, 0::integer AS campaign_events_count WHERE false
    )`;
  }
  return `campaign_events_daily AS (
    SELECT
      ca.product_id,
      COUNT(*)::int AS campaign_events_count
    FROM campaign_events ce
    JOIN marketing_campaigns mc
      ON mc.id = ce.campaign_id
     AND mc.owner_admin_id = $1
    JOIN campaign_assets ca
      ON ca.campaign_id = ce.campaign_id
     AND ca.owner_admin_id = mc.owner_admin_id
     AND ca.product_id IS NOT NULL
    WHERE ce.owner_admin_id = $1
      AND ce.occurred_at::date = $2::date
    GROUP BY ca.product_id
  )`;
}

async function insertProductFeatures(client, { ownerAdminId, featureDate, runId, hasCampaignTables }) {
  const sql = `
    WITH params AS (
      SELECT $1::int AS owner_admin_id, $2::date AS feature_date, $3::text AS feature_version, $4::uuid AS run_id
    ),
    product_base AS (
      SELECT
        p.id AS product_id,
        p.owner_admin_id,
        p.sale_price,
        p.purchase_price,
        p.stock,
        COALESCE(p.stock_reserved, 0) AS stock_reserved,
        COALESCE(p.stock_safety, 0) AS stock_safety,
        COALESCE(p.supplier_lead_time_days, pr.lead_time_days)::int AS lead_time_days
      FROM products p
      LEFT JOIN providers pr ON pr.id = p.default_supplier_id AND pr.owner_admin_id = p.owner_admin_id
      WHERE p.owner_admin_id = $1
        AND COALESCE(p.is_active, true) = true
    ),
    valid_sales AS (
      SELECT s.id, s.sale_date::date AS sale_day, s.subtotal, s.discount_amount, s.tax_amount
      FROM sales s
      WHERE s.owner_admin_id = $1
        AND s.sale_date::date BETWEEN ($2::date - INTERVAL '89 days') AND $2::date
        AND s.payment_status = 'paid'
        AND COALESCE(s.delivery_status::text, 'pending') <> 'cancelled'
    ),
    sales_daily AS (
      SELECT
        si.product_id,
        vs.sale_day,
        SUM(si.quantity)::numeric(14,3) AS units_sold,
        SUM(si.subtotal)::numeric(14,2) AS gross_revenue,
        SUM(CASE WHEN COALESCE(vs.subtotal, 0) > 0
          THEN COALESCE(vs.discount_amount, 0) * (COALESCE(si.subtotal, 0) / NULLIF(vs.subtotal, 0))
          ELSE 0 END)::numeric(14,2) AS discounts_allocated,
        SUM(CASE WHEN COALESCE(vs.subtotal, 0) > 0
          THEN COALESCE(vs.tax_amount, 0) * (COALESCE(si.subtotal, 0) / NULLIF(vs.subtotal, 0))
          ELSE 0 END)::numeric(14,2) AS tax_allocated,
        SUM(COALESCE(si.subtotal, 0) - CASE WHEN COALESCE(vs.subtotal, 0) > 0
          THEN COALESCE(vs.discount_amount, 0) * (COALESCE(si.subtotal, 0) / NULLIF(vs.subtotal, 0))
          ELSE 0 END)::numeric(14,2) AS net_revenue,
        SUM(COALESCE(si.total_profit, 0))::numeric(14,2) AS estimated_margin
      FROM valid_sales vs
      JOIN sale_items si ON si.sale_id = vs.id
      GROUP BY si.product_id, vs.sale_day
    ),
    cancelled_daily AS (
      SELECT si.product_id, SUM(si.quantity)::numeric(14,3) AS cancelled_units
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      WHERE s.owner_admin_id = $1
        AND s.sale_date::date = $2::date
        AND COALESCE(s.delivery_status::text, 'pending') = 'cancelled'
      GROUP BY si.product_id
    ),
    returns_daily AS (
      SELECT sl.product_id, SUM(GREATEST(0, COALESCE(sl.qty_delta, 0)))::numeric(14,3) AS returns_units
      FROM stock_ledger sl
      WHERE sl.owner_admin_id = $1
        AND sl.created_at::date = $2::date
        AND sl.movement_type = 'return'
      GROUP BY sl.product_id
    ),
    ledger_daily AS (
      SELECT
        sl.product_id,
        (ARRAY_AGG(sl.qty_before ORDER BY sl.created_at ASC, sl.id ASC))[1]::numeric(14,3) AS stock_initial,
        (ARRAY_AGG(sl.qty_after ORDER BY sl.created_at DESC, sl.id DESC))[1]::numeric(14,3) AS stock_final_from_ledger,
        COUNT(*) FILTER (WHERE COALESCE(sl.qty_after, 0) <= 0)::int AS stockouts
      FROM stock_ledger sl
      WHERE sl.owner_admin_id = $1
        AND sl.created_at::date = $2::date
      GROUP BY sl.product_id
    ),
    duplicate_items AS (
      SELECT product_id, COUNT(*)::int AS duplicate_sale_items_count
      FROM (
        SELECT si.sale_id, si.product_id, COALESCE(si.variant_id, 0) AS variant_key, COUNT(*) AS c
        FROM sale_items si
        JOIN sales s ON s.id = si.sale_id
        WHERE s.owner_admin_id = $1
          AND s.sale_date::date = $2::date
        GROUP BY si.sale_id, si.product_id, COALESCE(si.variant_id, 0)
        HAVING COUNT(*) > 1
      ) d
      GROUP BY product_id
    ),
    anomalies AS (
      SELECT si.product_id, COUNT(*)::int AS anomaly_count
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      WHERE s.owner_admin_id = $1
        AND s.sale_date::date = $2::date
        AND (COALESCE(si.quantity, 0) < 0 OR COALESCE(si.subtotal, 0) < 0 OR COALESCE(si.unit_price, 0) < 0)
      GROUP BY si.product_id
    ),
    pending_purchase AS (
      SELECT
        poi.product_id,
        SUM(GREATEST(0, COALESCE(poi.quantity, 0) - COALESCE(poi.received_quantity, 0)))::numeric(14,3) AS pending_purchase_units
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.purchase_order_id
      WHERE po.owner_admin_id = $1
        AND po.status NOT IN ('received', 'cancelled')
      GROUP BY poi.product_id
    ),
    ${campaignEventsCte(hasCampaignTables)},
    features AS (
      SELECT
        pb.owner_admin_id,
        $2::date AS feature_date,
        pb.product_id,
        $3::text AS feature_version,
        $4::uuid AS calculation_run_id,
        COALESCE(sd.units_sold, 0) AS units_sold,
        COALESCE(sd.gross_revenue, 0) AS gross_revenue,
        COALESCE(sd.net_revenue, 0) AS net_revenue,
        COALESCE(sd.discounts_allocated, 0) AS discounts_allocated,
        COALESCE(sd.tax_allocated, 0) AS tax_allocated,
        COALESCE(rd.returns_units, 0) AS returns_units,
        0::numeric(14,2) AS returns_value_estimated,
        COALESCE(cd.cancelled_units, 0) AS cancelled_units,
        COALESCE(sd.estimated_margin, 0) AS estimated_margin,
        ld.stock_initial,
        COALESCE(ld.stock_final_from_ledger, pb.stock)::numeric(14,3) AS stock_final,
        pb.stock_reserved::numeric(14,3) AS stock_reserved_final,
        GREATEST(0, COALESCE(ld.stock_final_from_ledger, pb.stock, 0) - pb.stock_reserved - pb.stock_safety)::numeric(14,3) AS stock_available_final,
        COALESCE(ld.stockouts, 0) + CASE WHEN GREATEST(0, COALESCE(ld.stock_final_from_ledger, pb.stock, 0) - pb.stock_reserved - pb.stock_safety) <= 0 THEN 1 ELSE 0 END AS stockouts,
        CASE
          WHEN last_sale.last_sale_day IS NULL THEN NULL
          ELSE ($2::date - last_sale.last_sale_day)::int
        END AS days_without_sale,
        COALESCE((SELECT SUM(units_sold) FROM sales_daily x WHERE x.product_id = pb.product_id AND x.sale_day BETWEEN $2::date - INTERVAL '6 days' AND $2::date), 0)::numeric(14,3) AS rolling_units_7,
        COALESCE((SELECT SUM(units_sold) FROM sales_daily x WHERE x.product_id = pb.product_id AND x.sale_day BETWEEN $2::date - INTERVAL '13 days' AND $2::date), 0)::numeric(14,3) AS rolling_units_14,
        COALESCE((SELECT SUM(units_sold) FROM sales_daily x WHERE x.product_id = pb.product_id AND x.sale_day BETWEEN $2::date - INTERVAL '29 days' AND $2::date), 0)::numeric(14,3) AS rolling_units_30,
        COALESCE((SELECT SUM(units_sold) FROM sales_daily x WHERE x.product_id = pb.product_id AND x.sale_day BETWEEN $2::date - INTERVAL '89 days' AND $2::date), 0)::numeric(14,3) AS rolling_units_90,
        COALESCE((SELECT SUM(net_revenue) FROM sales_daily x WHERE x.product_id = pb.product_id AND x.sale_day BETWEEN $2::date - INTERVAL '6 days' AND $2::date), 0)::numeric(14,2) AS rolling_revenue_7,
        COALESCE((SELECT SUM(net_revenue) FROM sales_daily x WHERE x.product_id = pb.product_id AND x.sale_day BETWEEN $2::date - INTERVAL '13 days' AND $2::date), 0)::numeric(14,2) AS rolling_revenue_14,
        COALESCE((SELECT SUM(net_revenue) FROM sales_daily x WHERE x.product_id = pb.product_id AND x.sale_day BETWEEN $2::date - INTERVAL '29 days' AND $2::date), 0)::numeric(14,2) AS rolling_revenue_30,
        COALESCE((SELECT SUM(net_revenue) FROM sales_daily x WHERE x.product_id = pb.product_id AND x.sale_day BETWEEN $2::date - INTERVAL '89 days' AND $2::date), 0)::numeric(14,2) AS rolling_revenue_90,
        (COALESCE((SELECT SUM(units_sold) FROM sales_daily x WHERE x.product_id = pb.product_id AND x.sale_day BETWEEN $2::date - INTERVAL '29 days' AND $2::date), 0) / 30.0)::numeric(14,4) AS avg_units_30,
        COALESCE((SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY units_sold) FROM sales_daily x WHERE x.product_id = pb.product_id AND x.sale_day BETWEEN $2::date - INTERVAL '29 days' AND $2::date), 0)::numeric(14,4) AS median_units_30,
        COALESCE((SELECT stddev_pop(units_sold) FROM sales_daily x WHERE x.product_id = pb.product_id AND x.sale_day BETWEEN $2::date - INTERVAL '29 days' AND $2::date), 0)::numeric(14,4) AS stddev_units_30,
        (
          (COALESCE((SELECT SUM(units_sold) FROM sales_daily x WHERE x.product_id = pb.product_id AND x.sale_day BETWEEN $2::date - INTERVAL '6 days' AND $2::date), 0) / 7.0)
          - (COALESCE((SELECT SUM(units_sold) FROM sales_daily x WHERE x.product_id = pb.product_id AND x.sale_day BETWEEN $2::date - INTERVAL '29 days' AND $2::date - INTERVAL '7 days'), 0) / 23.0)
        )::numeric(14,4) AS trend_units_30,
        EXTRACT(DOW FROM $2::date)::smallint AS day_of_week,
        EXTRACT(MONTH FROM $2::date)::smallint AS month,
        COALESCE(ced.campaign_events_count, 0) AS campaign_events_count,
        pb.sale_price AS price,
        false AS price_changed,
        pb.lead_time_days,
        COALESCE(pp.pending_purchase_units, 0) AS pending_purchase_units,
        COALESCE(di.duplicate_sale_items_count, 0) AS duplicate_sale_items_count,
        COALESCE(an.anomaly_count, 0)
          + CASE WHEN COALESCE(ld.stock_final_from_ledger, pb.stock, 0) < 0 THEN 1 ELSE 0 END
          + CASE WHEN pb.stock_reserved > COALESCE(ld.stock_final_from_ledger, pb.stock, 0) THEN 1 ELSE 0 END AS anomaly_count,
        jsonb_build_object(
          'missingCost', pb.purchase_price IS NULL,
          'missingLeadTime', pb.lead_time_days IS NULL,
          'historicalStockEstimated', ld.stock_final_from_ledger IS NULL,
          'returnsValueEstimated', true,
          'refundsModeled', false,
          'campaignEventsAvailable', ${hasCampaignTables ? 'true' : 'false'},
          'medianUsesSalesDaysOnly', true
        ) AS data_quality
      FROM product_base pb
      LEFT JOIN sales_daily sd ON sd.product_id = pb.product_id AND sd.sale_day = $2::date
      LEFT JOIN returns_daily rd ON rd.product_id = pb.product_id
      LEFT JOIN cancelled_daily cd ON cd.product_id = pb.product_id
      LEFT JOIN ledger_daily ld ON ld.product_id = pb.product_id
      LEFT JOIN duplicate_items di ON di.product_id = pb.product_id
      LEFT JOIN anomalies an ON an.product_id = pb.product_id
      LEFT JOIN pending_purchase pp ON pp.product_id = pb.product_id
      LEFT JOIN campaign_events_daily ced ON ced.product_id = pb.product_id
      LEFT JOIN LATERAL (
        SELECT MAX(sale_day) AS last_sale_day
        FROM sales_daily x
        WHERE x.product_id = pb.product_id
          AND x.units_sold > 0
          AND x.sale_day <= $2::date
      ) last_sale ON true
    ),
    scored AS (
      SELECT
        f.*,
        GREATEST(0, LEAST(1,
          1
          - CASE WHEN (f.data_quality->>'missingCost')::boolean THEN 0.20 ELSE 0 END
          - CASE WHEN (f.data_quality->>'missingLeadTime')::boolean THEN 0.15 ELSE 0 END
          - CASE WHEN (f.data_quality->>'historicalStockEstimated')::boolean THEN 0.20 ELSE 0 END
          - CASE WHEN f.anomaly_count > 0 THEN 0.20 ELSE 0 END
        ))::numeric(5,4) AS completeness_score
      FROM features f
    )
    INSERT INTO daily_product_features (
      owner_admin_id, feature_date, product_id, feature_version, calculation_run_id,
      units_sold, gross_revenue, net_revenue, discounts_allocated, tax_allocated,
      returns_units, returns_value_estimated, cancelled_units, estimated_margin,
      stock_initial, stock_final, stock_reserved_final, stock_available_final, stockouts,
      days_without_sale, rolling_units_7, rolling_units_14, rolling_units_30, rolling_units_90,
      rolling_revenue_7, rolling_revenue_14, rolling_revenue_30, rolling_revenue_90,
      avg_units_30, median_units_30, stddev_units_30, trend_units_30, day_of_week, month,
      campaign_events_count, price, price_changed, lead_time_days, pending_purchase_units,
      is_data_sufficient, completeness_score, duplicate_sale_items_count, anomaly_count,
      data_quality, source_fingerprint, last_calculated_at
    )
    SELECT
      owner_admin_id, feature_date, product_id, feature_version, calculation_run_id,
      units_sold, gross_revenue, net_revenue, discounts_allocated, tax_allocated,
      returns_units, returns_value_estimated, cancelled_units, estimated_margin,
      stock_initial, stock_final, stock_reserved_final, stock_available_final, stockouts,
      days_without_sale, rolling_units_7, rolling_units_14, rolling_units_30, rolling_units_90,
      rolling_revenue_7, rolling_revenue_14, rolling_revenue_30, rolling_revenue_90,
      avg_units_30, median_units_30, stddev_units_30, trend_units_30, day_of_week, month,
      campaign_events_count, price, price_changed, lead_time_days, pending_purchase_units,
      (rolling_units_90 >= 3 AND completeness_score >= 0.65) AS is_data_sufficient,
      completeness_score, duplicate_sale_items_count, anomaly_count,
      data_quality,
      md5(jsonb_build_object(
        'units', units_sold, 'net', net_revenue, 'stock', stock_final,
        'pending', pending_purchase_units, 'quality', data_quality
      )::text) AS source_fingerprint,
      NOW()
    FROM scored
    ON CONFLICT (owner_admin_id, feature_date, product_id, feature_version)
    DO UPDATE SET
      calculation_run_id = EXCLUDED.calculation_run_id,
      units_sold = EXCLUDED.units_sold,
      gross_revenue = EXCLUDED.gross_revenue,
      net_revenue = EXCLUDED.net_revenue,
      discounts_allocated = EXCLUDED.discounts_allocated,
      tax_allocated = EXCLUDED.tax_allocated,
      returns_units = EXCLUDED.returns_units,
      returns_value_estimated = EXCLUDED.returns_value_estimated,
      cancelled_units = EXCLUDED.cancelled_units,
      estimated_margin = EXCLUDED.estimated_margin,
      stock_initial = EXCLUDED.stock_initial,
      stock_final = EXCLUDED.stock_final,
      stock_reserved_final = EXCLUDED.stock_reserved_final,
      stock_available_final = EXCLUDED.stock_available_final,
      stockouts = EXCLUDED.stockouts,
      days_without_sale = EXCLUDED.days_without_sale,
      rolling_units_7 = EXCLUDED.rolling_units_7,
      rolling_units_14 = EXCLUDED.rolling_units_14,
      rolling_units_30 = EXCLUDED.rolling_units_30,
      rolling_units_90 = EXCLUDED.rolling_units_90,
      rolling_revenue_7 = EXCLUDED.rolling_revenue_7,
      rolling_revenue_14 = EXCLUDED.rolling_revenue_14,
      rolling_revenue_30 = EXCLUDED.rolling_revenue_30,
      rolling_revenue_90 = EXCLUDED.rolling_revenue_90,
      avg_units_30 = EXCLUDED.avg_units_30,
      median_units_30 = EXCLUDED.median_units_30,
      stddev_units_30 = EXCLUDED.stddev_units_30,
      trend_units_30 = EXCLUDED.trend_units_30,
      campaign_events_count = EXCLUDED.campaign_events_count,
      price = EXCLUDED.price,
      price_changed = EXCLUDED.price_changed,
      lead_time_days = EXCLUDED.lead_time_days,
      pending_purchase_units = EXCLUDED.pending_purchase_units,
      is_data_sufficient = EXCLUDED.is_data_sufficient,
      completeness_score = EXCLUDED.completeness_score,
      duplicate_sale_items_count = EXCLUDED.duplicate_sale_items_count,
      anomaly_count = EXCLUDED.anomaly_count,
      data_quality = EXCLUDED.data_quality,
      source_fingerprint = EXCLUDED.source_fingerprint,
      last_calculated_at = NOW(),
      recalculation_count = daily_product_features.recalculation_count + 1
    RETURNING product_id`;

  const { rowCount } = await executePredictiveStatement(
    client,
    PREDICTIVE_STATEMENT_NAMES.productFeatures,
    sql,
    [ownerAdminId, featureDate, FEATURE_VERSION, runId]
  );
  return rowCount;
}

async function insertVariantFeatures(client, { ownerAdminId, featureDate, runId }) {
  const sql = `WITH variant_base AS (
       SELECT
         p.owner_admin_id,
         p.id AS product_id,
         pv.id AS variant_id,
         COALESCE(pv.sale_price, p.sale_price) AS price,
         p.purchase_price,
         COALESCE(pv.stock, 0) AS stock,
         COALESCE(pv.stock_reserved, 0) AS stock_reserved,
         COALESCE(pv.stock_safety, 0) AS stock_safety,
         p.supplier_lead_time_days::int AS lead_time_days
       FROM product_variants pv
       JOIN products p ON p.id = pv.product_id
       WHERE p.owner_admin_id = $1
         AND COALESCE(p.is_active, true) = true
         AND COALESCE(pv.is_active, true) = true
     ),
     valid_sales AS (
       SELECT s.id, s.sale_date::date AS sale_day, s.subtotal, s.discount_amount, s.tax_amount
       FROM sales s
       WHERE s.owner_admin_id = $1
         AND s.sale_date::date BETWEEN ($2::date - INTERVAL '89 days') AND $2::date
         AND s.payment_status = 'paid'
         AND COALESCE(s.delivery_status::text, 'pending') <> 'cancelled'
     ),
     sales_daily AS (
       SELECT
         si.product_id,
         si.variant_id,
         vs.sale_day,
         SUM(si.quantity)::numeric(14,3) AS units_sold,
         SUM(si.subtotal)::numeric(14,2) AS gross_revenue,
         SUM(CASE WHEN COALESCE(vs.subtotal, 0) > 0
           THEN COALESCE(vs.discount_amount, 0) * (COALESCE(si.subtotal, 0) / NULLIF(vs.subtotal, 0))
           ELSE 0 END)::numeric(14,2) AS discounts_allocated,
         SUM(CASE WHEN COALESCE(vs.subtotal, 0) > 0
           THEN COALESCE(vs.tax_amount, 0) * (COALESCE(si.subtotal, 0) / NULLIF(vs.subtotal, 0))
           ELSE 0 END)::numeric(14,2) AS tax_allocated,
         SUM(COALESCE(si.subtotal, 0) - CASE WHEN COALESCE(vs.subtotal, 0) > 0
           THEN COALESCE(vs.discount_amount, 0) * (COALESCE(si.subtotal, 0) / NULLIF(vs.subtotal, 0))
           ELSE 0 END)::numeric(14,2) AS net_revenue,
         SUM(COALESCE(si.total_profit, 0))::numeric(14,2) AS estimated_margin
       FROM valid_sales vs
       JOIN sale_items si ON si.sale_id = vs.id
       WHERE si.variant_id IS NOT NULL
       GROUP BY si.product_id, si.variant_id, vs.sale_day
     ),
     cancelled_daily AS (
       SELECT si.variant_id, SUM(si.quantity)::numeric(14,3) AS cancelled_units
       FROM sales s
       JOIN sale_items si ON si.sale_id = s.id
       WHERE s.owner_admin_id = $1
         AND s.sale_date::date = $2::date
         AND si.variant_id IS NOT NULL
         AND COALESCE(s.delivery_status::text, 'pending') = 'cancelled'
       GROUP BY si.variant_id
     ),
     returns_daily AS (
       SELECT sl.variant_id, SUM(GREATEST(0, COALESCE(sl.qty_delta, 0)))::numeric(14,3) AS returns_units
       FROM stock_ledger sl
       WHERE sl.owner_admin_id = $1
         AND sl.created_at::date = $2::date
         AND sl.movement_type = 'return'
         AND sl.variant_id IS NOT NULL
       GROUP BY sl.variant_id
     ),
     ledger_daily AS (
       SELECT
         sl.variant_id,
         (ARRAY_AGG(sl.qty_before ORDER BY sl.created_at ASC, sl.id ASC))[1]::numeric(14,3) AS stock_initial,
         (ARRAY_AGG(sl.qty_after ORDER BY sl.created_at DESC, sl.id DESC))[1]::numeric(14,3) AS stock_final_from_ledger,
         COUNT(*) FILTER (WHERE COALESCE(sl.qty_after, 0) <= 0)::int AS stockouts
       FROM stock_ledger sl
       WHERE sl.owner_admin_id = $1
         AND sl.created_at::date = $2::date
         AND sl.variant_id IS NOT NULL
       GROUP BY sl.variant_id
     ),
     pending_purchase AS (
       SELECT
         pro.variant_id,
         SUM(COALESCE(pro.quantity, 0))::numeric(14,3) AS pending_purchase_units
       FROM procurement_orders pro
       WHERE pro.owner_admin_id = $1
         AND pro.status NOT IN ('received', 'cancelled')
         AND pro.variant_id IS NOT NULL
       GROUP BY pro.variant_id
     ),
     features AS (
       SELECT
         vb.owner_admin_id,
         $2::date AS feature_date,
         vb.product_id,
         vb.variant_id,
         $3::text AS feature_version,
         $4::uuid AS calculation_run_id,
         COALESCE(sd.units_sold, 0) AS units_sold,
         COALESCE(sd.gross_revenue, 0) AS gross_revenue,
         COALESCE(sd.net_revenue, 0) AS net_revenue,
         COALESCE(sd.discounts_allocated, 0) AS discounts_allocated,
         COALESCE(sd.tax_allocated, 0) AS tax_allocated,
         COALESCE(rd.returns_units, 0) AS returns_units,
         0::numeric(14,2) AS returns_value_estimated,
         COALESCE(cd.cancelled_units, 0) AS cancelled_units,
         COALESCE(sd.estimated_margin, 0) AS estimated_margin,
         ld.stock_initial,
         COALESCE(ld.stock_final_from_ledger, vb.stock)::numeric(14,3) AS stock_final,
         vb.stock_reserved::numeric(14,3) AS stock_reserved_final,
         GREATEST(0, COALESCE(ld.stock_final_from_ledger, vb.stock, 0) - vb.stock_reserved - vb.stock_safety)::numeric(14,3) AS stock_available_final,
         COALESCE(ld.stockouts, 0) + CASE WHEN GREATEST(0, COALESCE(ld.stock_final_from_ledger, vb.stock, 0) - vb.stock_reserved - vb.stock_safety) <= 0 THEN 1 ELSE 0 END AS stockouts,
         CASE WHEN last_sale.last_sale_day IS NULL THEN NULL ELSE ($2::date - last_sale.last_sale_day)::int END AS days_without_sale,
         COALESCE((SELECT SUM(units_sold) FROM sales_daily x WHERE x.variant_id = vb.variant_id AND x.sale_day BETWEEN $2::date - INTERVAL '6 days' AND $2::date), 0)::numeric(14,3) AS rolling_units_7,
         COALESCE((SELECT SUM(units_sold) FROM sales_daily x WHERE x.variant_id = vb.variant_id AND x.sale_day BETWEEN $2::date - INTERVAL '13 days' AND $2::date), 0)::numeric(14,3) AS rolling_units_14,
         COALESCE((SELECT SUM(units_sold) FROM sales_daily x WHERE x.variant_id = vb.variant_id AND x.sale_day BETWEEN $2::date - INTERVAL '29 days' AND $2::date), 0)::numeric(14,3) AS rolling_units_30,
         COALESCE((SELECT SUM(units_sold) FROM sales_daily x WHERE x.variant_id = vb.variant_id AND x.sale_day BETWEEN $2::date - INTERVAL '89 days' AND $2::date), 0)::numeric(14,3) AS rolling_units_90,
         COALESCE((SELECT SUM(net_revenue) FROM sales_daily x WHERE x.variant_id = vb.variant_id AND x.sale_day BETWEEN $2::date - INTERVAL '6 days' AND $2::date), 0)::numeric(14,2) AS rolling_revenue_7,
         COALESCE((SELECT SUM(net_revenue) FROM sales_daily x WHERE x.variant_id = vb.variant_id AND x.sale_day BETWEEN $2::date - INTERVAL '13 days' AND $2::date), 0)::numeric(14,2) AS rolling_revenue_14,
         COALESCE((SELECT SUM(net_revenue) FROM sales_daily x WHERE x.variant_id = vb.variant_id AND x.sale_day BETWEEN $2::date - INTERVAL '29 days' AND $2::date), 0)::numeric(14,2) AS rolling_revenue_30,
         COALESCE((SELECT SUM(net_revenue) FROM sales_daily x WHERE x.variant_id = vb.variant_id AND x.sale_day BETWEEN $2::date - INTERVAL '89 days' AND $2::date), 0)::numeric(14,2) AS rolling_revenue_90,
         (COALESCE((SELECT SUM(units_sold) FROM sales_daily x WHERE x.variant_id = vb.variant_id AND x.sale_day BETWEEN $2::date - INTERVAL '29 days' AND $2::date), 0) / 30.0)::numeric(14,4) AS avg_units_30,
         COALESCE((SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY units_sold) FROM sales_daily x WHERE x.variant_id = vb.variant_id AND x.sale_day BETWEEN $2::date - INTERVAL '29 days' AND $2::date), 0)::numeric(14,4) AS median_units_30,
         COALESCE((SELECT stddev_pop(units_sold) FROM sales_daily x WHERE x.variant_id = vb.variant_id AND x.sale_day BETWEEN $2::date - INTERVAL '29 days' AND $2::date), 0)::numeric(14,4) AS stddev_units_30,
         (
           (COALESCE((SELECT SUM(units_sold) FROM sales_daily x WHERE x.variant_id = vb.variant_id AND x.sale_day BETWEEN $2::date - INTERVAL '6 days' AND $2::date), 0) / 7.0)
           - (COALESCE((SELECT SUM(units_sold) FROM sales_daily x WHERE x.variant_id = vb.variant_id AND x.sale_day BETWEEN $2::date - INTERVAL '29 days' AND $2::date - INTERVAL '7 days'), 0) / 23.0)
         )::numeric(14,4) AS trend_units_30,
         EXTRACT(DOW FROM $2::date)::smallint AS day_of_week,
         EXTRACT(MONTH FROM $2::date)::smallint AS month,
         0::int AS campaign_events_count,
         vb.price,
         false AS price_changed,
         vb.lead_time_days,
         COALESCE(pp.pending_purchase_units, 0) AS pending_purchase_units,
         0::int AS duplicate_sale_items_count,
         CASE
           WHEN COALESCE(ld.stock_final_from_ledger, vb.stock, 0) < 0 THEN 1
           WHEN vb.stock_reserved > COALESCE(ld.stock_final_from_ledger, vb.stock, 0) THEN 1
           ELSE 0
         END AS anomaly_count,
         jsonb_build_object(
           'missingCost', vb.purchase_price IS NULL,
           'missingLeadTime', vb.lead_time_days IS NULL,
           'historicalStockEstimated', ld.stock_final_from_ledger IS NULL,
           'returnsValueEstimated', true,
           'refundsModeled', false,
           'campaignEventsAvailable', false,
           'medianUsesSalesDaysOnly', true
         ) AS data_quality
       FROM variant_base vb
       LEFT JOIN sales_daily sd ON sd.variant_id = vb.variant_id AND sd.sale_day = $2::date
       LEFT JOIN returns_daily rd ON rd.variant_id = vb.variant_id
       LEFT JOIN cancelled_daily cd ON cd.variant_id = vb.variant_id
       LEFT JOIN ledger_daily ld ON ld.variant_id = vb.variant_id
       LEFT JOIN pending_purchase pp ON pp.variant_id = vb.variant_id
       LEFT JOIN LATERAL (
         SELECT MAX(sale_day) AS last_sale_day
         FROM sales_daily x
         WHERE x.variant_id = vb.variant_id
           AND x.units_sold > 0
           AND x.sale_day <= $2::date
       ) last_sale ON true
     ),
     scored AS (
       SELECT
         f.*,
         GREATEST(0, LEAST(1,
           1
           - CASE WHEN (f.data_quality->>'missingCost')::boolean THEN 0.20 ELSE 0 END
           - CASE WHEN (f.data_quality->>'missingLeadTime')::boolean THEN 0.15 ELSE 0 END
           - CASE WHEN (f.data_quality->>'historicalStockEstimated')::boolean THEN 0.20 ELSE 0 END
           - CASE WHEN f.anomaly_count > 0 THEN 0.20 ELSE 0 END
         ))::numeric(5,4) AS completeness_score
       FROM features f
     )
     INSERT INTO daily_variant_features (
       owner_admin_id, feature_date, product_id, variant_id, feature_version, calculation_run_id,
       units_sold, gross_revenue, net_revenue, discounts_allocated, tax_allocated,
       returns_units, returns_value_estimated, cancelled_units, estimated_margin,
       stock_initial, stock_final, stock_reserved_final, stock_available_final, stockouts,
       days_without_sale, rolling_units_7, rolling_units_14, rolling_units_30, rolling_units_90,
       rolling_revenue_7, rolling_revenue_14, rolling_revenue_30, rolling_revenue_90,
       avg_units_30, median_units_30, stddev_units_30, trend_units_30, day_of_week, month,
       campaign_events_count, price, price_changed, lead_time_days, pending_purchase_units,
       is_data_sufficient, completeness_score, duplicate_sale_items_count, anomaly_count,
       data_quality, source_fingerprint, last_calculated_at
     )
     SELECT
       owner_admin_id, feature_date, product_id, variant_id, feature_version, calculation_run_id,
       units_sold, gross_revenue, net_revenue, discounts_allocated, tax_allocated,
       returns_units, returns_value_estimated, cancelled_units, estimated_margin,
       stock_initial, stock_final, stock_reserved_final, stock_available_final, stockouts,
       days_without_sale, rolling_units_7, rolling_units_14, rolling_units_30, rolling_units_90,
       rolling_revenue_7, rolling_revenue_14, rolling_revenue_30, rolling_revenue_90,
       avg_units_30, median_units_30, stddev_units_30, trend_units_30, day_of_week, month,
       campaign_events_count, price, price_changed, lead_time_days, pending_purchase_units,
       (rolling_units_90 >= 3 AND completeness_score >= 0.65),
       completeness_score, duplicate_sale_items_count, anomaly_count, data_quality,
       md5(jsonb_build_object('units', units_sold, 'net', net_revenue, 'stock', stock_final, 'quality', data_quality)::text),
       NOW()
     FROM scored
     ON CONFLICT (owner_admin_id, feature_date, variant_id, feature_version)
     DO UPDATE SET
       calculation_run_id = EXCLUDED.calculation_run_id,
       units_sold = EXCLUDED.units_sold,
       gross_revenue = EXCLUDED.gross_revenue,
       net_revenue = EXCLUDED.net_revenue,
       discounts_allocated = EXCLUDED.discounts_allocated,
       tax_allocated = EXCLUDED.tax_allocated,
       returns_units = EXCLUDED.returns_units,
       cancelled_units = EXCLUDED.cancelled_units,
       estimated_margin = EXCLUDED.estimated_margin,
       stock_initial = EXCLUDED.stock_initial,
       stock_final = EXCLUDED.stock_final,
       stock_reserved_final = EXCLUDED.stock_reserved_final,
       stock_available_final = EXCLUDED.stock_available_final,
       stockouts = EXCLUDED.stockouts,
       days_without_sale = EXCLUDED.days_without_sale,
       rolling_units_7 = EXCLUDED.rolling_units_7,
       rolling_units_14 = EXCLUDED.rolling_units_14,
       rolling_units_30 = EXCLUDED.rolling_units_30,
       rolling_units_90 = EXCLUDED.rolling_units_90,
       rolling_revenue_7 = EXCLUDED.rolling_revenue_7,
       rolling_revenue_14 = EXCLUDED.rolling_revenue_14,
       rolling_revenue_30 = EXCLUDED.rolling_revenue_30,
       rolling_revenue_90 = EXCLUDED.rolling_revenue_90,
       avg_units_30 = EXCLUDED.avg_units_30,
       median_units_30 = EXCLUDED.median_units_30,
       stddev_units_30 = EXCLUDED.stddev_units_30,
       trend_units_30 = EXCLUDED.trend_units_30,
       price = EXCLUDED.price,
       lead_time_days = EXCLUDED.lead_time_days,
       pending_purchase_units = EXCLUDED.pending_purchase_units,
       is_data_sufficient = EXCLUDED.is_data_sufficient,
       completeness_score = EXCLUDED.completeness_score,
       duplicate_sale_items_count = EXCLUDED.duplicate_sale_items_count,
       anomaly_count = EXCLUDED.anomaly_count,
       data_quality = EXCLUDED.data_quality,
       source_fingerprint = EXCLUDED.source_fingerprint,
       last_calculated_at = NOW(),
       recalculation_count = daily_variant_features.recalculation_count + 1
     RETURNING variant_id`;
  const { rowCount } = await executePredictiveStatement(
    client,
    PREDICTIVE_STATEMENT_NAMES.variantFeatures,
    sql,
    [ownerAdminId, featureDate, FEATURE_VERSION, runId]
  );
  return rowCount;
}

async function insertStoreFeatures(client, { ownerAdminId, featureDate, runId }) {
  const sql = `INSERT INTO daily_store_features (
       owner_admin_id, feature_date, feature_version, calculation_run_id,
       units_sold, gross_revenue, net_revenue, discounts_allocated, tax_allocated,
       returns_units, cancelled_units, estimated_margin,
       active_products_count, products_with_sales_count, products_stockout_count,
       pending_purchase_units, campaign_events_count, day_of_week, month,
       is_data_sufficient, completeness_score, duplicate_sale_items_count, anomaly_count,
       data_quality, source_fingerprint, last_calculated_at
     )
     SELECT
       $1::int,
       $2::date,
       $3::text,
       $4::uuid,
       COALESCE(SUM(dpf.units_sold), 0),
       COALESCE(SUM(dpf.gross_revenue), 0),
       COALESCE(SUM(dpf.net_revenue), 0),
       COALESCE(SUM(dpf.discounts_allocated), 0),
       COALESCE(SUM(dpf.tax_allocated), 0),
       COALESCE(SUM(dpf.returns_units), 0),
       COALESCE(SUM(dpf.cancelled_units), 0),
       COALESCE(SUM(dpf.estimated_margin), 0),
       COUNT(*)::int,
       COUNT(*) FILTER (WHERE dpf.units_sold > 0)::int,
       COUNT(*) FILTER (WHERE dpf.stock_available_final <= 0)::int,
       COALESCE(SUM(dpf.pending_purchase_units), 0),
       COALESCE(SUM(dpf.campaign_events_count), 0)::int,
       EXTRACT(DOW FROM $2::date)::smallint,
       EXTRACT(MONTH FROM $2::date)::smallint,
       (COALESCE(SUM(dpf.rolling_units_90), 0) >= 10 AND COALESCE(AVG(dpf.completeness_score), 0) >= 0.65),
       COALESCE(AVG(dpf.completeness_score), 0)::numeric(5,4),
       COALESCE(SUM(dpf.duplicate_sale_items_count), 0)::int,
       COALESCE(SUM(dpf.anomaly_count), 0)::int,
       jsonb_build_object(
         'source', 'daily_product_features',
         'productRows', COUNT(*),
         'insufficientProducts', COUNT(*) FILTER (WHERE dpf.is_data_sufficient = false),
         'qualityAverage', COALESCE(AVG(dpf.completeness_score), 0)
       ),
       md5(jsonb_build_object(
         'units', COALESCE(SUM(dpf.units_sold), 0),
         'net', COALESCE(SUM(dpf.net_revenue), 0),
         'margin', COALESCE(SUM(dpf.estimated_margin), 0),
         'quality', COALESCE(AVG(dpf.completeness_score), 0)
       )::text),
       NOW()
     FROM daily_product_features dpf
     WHERE dpf.owner_admin_id = $1
       AND dpf.feature_date = $2::date
       AND dpf.feature_version = $3
     ON CONFLICT (owner_admin_id, feature_date, feature_version)
     DO UPDATE SET
       calculation_run_id = EXCLUDED.calculation_run_id,
       units_sold = EXCLUDED.units_sold,
       gross_revenue = EXCLUDED.gross_revenue,
       net_revenue = EXCLUDED.net_revenue,
       discounts_allocated = EXCLUDED.discounts_allocated,
       tax_allocated = EXCLUDED.tax_allocated,
       returns_units = EXCLUDED.returns_units,
       cancelled_units = EXCLUDED.cancelled_units,
       estimated_margin = EXCLUDED.estimated_margin,
       active_products_count = EXCLUDED.active_products_count,
       products_with_sales_count = EXCLUDED.products_with_sales_count,
       products_stockout_count = EXCLUDED.products_stockout_count,
       pending_purchase_units = EXCLUDED.pending_purchase_units,
       campaign_events_count = EXCLUDED.campaign_events_count,
       is_data_sufficient = EXCLUDED.is_data_sufficient,
       completeness_score = EXCLUDED.completeness_score,
       duplicate_sale_items_count = EXCLUDED.duplicate_sale_items_count,
       anomaly_count = EXCLUDED.anomaly_count,
       data_quality = EXCLUDED.data_quality,
       source_fingerprint = EXCLUDED.source_fingerprint,
       last_calculated_at = NOW(),
       recalculation_count = daily_store_features.recalculation_count + 1
     RETURNING owner_admin_id`;
  const { rowCount } = await executePredictiveStatement(
    client,
    PREDICTIVE_STATEMENT_NAMES.storeFeatures,
    sql,
    [ownerAdminId, featureDate, FEATURE_VERSION, runId]
  );
  return rowCount;
}

async function auditPredictiveDataQuality({ ownerAdminId, dateFrom, dateTo }, client = db) {
  const from = toDateOnly(dateFrom, 'dateFrom');
  const to = toDateOnly(dateTo, 'dateTo');
  const sql = `WITH sales_scope AS (
       SELECT s.*
       FROM sales s
       WHERE s.owner_admin_id = $1
         AND s.sale_date::date BETWEEN $2::date AND $3::date
     ),
     item_scope AS (
       SELECT si.*
       FROM sale_items si
       JOIN sales_scope s ON s.id = si.sale_id
     ),
     duplicate_items AS (
       SELECT sale_id, product_id, COALESCE(variant_id, 0) AS variant_key, COUNT(*) AS c
       FROM item_scope
       GROUP BY sale_id, product_id, COALESCE(variant_id, 0)
       HAVING COUNT(*) > 1
     )
     SELECT
        (SELECT COUNT(*)::int FROM sales_scope) AS sales_count,
        (SELECT COUNT(*)::int FROM item_scope) AS sale_items_count,
        (SELECT COUNT(*)::int FROM duplicate_items) AS duplicate_sale_item_groups,
        (SELECT COUNT(*)::int FROM item_scope WHERE quantity < 0 OR subtotal < 0 OR unit_price < 0) AS sale_item_anomalies,
        (SELECT COUNT(*)::int FROM products p WHERE p.owner_admin_id = $1 AND COALESCE(p.is_active, true) = true AND p.purchase_price IS NULL) AS products_missing_cost,
        (SELECT COUNT(*)::int FROM products p WHERE p.owner_admin_id = $1 AND COALESCE(p.is_active, true) = true AND p.supplier_lead_time_days IS NULL) AS products_missing_lead_time,
        (SELECT COUNT(*)::int FROM stock_ledger sl WHERE sl.owner_admin_id = $1 AND sl.created_at::date BETWEEN $2::date AND $3::date AND sl.qty_after < 0) AS negative_stock_events,
        (SELECT COUNT(*)::int FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.purchase_order_id WHERE po.owner_admin_id = $1 AND poi.quantity < COALESCE(poi.received_quantity, 0)) AS purchase_overreceived_items`;
  const { rows } = await executePredictiveStatement(
    client,
    PREDICTIVE_STATEMENT_NAMES.dataQuality,
    sql,
    [ownerAdminId, from, to]
  );
  return rows[0] || {};
}

async function rebuildPredictiveFeatures({ ownerAdminId, dateFrom, dateTo, userId = null, runType = 'feature_backfill' }) {
  if (!ownerAdminId) throw createPredictiveError('ownerAdminId es requerido', 'AURA_PREDICTIVE_TENANT_REQUIRED');
  const dates = eachDateInRange(dateFrom, dateTo);
  const runId = crypto.randomUUID();
  const client = await db.connect();

  try {
    await client.query('BEGIN');
    await acquireRangeLock(client, ownerAdminId, dates[0], dates[dates.length - 1]);

    await client.query(
      `INSERT INTO prediction_runs
         (id, owner_admin_id, run_type, feature_version, status, date_from, date_to, requested_by, metadata)
       VALUES ($1,$2,$3,$4,'running',$5,$6,$7,$8::jsonb)`,
      [
        runId,
        ownerAdminId,
        runType,
        FEATURE_VERSION,
        dates[0],
        dates[dates.length - 1],
        userId,
        JSON.stringify({ days: dates.length }),
      ]
    );

    const hasCampaignTables = await tableExists(client, 'campaign_events')
      && await tableExists(client, 'campaign_assets');

    let rowsCount = 0;
    for (const featureDate of dates) {
      rowsCount += await insertProductFeatures(client, { ownerAdminId, featureDate, runId, hasCampaignTables });
      rowsCount += await insertVariantFeatures(client, { ownerAdminId, featureDate, runId });
      rowsCount += await insertStoreFeatures(client, { ownerAdminId, featureDate, runId });
    }

    const quality = await auditPredictiveDataQuality({
      ownerAdminId,
      dateFrom: dates[0],
      dateTo: dates[dates.length - 1],
    }, client);

    await client.query(
      `UPDATE prediction_runs
       SET status = 'completed',
           rows_count = $2,
           data_quality = $3::jsonb,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [runId, rowsCount, JSON.stringify(quality)]
    );

    await client.query('COMMIT');
    return {
      runId,
      ownerAdminId: Number(ownerAdminId),
      featureVersion: FEATURE_VERSION,
      dateFrom: dates[0],
      dateTo: dates[dates.length - 1],
      rowsCount,
      dataQuality: quality,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function listActiveTenantIds(client = db, ownerAdminId = null) {
  const requestedOwnerAdminId = ownerAdminId === null || ownerAdminId === undefined
    ? null
    : Number(ownerAdminId);
  if (
    requestedOwnerAdminId !== null
    && (!Number.isSafeInteger(requestedOwnerAdminId) || requestedOwnerAdminId <= 0)
  ) {
    throw createPredictiveError(
      'ownerAdminId invalido',
      'AURA_PREDICTIVE_TENANT_INVALID'
    );
  }
  const { rows } = await client.query(
    `SELECT DISTINCT u.id
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     WHERE u.owner_admin_id IS NULL
       AND COALESCE(u.is_active, true) = true
       AND r.name = 'admin'
       AND ($1::int IS NULL OR u.id = $1)
     ORDER BY u.id`,
    [requestedOwnerAdminId]
  );
  return rows.map((row) => Number(row.id));
}

async function runDailyPredictiveFeatureJob({
  targetDate = addDays(new Date().toISOString().slice(0, 10), -1),
  ownerAdminId = null,
  throwOnError = false,
} = {}) {
  const featureDate = toDateOnly(targetDate, 'targetDate');
  const tenantIds = await listActiveTenantIds(db, ownerAdminId);
  const results = [];
  for (const ownerAdminId of tenantIds) {
    try {
      const result = await rebuildPredictiveFeatures({
        ownerAdminId,
        dateFrom: featureDate,
        dateTo: featureDate,
        runType: 'feature_daily',
      });
      results.push({ ownerAdminId, success: true, ...result });
    } catch (err) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'aura_predictive_daily_failed',
        ownerAdminId,
        code: err.code || 'AURA_PREDICTIVE_ERROR',
      }));
      if (throwOnError) throw err;
      results.push({ ownerAdminId, success: false, code: err.code || 'AURA_PREDICTIVE_ERROR' });
    }
  }
  return { featureDate, tenants: results.length, results };
}

module.exports = {
  FEATURE_VERSION,
  MAX_BACKFILL_DAYS,
  eachDateInRange,
  isPaidNonCancelledSale,
  isCancelledSale,
  allocateItemDiscount,
  buildProductFeatureSnapshot,
  auditPredictiveDataQuality,
  rebuildPredictiveFeatures,
  runDailyPredictiveFeatureJob,
  listActiveTenantIds,
};
