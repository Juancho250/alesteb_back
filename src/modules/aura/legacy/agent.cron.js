// src/modules/aura/legacy/agent.cron.js
// DEPRECATED: legacy autonomous agent cron. Disabled by default and never
// enabled in production. Worker-safe jobs should live in worker.js services.
const cron = require("node-cron");
const db = require("../../../platform/database");
const { TOOLS } = require("./agent.tools");
const Groq = require("groq-sdk");
const { recordUsage } = require("./token-budget.service");

const ENABLED_VALUE = "true";
const MAX_CONFIGURED_TENANTS = 50;

function isLegacyAgentCronEnabled() {
  return process.env.ENABLE_LEGACY_AGENT_CRON === ENABLED_VALUE
    && process.env.NODE_ENV !== "production";
}

function getLegacyAgentCronStatus() {
  return {
    enabled: isLegacyAgentCronEnabled(),
    requested: process.env.ENABLE_LEGACY_AGENT_CRON === ENABLED_VALUE,
    productionBlocked: process.env.NODE_ENV === "production",
  };
}

function parseConfiguredTenantIds() {
  const raw = process.env.LEGACY_AGENT_CRON_TENANT_IDS || "";
  return [...new Set(
    raw
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isSafeInteger(value) && value > 0)
  )].slice(0, MAX_CONFIGURED_TENANTS);
}

async function loadConfiguredTenants() {
  const ids = parseConfiguredTenantIds();
  if (!ids.length) {
    console.warn("[Agent Cron] LEGACY_AGENT_CRON_TENANT_IDS vacio; no se agenda trabajo legacy.");
    return [];
  }

  const { rows } = await db.query(
    `SELECT u.id AS owner_admin_id, u.email
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     JOIN subscriptions s ON s.admin_id = u.id
     JOIN subscription_plans sp ON sp.id = s.plan_id
     WHERE u.id = ANY($1)
       AND u.is_active = true
       AND u.owner_admin_id IS NULL
       AND r.name = 'admin'
       AND s.status IN ('trial', 'active', 'past_due')
       AND sp.has_ai_agent = true
     ORDER BY u.id
     LIMIT $2`,
    [ids, MAX_CONFIGURED_TENANTS]
  );

  return rows.map((row) => ({
    ownerAdminId: Number(row.owner_admin_id),
    email: row.email,
  }));
}

async function synthesize(prompt, data) {
  if (!process.env.GROQ_API_KEY) {
    return "Resumen no generado: GROQ_API_KEY no esta configurada.";
  }

  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const res = await groq.chat.completions.create({
    model: "llama3-8b-8192",
    messages: [{
      role: "user",
      content: `${prompt}\n\nDatos: ${JSON.stringify(data).slice(0, 4000)}\n\nResponde en espanol. Puntos de miles. Maximo 2 parrafos.`,
    }],
    temperature: 0.2,
    max_tokens: 400,
  });

  const used = res.usage?.total_tokens || 400;
  recordUsage(used);

  return res.choices[0].message.content.trim();
}

async function forEachTenant(taskName, handler) {
  const tenants = await loadConfiguredTenants();
  for (const tenant of tenants) {
    try {
      await handler(tenant);
    } catch (err) {
      console.error(`[Agent Cron ${taskName}] tenant ${tenant.ownerAdminId}:`, err.message);
    }
  }
}

async function runStockAlertForTenant({ ownerAdminId }) {
  const { alerts, count } = await TOOLS.check_stock_alerts({
    ownerAdminId,
    threshold_factor: 1.2,
  });
  if (count === 0) return;

  const critical = alerts.filter((item) => item.status === "out");
  const low = alerts.filter((item) => item.status === "low");
  const summary = await synthesize(
    "Resume las alertas de inventario de forma ejecutiva para el dueno del negocio.",
    {
      critical_out_of_stock: critical.length,
      low_stock: low.length,
      products: alerts.slice(0, 10),
    }
  );

  await TOOLS.notify({
    ownerAdminId,
    channel: "websocket",
    event: "stock_alert",
    payload: {
      type: "stock_alert",
      critical: critical.length,
      low: low.length,
      summary,
      products: alerts.slice(0, 10),
      timestamp: new Date().toISOString(),
    },
  });
}

