// services/agent.tools.js
// DEPRECATED: legacy agent tools. Free-form SQL execution is disabled in the
// secure AURA MVP. Keep this file only for compatibility with deprecated code.
const db = require("../src/platform/database");
const { getIO } = require("../config/socket");
const Groq = require("groq-sdk");
const { sendAgentReportEmail } = require("../config/emailConfig");

function legacyToolError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function normalizeOwnerAdminId(ownerAdminId) {
  const parsed = Number(ownerAdminId);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function requireOwnerAdminId(ownerAdminId) {
  const parsed = normalizeOwnerAdminId(ownerAdminId);
  if (!parsed) {
    throw legacyToolError(
      "ownerAdminId explicito requerido para herramientas legacy.",
      "LEGACY_AGENT_TENANT_REQUIRED"
    );
  }
  return parsed;
}

function freeFormSqlDisabled() {
  throw legacyToolError(
    "La ejecucion de SQL libre por el agente legacy esta deshabilitada en el MVP seguro.",
    "LEGACY_AGENT_SQL_DISABLED"
  );
}

function getBrevoClient() {
  const brevo = require("@getbrevo/brevo");
  const apiInstance = new brevo.TransactionalEmailsApi();
  const SendSmtpEmail = brevo.SendSmtpEmail;

  apiInstance.setApiKey(
    brevo.TransactionalEmailsApiApiKeys.apiKey,
    process.env.BREVO_API_KEY
  );

  return { apiInstance, SendSmtpEmail };
}

async function sendBrevoEmail({ to, subject, body }) {
  if (!process.env.BREVO_API_KEY) {
    console.warn("[Agent notify] BREVO_API_KEY no configurada; email omitido");
    return { email: "skipped: no api key" };
  }

  const { apiInstance, SendSmtpEmail } = getBrevoClient();
  const mail = new SendSmtpEmail();

  mail.sender = {
    name: "Alesteb ERP",
    email: process.env.BREVO_SENDER_EMAIL || "softturin@gmail.com",
  };
  mail.to = [{ email: to }];
  mail.subject = subject || "Alesteb ERP - Notificacion del agente";
  mail.htmlContent = `<div style="font-family:sans-serif;font-size:14px;line-height:1.7;max-width:600px">${body}</div>`;
  mail.textContent = String(body || "").replace(/<[^>]+>/g, "");

  const data = await apiInstance.sendTransacEmail(mail);
  return { email: "sent", messageId: data.messageId };
}

function isMarkdownReport(text) {
  if (!text) return false;
  return /^#{1,3}\s/m.test(text) || /^\|.+\|$/m.test(text);
}

async function query_erp({ sql }) {
  void sql;
  freeFormSqlDisabled();
}

async function mutate_erp({ sql, confirmed = false, reason }) {
  void sql;
  void confirmed;
  void reason;
  freeFormSqlDisabled();
}

async function notify({
  ownerAdminId,
  channel,
  event,
  payload,
  email_to,
  email_subject,
  email_body,
}) {
  const safeOwnerAdminId = requireOwnerAdminId(ownerAdminId);
  const results = {};

  if (channel === "websocket" || channel === "both") {
    try {
      const io = getIO();
      if (!io) {
        results.websocket = "skipped: socket unavailable";
      } else {
        io.to(`admin_${safeOwnerAdminId}`).emit(event || "agent_notification", {
          ...(payload || {}),
          ownerAdminId: safeOwnerAdminId,
        });
        results.websocket = "sent";
      }
    } catch (err) {
      results.websocket = `error: ${err.message}`;
    }
  }

  if ((channel === "email" || channel === "both") && email_to) {
    try {
      if (isMarkdownReport(email_body)) {
        await sendAgentReportEmail(
          email_to,
          email_subject || "Reporte del Agente IA",
          email_body
        );
        results.email = "sent";
      } else {
        const htmlBody = email_body || `
          <pre style="background:#f8fafc;padding:16px;border-radius:8px;font-size:13px">
            ${JSON.stringify(payload || {}, null, 2)}
          </pre>
        `;
        const emailResult = await sendBrevoEmail({
          to: email_to,
          subject: email_subject || "Alesteb ERP - Notificacion del agente",
          body: htmlBody,
        });
        results.email = emailResult.email;
        if (emailResult.messageId) results.messageId = emailResult.messageId;
      }
    } catch (err) {
      console.error("[Agent notify email error]", err.message);
      results.email = `error: ${err.message}`;
    }
  }

  return results;
}

async function generate_report({ title, data, format = "text" }) {
  if (!process.env.GROQ_API_KEY) {
    return {
      report: `# ${title || "Reporte"}\n\nReporte no generado: GROQ_API_KEY no esta configurada.`,
    };
  }

  const rows = Array.isArray(data) ? data : [data];
  const prompt = `Genera un reporte ejecutivo en espanol titulado "${title}".
Datos: ${JSON.stringify(rows).slice(0, 8000)}
Formato: ${format === "markdown" ? "Markdown con tablas" : "Texto plano con secciones claras"}.
Usa puntos de miles. No inventes datos. Se conciso pero completo.`;

  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const res = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    max_tokens: 2048,
  });
  return { report: res.choices[0].message.content.trim() };
}

