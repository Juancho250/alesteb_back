// services/agent.cron.js
// ── Tareas programadas del agente ──────────────────────────────────────────
// Requiere: npm install node-cron
// Inicializar en app.js:  require('./services/agent.cron');

const cron  = require("node-cron");
const { TOOLS } = require("./agent.tools");
const db    = require("../config/db");
const Groq  = require("groq-sdk");
const { recordUsage } = require("./token-budget");

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── Helper: sintetizar texto con el LLM ──────────────────────────────────────
// Usa llama3-8b-8192 (modelo ligero) para síntesis automáticas de cron.
// Misma calidad para resúmenes ejecutivos, pero a ~1/5 del costo de tokens.
async function synthesize(prompt, data) {
  const res = await groq.chat.completions.create({
    model: "llama3-8b-8192",   // ← modelo ligero para tareas automáticas
    messages: [{
      role: "user",
      content: `${prompt}\n\nDatos: ${JSON.stringify(data).slice(0, 4000)}\n\nResponde en español. Puntos de miles. Máximo 2 párrafos.`,
    }],
    temperature: 0.2,
    max_tokens: 400,           // ← resúmenes de cron no necesitan más
  });

  const used = res.usage?.total_tokens || 400;
  recordUsage(used);

  return res.choices[0].message.content.trim();
}