async function runDailyReportForTenant({ ownerAdminId }) {
  const context = await TOOLS.get_erp_context({ ownerAdminId });
  const { rows: yesterday } = await db.query(
    `SELECT COUNT(*) AS orders,
            SUM(total) AS revenue,
            SUM(CASE WHEN payment_status = 'paid' THEN total END) AS collected
     FROM sales
     WHERE owner_admin_id = $1
       AND DATE(sale_date) = CURRENT_DATE - 1`,
    [ownerAdminId]
  );

  const { rows: topProducts } = await db.query(
    `SELECT p.name,
            SUM(si.quantity) AS units,
            SUM(si.subtotal) AS revenue
     FROM sale_items si
     JOIN products p ON p.id = si.product_id
     JOIN sales s ON s.id = si.sale_id
     WHERE s.owner_admin_id = $1
       AND DATE(s.sale_date) = CURRENT_DATE - 1
     GROUP BY p.name
     ORDER BY revenue DESC
     LIMIT 5`,
    [ownerAdminId]
  );

  const title = `Reporte diario legacy - ${new Date().toLocaleDateString("es-CO", {
    weekday: "long",
    day: "numeric",
    month: "long",
  })}`;

  const { report } = await TOOLS.generate_report({
    title,
    data: {
      yesterday: yesterday[0],
      top_products: topProducts,
      erp_context: context,
    },
    format: "markdown",
  });

  await TOOLS.notify({
    ownerAdminId,
    channel: "websocket",
    event: "daily_report",
    payload: {
      title: "Reporte diario legacy listo",
      summary: report.slice(0, 300),
      timestamp: new Date().toISOString(),
    },
  });
}

async function runOverdueInvoicesForTenant({ ownerAdminId }) {
  const { rows } = await db.query(
    `SELECT provider_name, invoice_number, total_amount, pending_amount, days_overdue
     FROM v_invoices_summary
     WHERE owner_admin_id = $1
       AND days_overdue > 0
       AND payment_status != 'paid'
     ORDER BY days_overdue DESC
     LIMIT 20`,
    [ownerAdminId]
  );
  if (!rows.length) return;

  const summary = await synthesize(
    "Genera un resumen ejecutivo de las facturas vencidas para tomar accion urgente.",
    rows
  );

  await TOOLS.notify({
    ownerAdminId,
    channel: "websocket",
    event: "invoices_overdue",
    payload: {
      type: "invoices_overdue",
      count: rows.length,
      summary,
      invoices: rows.slice(0, 5),
      timestamp: new Date().toISOString(),
    },
  });
}

async function runWeeklyReportForTenant({ ownerAdminId }) {
  const { rows: weekSales } = await db.query(
    `SELECT DATE_TRUNC('day', sale_date) AS day,
            COUNT(*) AS orders,
            SUM(total) AS revenue,
            SUM(total_profit) AS profit
     FROM v_sales_full
     WHERE owner_admin_id = $1
       AND sale_date >= NOW() - INTERVAL '7 days'
     GROUP BY 1
     ORDER BY 1`,
    [ownerAdminId]
  );

  const { rows: topProfit } = await db.query(
    `SELECT name, units_sold, total_revenue, realized_profit, margin_pct
     FROM v_profit_analysis
     WHERE owner_admin_id = $1
     ORDER BY realized_profit DESC
     LIMIT 10`,
    [ownerAdminId]
  );

  const { report } = await TOOLS.generate_report({
    title: "Reporte semanal legacy de rendimiento",
    data: { sales_by_day: weekSales, top_profit_products: topProfit },
    format: "markdown",
  });

  await TOOLS.notify({
    ownerAdminId,
    channel: "websocket",
    event: "weekly_report",
    payload: {
      title: "Reporte semanal legacy listo",
      summary: report.slice(0, 300),
      timestamp: new Date().toISOString(),
    },
  });
}

function scheduleLegacyAgentCron() {
  if (!isLegacyAgentCronEnabled()) {
    const status = getLegacyAgentCronStatus();
    console.log("[Agent Cron] Legacy cron desactivado.", status);
    return [];
  }

  const jobs = [
    cron.schedule("0 * * * *", () => forEachTenant("stock", runStockAlertForTenant)),
    cron.schedule("0 8 * * 1-6", () => forEachTenant("daily", runDailyReportForTenant)),
    cron.schedule("0 9 * * *", () => forEachTenant("invoices", runOverdueInvoicesForTenant)),
    cron.schedule("0 9 * * 0", () => forEachTenant("weekly", runWeeklyReportForTenant)),
  ];

  console.log("[Agent Cron] Legacy cron activo solo para tenants configurados.");
  return jobs;
}

const scheduledJobs = scheduleLegacyAgentCron();

module.exports = {
  isLegacyAgentCronEnabled,
  getLegacyAgentCronStatus,
  parseConfiguredTenantIds,
  loadConfiguredTenants,
  scheduleLegacyAgentCron,
  scheduledJobs,
};
