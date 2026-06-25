const db = require("../config/db");

const MAX_ROWS = 10;

const emptyInsights = () => ({
  salesToday: 0,
  salesMonth: 0,
  averageTicket: 0,
  pendingOrders: 0,
  lowStockProducts: [],
  sleepingProducts: [],
  topProducts: [],
  pendingSupplierOrders: [],
  recentCustomersCount: 0,
});

const roundMoney = (value) => Math.round(Number(value || 0));

const scopeClause = ({ isSuperAdmin, adminId, alias = "", startIndex = 1 }) => {
  if (isSuperAdmin) return { clause: "", params: [], nextIndex: startIndex };
  return {
    clause: `AND ${alias}owner_admin_id = $${startIndex}`,
    params: [adminId],
    nextIndex: startIndex + 1,
  };
};

async function tableExists(tableName) {
  const { rows } = await db.query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [tableName]
  );
  return Boolean(rows[0]?.exists);
}

async function columnExists(tableName, columnName) {
  const { rows } = await db.query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = $1
         AND column_name = $2
     ) AS exists`,
    [tableName, columnName]
  );
  return Boolean(rows[0]?.exists);
}

async function safeQuery(label, query, params = [], fallback = null) {
  try {
    const { rows } = await db.query(query, params);
    return rows;
  } catch (err) {
    console.warn(`[AURA context] ${label}: ${err.message}`);
    return fallback;
  }
}

async function getSalesSummary(scope) {
  const s = scopeClause({ ...scope, alias: "s." });
  const rows = await safeQuery(
    "sales summary",
    `SELECT
       COALESCE(SUM(CASE WHEN s.sale_date::date = CURRENT_DATE THEN s.total ELSE 0 END), 0) AS sales_today,
       COALESCE(SUM(CASE WHEN DATE_TRUNC('month', s.sale_date) = DATE_TRUNC('month', NOW()) THEN s.total ELSE 0 END), 0) AS sales_month,
       COALESCE(AVG(CASE WHEN DATE_TRUNC('month', s.sale_date) = DATE_TRUNC('month', NOW()) THEN s.total END), 0) AS average_ticket
     FROM sales s
     WHERE s.payment_status = 'paid' ${s.clause}`,
    s.params,
    []
  );

  const row = rows?.[0] || {};
  return {
    salesToday: roundMoney(row.sales_today),
    salesMonth: roundMoney(row.sales_month),
    averageTicket: roundMoney(row.average_ticket),
  };
}

async function getPendingOrders(scope) {
  const hasDeliveryStatus = await columnExists("sales", "delivery_status");
  const deliveryFilter = hasDeliveryStatus
    ? "OR s.delivery_status NOT IN ('delivered', 'cancelled')"
    : "";
  const s = scopeClause({ ...scope, alias: "s." });

  const rows = await safeQuery(
    "pending orders",
    `SELECT COUNT(*)::int AS count
     FROM sales s
     WHERE (s.payment_status IN ('pending', 'partial') ${deliveryFilter}) ${s.clause}`,
    s.params,
    []
  );

  return Number(rows?.[0]?.count || 0);
}

async function getLowStockProducts(scope) {
  const s = scopeClause({ ...scope, alias: "p." });
  const rows = await safeQuery(
    "low stock products",
    `SELECT
       p.id,
       p.name,
       p.sku,
       COALESCE(p.stock, 0)::int AS stock,
       COALESCE(p.min_stock, 0)::int AS "minStock"
     FROM products p
     WHERE p.is_active = true
       AND COALESCE(p.stock, 0) <= COALESCE(p.min_stock, 5)
       ${s.clause}
     ORDER BY COALESCE(p.stock, 0) ASC, p.name ASC
     LIMIT ${MAX_ROWS}`,
    s.params,
    []
  );

  return (rows || []).map((row) => ({
    id: row.id,
    name: row.name,
    sku: row.sku,
    stock: Number(row.stock || 0),
    minStock: Number(row.minStock || 0),
  }));
}

async function getSleepingProducts(scope) {
  const s = scopeClause({ ...scope, alias: "p." });
  const rows = await safeQuery(
    "sleeping products",
    `SELECT
       p.id,
       p.name,
       p.sku,
       COALESCE(p.stock, 0)::int AS stock,
       MAX(s.sale_date) AS "lastSaleAt"
     FROM products p
     LEFT JOIN sale_items si ON si.product_id = p.id
     LEFT JOIN sales s ON s.id = si.sale_id
     WHERE p.is_active = true ${s.clause}
     GROUP BY p.id, p.name, p.sku, p.stock
     HAVING MAX(s.sale_date) IS NULL
        OR MAX(s.sale_date) < NOW() - INTERVAL '60 days'
     ORDER BY MAX(s.sale_date) ASC NULLS FIRST, p.name ASC
     LIMIT ${MAX_ROWS}`,
    s.params,
    []
  );

  return (rows || []).map((row) => ({
    id: row.id,
    name: row.name,
    sku: row.sku,
    stock: Number(row.stock || 0),
    lastSaleAt: row.lastSaleAt || null,
  }));
}

async function getTopProducts(scope) {
  const s = scopeClause({ ...scope, alias: "p." });
  const rows = await safeQuery(
    "top products",
    `SELECT
       p.id,
       p.name,
       p.sku,
       COALESCE(SUM(si.quantity), 0)::int AS units,
       ROUND(COALESCE(SUM(si.subtotal), 0), 0) AS revenue
     FROM sale_items si
     JOIN sales s ON s.id = si.sale_id
     JOIN products p ON p.id = si.product_id
     WHERE s.sale_date >= NOW() - INTERVAL '30 days'
       AND s.payment_status = 'paid'
       ${s.clause}
     GROUP BY p.id, p.name, p.sku
     ORDER BY units DESC, revenue DESC
     LIMIT ${MAX_ROWS}`,
    s.params,
    []
  );

  return (rows || []).map((row) => ({
    id: row.id,
    name: row.name,
    sku: row.sku,
    units: Number(row.units || 0),
    revenue: roundMoney(row.revenue),
  }));
}

async function getPendingSupplierOrders(scope) {
  if (!(await tableExists("purchase_orders"))) return [];

  const providerExists = await tableExists("providers");
  const s = scopeClause({ ...scope, alias: "po." });
  const providerJoin = providerExists
    ? "LEFT JOIN providers pr ON pr.id = po.provider_id"
    : "";
  const providerSelect = providerExists
    ? "pr.name AS provider_name,"
    : "NULL::text AS provider_name,";

  const rows = await safeQuery(
    "pending supplier orders",
    `SELECT
       po.id,
       po.order_number AS "orderNumber",
       po.status,
       ROUND(COALESCE(po.total_cost, 0), 0) AS "totalCost",
       ${providerSelect}
       po.expected_delivery_date AS "expectedDeliveryDate"
     FROM purchase_orders po
     ${providerJoin}
     WHERE po.status NOT IN ('received', 'cancelled') ${s.clause}
     ORDER BY po.expected_delivery_date ASC NULLS LAST, po.created_at DESC
     LIMIT ${MAX_ROWS}`,
    s.params,
    []
  );

  return (rows || []).map((row) => ({
    id: row.id,
    orderNumber: row.orderNumber,
    status: row.status,
    totalCost: roundMoney(row.totalCost),
    providerName: row.provider_name || null,
    expectedDeliveryDate: row.expectedDeliveryDate || null,
  }));
}

async function getRecentCustomersCount(scope) {
  const s = scopeClause({ ...scope, alias: "u." });
  const rows = await safeQuery(
    "recent customers count",
    `SELECT COUNT(DISTINCT u.id)::int AS count
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     WHERE r.name = 'user'
       AND u.created_at >= NOW() - INTERVAL '30 days'
       ${s.clause}`,
    s.params,
    []
  );

  return Number(rows?.[0]?.count || 0);
}

function buildContextSummary(insights) {
  return {
    period: {
      today: new Date().toISOString().slice(0, 10),
      salesWindow: "mes actual",
      topProductsWindow: "ultimos 30 dias",
      sleepingProductsWindow: "sin ventas en 60 dias o mas",
    },
    metrics: {
      salesToday: insights.salesToday,
      salesMonth: insights.salesMonth,
      averageTicket: insights.averageTicket,
      pendingOrders: insights.pendingOrders,
      recentCustomersCount: insights.recentCustomersCount,
    },
    lists: {
      lowStockProducts: insights.lowStockProducts,
      sleepingProducts: insights.sleepingProducts,
      topProducts: insights.topProducts,
      pendingSupplierOrders: insights.pendingSupplierOrders,
    },
  };
}

async function getAuraBusinessContext({ adminId, isSuperAdmin }) {
  const scope = { adminId, isSuperAdmin };
  const insights = emptyInsights();

  const [
    salesSummary,
    pendingOrders,
    lowStockProducts,
    sleepingProducts,
    topProducts,
    pendingSupplierOrders,
    recentCustomersCount,
  ] = await Promise.all([
    getSalesSummary(scope),
    getPendingOrders(scope),
    getLowStockProducts(scope),
    getSleepingProducts(scope),
    getTopProducts(scope),
    getPendingSupplierOrders(scope),
    getRecentCustomersCount(scope),
  ]);

  Object.assign(insights, salesSummary, {
    pendingOrders,
    lowStockProducts,
    sleepingProducts,
    topProducts,
    pendingSupplierOrders,
    recentCustomersCount,
  });

  return {
    insights,
    promptContext: buildContextSummary(insights),
  };
}

module.exports = { getAuraBusinessContext };
