// services/agent.tools.js
// ── Definición tipada de las herramientas del agente ERP ────────────────────
// Cada tool tiene: name, description, parameters (JSON Schema), y handler.
// El orquestador ReAct elige cuál ejecutar en cada paso del loop.

const db      = require("../config/db");
const { io }  = require("../config/socket");          // socket.js export: { io }
const mailer  = require("../config/emailConfig");      // nodemailer transporter
const Groq    = require("groq-sdk");

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── Tablas y campos permitidos ───────────────────────────────────────────────
const ALLOWED_TABLES = [
  "sales", "sale_items", "coupon_usage",
  "products", "product_variants", "product_images",
  "product_price_history", "categories",
  "attribute_types", "attribute_values", "variant_attribute_values",
  "bundle_items", "variant_images",
  "expenses", "invoices", "invoice_items", "invoice_payments",
  "financial_budgets", "provider_payments",
  "providers", "purchase_orders", "purchase_order_items",
  "discounts", "discount_coupons", "discount_targets",
  "banners", "agent_conversations",
  "v_sales_full", "v_products_full", "v_profit_analysis",
  "v_cashflow_detailed", "v_expenses_summary",
  "v_invoices_summary", "v_provider_balance",
];

const MASK_FIELDS = [
  "customer_phone","shipping_address","shipping_city",
  "shipping_lat","shipping_lng","shipping_notes","payment_proof_url",
  "phone","email","address","contact_person","tax_id","customer_email",
];

const DANGEROUS = /\b(DROP|TRUNCATE|ALTER|CREATE\s+TABLE|DELETE\s+FROM|GRANT|REVOKE|COPY\s+.*\s+TO|pg_read_file|pg_write_file|INTO\s+OUTFILE)\b/i;

function validateSQL(sql, mode) {
  if (DANGEROUS.test(sql)) throw new Error("Operación peligrosa bloqueada.");
  if (mode === "query"  && !/^\s*SELECT\s+/i.test(sql))
    throw new Error("Solo SELECT permitido en query_erp.");
  if (mode === "mutate" && !/^\s*(INSERT|UPDATE)\s+/i.test(sql))
    throw new Error("Solo INSERT/UPDATE permitido en mutate_erp.");
  if (mode === "mutate" && !/WHERE\s+/i.test(sql))
    throw new Error("Las modificaciones deben incluir WHERE.");

  const tableRx = /\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;
  let m;
  while ((m = tableRx.exec(sql)) !== null) {
    if (!ALLOWED_TABLES.includes(m[1].toLowerCase()))
      throw new Error(`Tabla '${m[1]}' no permitida.`);
  }
}