async function check_stock_alerts({ ownerAdminId, threshold_factor = 1.0 }) {
  const safeOwnerAdminId = requireOwnerAdminId(ownerAdminId);
  const { rows } = await db.query(
    `SELECT id, name, sku, stock, min_stock, sale_price,
            CASE WHEN stock = 0 THEN 'out'
                 WHEN stock <= min_stock THEN 'low'
                 ELSE 'ok'
            END AS status
     FROM products
     WHERE owner_admin_id = $1
       AND is_active = true
       AND stock <= min_stock * $2
     ORDER BY stock ASC
     LIMIT 50`,
    [safeOwnerAdminId, threshold_factor]
  );
  return { alerts: rows, count: rows.length };
}

async function get_erp_context({ ownerAdminId }) {
  const safeOwnerAdminId = requireOwnerAdminId(ownerAdminId);
  const [sales, stock, invoices, cashflow] = await Promise.all([
    db.query(
      `SELECT COUNT(*) as total,
              SUM(total) as revenue,
              SUM(CASE WHEN payment_status = 'pending' THEN 1 ELSE 0 END) as pending
       FROM sales
       WHERE owner_admin_id = $1
         AND sale_date >= NOW() - INTERVAL '30 days'`,
      [safeOwnerAdminId]
    ),
    db.query(
      `SELECT COUNT(*) as low
       FROM products
       WHERE owner_admin_id = $1
         AND is_active = true
         AND stock <= min_stock`,
      [safeOwnerAdminId]
    ),
    db.query(
      `SELECT COUNT(*) as overdue,
              SUM(pending_amount) as total_pending
       FROM v_invoices_summary
       WHERE owner_admin_id = $1
         AND days_overdue > 0`,
      [safeOwnerAdminId]
    ),
    db.query(
      `SELECT SUM(daily_income) as income,
              SUM(daily_expenses) as expenses
       FROM v_cashflow_detailed
       WHERE owner_admin_id = $1
         AND date >= NOW() - INTERVAL '7 days'`,
      [safeOwnerAdminId]
    ),
  ]);

  return {
    last_30_days: sales.rows[0],
    low_stock_products: stock.rows[0].low,
    overdue_invoices: invoices.rows[0],
    last_7_days_cashflow: cashflow.rows[0],
  };
}

const TOOLS = {
  query_erp,
  mutate_erp,
  notify,
  generate_report,
  check_stock_alerts,
  get_erp_context,
};

const TOOL_DESCRIPTIONS = `
HERRAMIENTAS LEGACY DISPONIBLES:

1. query_erp(sql)
   - Deshabilitada en el MVP seguro. No ejecuta SQL libre generado por IA.

2. mutate_erp(sql, confirmed, reason)
   - Deshabilitada en el MVP seguro. No acepta confirmacion textual y no ejecuta INSERT/UPDATE.

3. notify(ownerAdminId, channel, event, payload, email_to?, email_subject?, email_body?)
   - Requiere ownerAdminId explicito.
   - WebSocket emite solo al room admin_<ownerAdminId>.
   - No usa correos globales como fallback.

4. generate_report(title, data, format?)
   - Sintetiza datos ya obtenidos por consultas deterministicas tenant-scoped.

5. check_stock_alerts(ownerAdminId, threshold_factor?)
   - Consulta productos de bajo stock solo para ownerAdminId.

6. get_erp_context(ownerAdminId)
   - Snapshot tenant-scoped de ventas 30d, stock bajo, facturas vencidas y cashflow 7d.
`;

module.exports = {
  TOOLS,
  TOOL_DESCRIPTIONS,
  requireOwnerAdminId,
  freeFormSqlDisabled,
};
