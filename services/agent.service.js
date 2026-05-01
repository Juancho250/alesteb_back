const { GoogleGenerativeAI } = require("@google/generative-ai");
const db = require("../config/db");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ── Tablas permitidas ────────────────────────────────────────────────
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
  // Vistas
  "v_sales_full", "v_products_full", "v_profit_analysis",
  "v_cashflow_detailed", "v_expenses_summary",
  "v_invoices_summary", "v_provider_balance",
];

// ── Columnas que NUNCA viajan a Gemini ──────────────────────────────
const MASK_FIELDS = [
  "customer_phone", "shipping_address", "shipping_city",
  "shipping_lat", "shipping_lng", "shipping_notes",
  "payment_proof_url",
  "phone", "email", "address", "contact_person", "tax_id",
  "customer_email",
];

// ── Keywords peligrosos bloqueados ──────────────────────────────────
const DANGEROUS = /\b(DROP|TRUNCATE|ALTER|CREATE\s+TABLE|DELETE\s+FROM|GRANT|REVOKE|COPY\s+.*\s+TO|pg_read_file|pg_write_file|INTO\s+OUTFILE)\b/i;

const ALLOWED_OPS = {
  query:  /^\s*SELECT\s+/i,
  mutate: /^\s*(INSERT|UPDATE)\s+/i,
};

// ── Validador ────────────────────────────────────────────────────────
function validateQuery(sql, action) {
  if (DANGEROUS.test(sql))
    throw new Error("Operación peligrosa bloqueada.");

  if (!ALLOWED_OPS[action].test(sql))
    throw new Error(`Solo se permiten ${action === "query" ? "SELECT" : "INSERT/UPDATE"}.`);

  if (action === "mutate" && !/WHERE\s+/i.test(sql))
    throw new Error("Las modificaciones deben incluir WHERE.");

  const tablePattern = /\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;
  let match;
  while ((match = tablePattern.exec(sql)) !== null) {
    const table = match[1].toLowerCase();
    if (!ALLOWED_TABLES.includes(table))
      throw new Error(`Tabla '${table}' no permitida.`);
  }
}

// ── Sanitizar resultados ─────────────────────────────────────────────
function sanitizeRows(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map(row => {
    const clean = { ...row };
    for (const key of Object.keys(clean)) {
      if (MASK_FIELDS.some(f => key.toLowerCase() === f.toLowerCase())) {
        clean[key] = "***";
      }
      if (/\b(cedula|documento|password|token|secret)\b/i.test(key)) {
        clean[key] = "***";
      }
    }
    return clean;
  });
}

// ── Schema filtrado ──────────────────────────────────────────────────
async function getFilteredSchema() {
  const result = await db.query(`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ANY($1)
    ORDER BY table_name, ordinal_position
  `, [ALLOWED_TABLES]);

  const HIDE_COLS = [
    "password", "token", "secret", "cedula", "documento",
    "customer_phone", "shipping_address", "shipping_lat",
    "shipping_lng", "payment_proof_url", "tax_id",
    "contact_person", "device_info", "token_hash",
  ];

  const schema = {};
  for (const row of result.rows) {
    if (HIDE_COLS.some(c => row.column_name.toLowerCase().includes(c))) continue;
    if (!schema[row.table_name]) schema[row.table_name] = [];
    schema[row.table_name].push(`${row.column_name} (${row.data_type})`);
  }

  return Object.entries(schema)
    .map(([table, cols]) => `- ${table}: ${cols.join(", ")}`)
    .join("\n");
}

// ── Convierte el historial al formato de Gemini ──────────────────────
// Gemini usa { role: "user"|"model", parts: [{ text }] }
// y el system prompt va aparte en la config del modelo
function toGeminiHistory(messages) {
  return messages.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }],
  }));
}