function sanitize(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map(r => {
    const c = { ...r };
    for (const k of Object.keys(c)) {
      if (MASK_FIELDS.some(f => k.toLowerCase() === f.toLowerCase())) c[k] = "***";
      if (/\b(cedula|documento|password|token|secret)\b/i.test(k)) c[k] = "***";
    }
    return c;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// TOOL 1 · query_erp — consulta de solo lectura
// ═══════════════════════════════════════════════════════════════════════════
async function query_erp({ sql }) {
  validateSQL(sql, "query");
  const { rows } = await db.query(sql);
  return { rows: sanitize(rows), count: rows.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// TOOL 2 · mutate_erp — INSERT / UPDATE con bandera de confirmación
//   confirmed=false → sólo planifica, no ejecuta
//   confirmed=true  → ejecuta y devuelve rowCount
// ═══════════════════════════════════════════════════════════════════════════
async function mutate_erp({ sql, confirmed = false, reason }) {
  validateSQL(sql, "mutate");
  if (!confirmed) {
    return {
      status: "needs_confirm",
      sql,
      reason,
      message: "Acción pendiente de confirmación humana.",
    };
  }
  const result = await db.query(sql);
  return { status: "executed", rowCount: result.rowCount, sql };
}

// ═══════════════════════════════════════════════════════════════════════════
// TOOL 3 · notify — WebSocket + email opcionales
// ═══════════════════════════════════════════════════════════════════════════
async function notify({ channel, event, payload, email_to, email_subject, email_body }) {
  const results = {};

  if (channel === "websocket" || channel === "both") {
    try {
      io.emit(event || "agent_notification", payload);
      results.websocket = "sent";
    } catch (e) {
      results.websocket = `error: ${e.message}`;
    }
  }

  if ((channel === "email" || channel === "both") && email_to) {
    try {
      await mailer.sendMail({
        from: process.env.EMAIL_FROM || "erp@alesteb.com",
        to: email_to,
        subject: email_subject || "Alesteb ERP — Notificación del agente",
        text: email_body || JSON.stringify(payload, null, 2),
        html: email_body
          ? `<div style="font-family:sans-serif;font-size:14px">${email_body}</div>`
          : `<pre>${JSON.stringify(payload, null, 2)}</pre>`,
      });
      results.email = "sent";
    } catch (e) {
      results.email = `error: ${e.message}`;
    }
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// TOOL 4 · generate_report — llama al modelo para sintetizar datos en texto
// ═══════════════════════════════════════════════════════════════════════════
async function generate_report({ title, data, format = "text" }) {
  const rows = Array.isArray(data) ? data : [data];
  const prompt = `Genera un reporte ejecutivo en español titulado "${title}".
Datos: ${JSON.stringify(rows).slice(0, 8000)}
Formato: ${format === "markdown" ? "Markdown con tablas" : "Texto plano con secciones claras"}.
Usa puntos de miles. No inventes datos. Sé conciso pero completo.`;

  const res = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    max_tokens: 2048,
  });
  return { report: res.choices[0].message.content.trim() };
}

// ═══════════════════════════════════════════════════════════════════════════
// TOOL 5 · check_stock_alerts — evalúa stock bajo sin SQL manual
// ═══════════════════════════════════════════════════════════════════════════
async function check_stock_alerts({ threshold_factor = 1.0 }) {
  const { rows } = await db.query(`
    SELECT id, name, sku, stock, min_stock, sale_price,
           CASE WHEN stock = 0 THEN 'out' WHEN stock <= min_stock THEN 'low' ELSE 'ok' END AS status
    FROM products
    WHERE is_active = true AND stock <= min_stock * $1
    ORDER BY stock ASC
    LIMIT 50
  `, [threshold_factor]);
  return { alerts: rows, count: rows.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// TOOL 6 · get_erp_context — snapshot del estado actual del ERP
//   Úsala al inicio para que el agente entienda el contexto antes de actuar
// ═══════════════════════════════════════════════════════════════════════════
async function get_erp_context() {
  const [sales, stock, invoices, cashflow] = await Promise.all([
    db.query(`SELECT COUNT(*) as total, SUM(total) as revenue,
                     SUM(CASE WHEN payment_status='pending' THEN 1 ELSE 0 END) as pending
              FROM sales WHERE sale_date >= NOW() - INTERVAL '30 days'`),
    db.query(`SELECT COUNT(*) as low FROM products WHERE is_active=true AND stock <= min_stock`),
    db.query(`SELECT COUNT(*) as overdue, SUM(pending_amount) as total_pending
              FROM v_invoices_summary WHERE days_overdue > 0`),
    db.query(`SELECT SUM(daily_income) as income, SUM(daily_expenses) as expenses
              FROM v_cashflow_detailed WHERE date >= NOW() - INTERVAL '7 days'`),
  ]);
  return {
    last_30_days: sales.rows[0],
    low_stock_products: stock.rows[0].low,
    overdue_invoices: invoices.rows[0],
    last_7_days_cashflow: cashflow.rows[0],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// REGISTRY — mapa de tools para el orquestador
// ═══════════════════════════════════════════════════════════════════════════
const TOOLS = {
  query_erp,
  mutate_erp,
  notify,
  generate_report,
  check_stock_alerts,
  get_erp_context,
};

// Descriptions para el system prompt (las lee el LLM)
const TOOL_DESCRIPTIONS = `
HERRAMIENTAS DISPONIBLES (úsalas en tu loop Thought→Act→Observation):

1. query_erp(sql)
   → Ejecuta SELECT en el ERP. Usa las vistas (v_sales_full, v_profit_analysis, etc.).
   → Siempre LIMIT 100. Devuelve { rows[], count }.

2. mutate_erp(sql, confirmed, reason)
   → INSERT/UPDATE. Si confirmed=false, devuelve plan para confirmación humana.
   → Si confirmed=true, ejecuta. SIEMPRE incluye WHERE.

3. notify(channel, event, payload, email_to?, email_subject?, email_body?)
   → channel: "websocket" | "email" | "both"
   → Úsala para alertas de stock, reportes listos, acciones ejecutadas.

4. generate_report(title, data, format?)
   → Sintetiza datos en reporte legible. format: "text" | "markdown"

5. check_stock_alerts(threshold_factor?)
   → Devuelve productos con stock bajo o agotado. threshold_factor: 1.0 = exactamente en min_stock.

6. get_erp_context()
   → Snapshot del ERP: ventas 30d, stock bajo, facturas vencidas, cashflow 7d.
   → Úsala SIEMPRE al inicio de conversaciones complejas.
`;

module.exports = { TOOLS, TOOL_DESCRIPTIONS };