// ── 1. Alerta de stock bajo — cada hora ──────────────────────────────────────
cron.schedule("0 * * * *", async () => {
  try {
    const { alerts, count } = await TOOLS.check_stock_alerts({ threshold_factor: 1.2 });
    if (count === 0) return;

    const critical = alerts.filter(a => a.status === "out");
    const low      = alerts.filter(a => a.status === "low");

    const summary = await synthesize(
      "Resume las alertas de inventario de forma ejecutiva para el dueño del negocio.",
      { critical_out_of_stock: critical.length, low_stock: low.length, products: alerts.slice(0, 10) }
    );

    // Notificar por WebSocket a todos los admins conectados
    await TOOLS.notify({
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

    // Email solo si hay productos agotados
    if (critical.length > 0 && process.env.ADMIN_EMAIL) {
      const productList = critical.map(p => `- ${p.name} (SKU: ${p.sku || "N/A"}): AGOTADO`).join("\n");
      await TOOLS.notify({
        channel: "email",
        event: "stock_critical",
        payload: {},
        email_to: process.env.ADMIN_EMAIL,
        email_subject: `⚠️ Alesteb ERP — ${critical.length} producto(s) AGOTADO(S)`,
        email_body: `<h2>Alerta de stock crítico</h2><p>${summary}</p><pre>${productList}</pre>`,
      });
    }

    console.log(`[Cron stock] ${count} alertas enviadas (${critical.length} críticas)`);
  } catch (e) {
    console.error("[Cron stock error]", e.message);
  }
});

// ── 2. Reporte diario — lunes a sábado a las 8 AM ────────────────────────────
cron.schedule("0 8 * * 1-6", async () => {
  try {
    const context = await TOOLS.get_erp_context();

    // Ventas de ayer
    const { rows: yesterday } = await db.query(`
      SELECT COUNT(*) as orders, SUM(total) as revenue, SUM(CASE WHEN payment_status='paid' THEN total END) as collected
      FROM sales WHERE DATE(sale_date) = CURRENT_DATE - 1
    `);

    // Top productos ayer
    const { rows: topProds } = await db.query(`
      SELECT p.name, SUM(si.quantity) as units, SUM(si.subtotal) as revenue
      FROM sale_items si JOIN products p ON p.id = si.product_id
      JOIN sales s ON s.id = si.sale_id WHERE DATE(s.sale_date) = CURRENT_DATE - 1
      GROUP BY p.name ORDER BY revenue DESC LIMIT 5
    `);

    // generate_report usa llama-3.3-70b internamente vía agent.tools.js
    // Se mantiene para reportes diarios donde la calidad importa más
    const { report } = await TOOLS.generate_report({
      title: `Reporte diario — ${new Date().toLocaleDateString("es-CO", { weekday: "long", day: "numeric", month: "long" })}`,
      data: { yesterday: yesterday[0], top_products: topProds, erp_context: context },
      format: "markdown",
    });

    if (process.env.ADMIN_EMAIL) {
      await TOOLS.notify({
        channel: "both",
        event: "daily_report",
        payload: { title: "Reporte diario listo", summary: report.slice(0, 200) },
        email_to: process.env.ADMIN_EMAIL,
        email_subject: `📊 Alesteb — Reporte del ${new Date().toLocaleDateString("es-CO")}`,
        email_body: `<div style="font-family:sans-serif;font-size:14px;max-width:600px">${report.replace(/\n/g, "<br>")}</div>`,
      });
    }

    console.log("[Cron daily] Reporte diario enviado");
  } catch (e) {
    console.error("[Cron daily error]", e.message);
  }
});

// ── 3. Monitoreo de facturas vencidas — cada día a las 9 AM ─────────────────
cron.schedule("0 9 * * *", async () => {
  try {
    const { rows } = await db.query(`
      SELECT provider_name, invoice_number, total_amount, pending_amount, days_overdue
      FROM v_invoices_summary
      WHERE days_overdue > 0 AND payment_status != 'paid'
      ORDER BY days_overdue DESC LIMIT 20
    `);
    if (rows.length === 0) return;

    const summary = await synthesize(
      "Genera un resumen ejecutivo de las facturas vencidas para tomar acción urgente.",
      rows
    );

    await TOOLS.notify({
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

    if (process.env.ADMIN_EMAIL) {
      await TOOLS.notify({
        channel: "email",
        event: "invoices_overdue",
        payload: {},
        email_to: process.env.ADMIN_EMAIL,
        email_subject: `🔴 Alesteb — ${rows.length} factura(s) vencida(s)`,
        email_body: `<h2>Facturas vencidas</h2><p>${summary}</p>`,
      });
    }

    console.log(`[Cron invoices] ${rows.length} facturas vencidas notificadas`);
  } catch (e) {
    console.error("[Cron invoices error]", e.message);
  }
});

// ── 4. Reporte semanal — domingo a las 9 AM ──────────────────────────────────
cron.schedule("0 9 * * 0", async () => {
  try {
    const { rows: weekSales } = await db.query(`
      SELECT DATE_TRUNC('day', sale_date) as day,
             COUNT(*) as orders, SUM(total) as revenue, SUM(total_profit) as profit
      FROM v_sales_full
      WHERE sale_date >= NOW() - INTERVAL '7 days'
      GROUP BY 1 ORDER BY 1
    `);

    const { rows: topProfit } = await db.query(`
      SELECT name, units_sold, total_revenue, realized_profit, margin_pct
      FROM v_profit_analysis ORDER BY realized_profit DESC LIMIT 10
    `);

    const { report } = await TOOLS.generate_report({
      title: "Reporte semanal de rendimiento",
      data: { sales_by_day: weekSales, top_profit_products: topProfit },
      format: "markdown",
    });

    if (process.env.ADMIN_EMAIL) {
      await TOOLS.notify({
        channel: "both",
        event: "weekly_report",
        payload: { title: "Reporte semanal listo" },
        email_to: process.env.ADMIN_EMAIL,
        email_subject: `📈 Alesteb — Reporte semanal`,
        email_body: `<div style="font-family:sans-serif;font-size:14px;max-width:600px">${report.replace(/\n/g, "<br>")}</div>`,
      });
    }

    console.log("[Cron weekly] Reporte semanal enviado");
  } catch (e) {
    console.error("[Cron weekly error]", e.message);
  }
});

console.log("[Agent Cron] Tareas programadas activas: stock(1h), diario(8AM L-S), facturas(9AM), semanal(Dom 9AM)");