// ── Agente principal ─────────────────────────────────────────────────
async function runAgent(messages) {
  const schema = await getFilteredSchema();

  const systemPrompt = `Eres el asistente inteligente del ERP "Alesteb".

VISTAS DISPONIBLES (úsalas siempre que puedas, ya tienen los JOINs hechos):
- v_sales_full         → ventas con nombre cliente, vendedor, profit, items
- v_products_full      → productos con categoría, imagen, estado de stock
- v_profit_analysis    → rentabilidad por producto (margen, unidades vendidas)
- v_cashflow_detailed  → flujo de caja diario (ingresos vs gastos)
- v_expenses_summary   → resumen de gastos por mes y tipo
- v_invoices_summary   → facturas con proveedor, días de mora
- v_provider_balance   → balance y crédito disponible por proveedor

ESQUEMA COMPLETO:
${schema}

REGLAS:
- Responde SOLO con JSON válido, sin texto extra ni backticks
- Para consultas:   { "action": "query",   "sql": "SELECT...", "explanation": "..." }
- Para modificar:   { "action": "mutate",  "sql": "INSERT/UPDATE...", "explanation": "..." }
- Para responder:   { "action": "answer",  "text": "..." }
- Para confirmar:   { "action": "confirm", "text": "¿Estás seguro...?" }
- NUNCA uses DELETE, DROP, TRUNCATE, ALTER, CREATE TABLE
- NUNCA accedas a: users, refresh_tokens, user_roles, roles, chat_messages
- Siempre usa LIMIT (máximo 100 filas)
- Usa DATE_TRUNC, NOW(), CURRENT_DATE para filtros de fecha
- Responde siempre en español`;

  // Separar el último mensaje del historial previo
  // Gemini requiere que el historial NO incluya el último turno del usuario
  const history  = messages.slice(0, -1);
  const lastMsg  = messages[messages.length - 1];
  const lastText = typeof lastMsg.content === "string"
    ? lastMsg.content
    : JSON.stringify(lastMsg.content);

  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",           // o "gemini-1.5-pro" si prefieres más potencia
    systemInstruction: systemPrompt,
    generationConfig: {
      temperature:     0.1,
      maxOutputTokens: 1024,
    },
  });

  // Iniciar chat con el historial previo
  const chat = model.startChat({
    history: toGeminiHistory(history),
  });

  // Enviar el último mensaje
  const result = await chat.sendMessage(lastText);
  const raw    = result.response.text().trim();
  const clean  = raw.replace(/```json|```/g, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    // Si no es JSON válido, devolvemos el texto directo
    return {
      reply:   raw,
      history: [...messages, { role: "assistant", content: raw }],
    };
  }

  // ── Acción: respuesta directa o confirmación ─────────────────────
  if (parsed.action === "answer" || parsed.action === "confirm") {
    return {
      reply:        parsed.text,
      history:      [...messages, { role: "assistant", content: parsed.text }],
      needsConfirm: parsed.action === "confirm",
    };
  }

  // ── Acción: query o mutate ───────────────────────────────────────
  if (parsed.action === "query" || parsed.action === "mutate") {
    let rows;
    try {
      validateQuery(parsed.sql, parsed.action);
      const dbResult = await db.query(parsed.sql);
      rows = dbResult.rows ?? dbResult;
    } catch (err) {
      console.error("[Agent Blocked]", err.message, "SQL:", parsed.sql);
      const errMsg = `No pude ejecutar esa consulta: ${err.message}`;
      return {
        reply:   errMsg,
        history: [...messages, { role: "assistant", content: errMsg }],
      };
    }

    const sanitized = sanitizeRows(rows);

    // Segunda llamada para redactar la respuesta en lenguaje natural
    const followUpText = `Resultados (${sanitized.length} filas):
${JSON.stringify(sanitized).slice(0, 6000)}

Redacta una respuesta clara en español. Formatea números con puntos de miles.
Si hay "***" son datos privados, no los menciones.
Sin JSON ni código, solo texto natural.`;

    const followUp = await chat.sendMessage(followUpText);
    const reply    = followUp.response.text().trim();

    return {
      reply,
      history: [...messages, { role: "assistant", content: reply }],
    };
  }

  // Fallback
  return {
    reply:   raw,
    history: [...messages, { role: "assistant", content: raw }],
  };
}

module.exports = { runAgent };