// npm install groq-sdk
const Groq = require("groq-sdk");
const db = require("../config/db");

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

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
  "v_sales_full", "v_products_full", "v_profit_analysis",
  "v_cashflow_detailed", "v_expenses_summary",
  "v_invoices_summary", "v_provider_balance",
];

const MASK_FIELDS = [
  "customer_phone", "shipping_address", "shipping_city",
  "shipping_lat", "shipping_lng", "shipping_notes",
  "payment_proof_url",
  "phone", "email", "address", "contact_person", "tax_id",
  "customer_email",
];

const DANGEROUS = /\b(DROP|TRUNCATE|ALTER|CREATE\s+TABLE|DELETE\s+FROM|GRANT|REVOKE|COPY\s+.*\s+TO|pg_read_file|pg_write_file|INTO\s+OUTFILE)\b/i;

const ALLOWED_OPS = {
  query:  /^\s*SELECT\s+/i,
  mutate: /^\s*(INSERT|UPDATE)\s+/i,
};

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

function sanitizeRows(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map(row => {
    const clean = { ...row };
    for (const key of Object.keys(clean)) {
      if (MASK_FIELDS.some(f => key.toLowerCase() === f.toLowerCase()))
        clean[key] = "***";
      if (/\b(cedula|documento|password|token|secret)\b/i.test(key))
        clean[key] = "***";
    }
    return clean;
  });
}

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

// ── Groq usa el formato estándar OpenAI: { role, content } ───────────
// No necesita conversión especial como Gemini
function buildGroqMessages(systemPrompt, messages) {
  return [
    { role: "system", content: systemPrompt },
    ...messages.map(m => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    })),
  ];
}

// ── Llamada a Groq ────────────────────────────────────────────────────
async function callGroq(groqMessages) {
  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: groqMessages,
    temperature: 0.1,
    max_tokens: 1024,
  });
  return response.choices[0].message.content.trim();
}

// ── Agente principal ─────────────────────────────────────────────────
async function runAgent(messages) {
  if (!process.env.GROQ_API_KEY)
    throw new Error("GROQ_API_KEY no está configurada en las variables de entorno");

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

  // Primera llamada: el modelo decide qué acción tomar
  const raw   = await callGroq(buildGroqMessages(systemPrompt, messages));
  const clean = raw.replace(/```json|```/g, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    return {
      reply:   raw,
      history: [...messages, { role: "assistant", content: raw }],
    };
  }

  // ── Respuesta directa o confirmación ────────────────────────────
  if (parsed.action === "answer" || parsed.action === "confirm") {
    return {
      reply:        parsed.text,
      history:      [...messages, { role: "assistant", content: parsed.text }],
      needsConfirm: parsed.action === "confirm",
    };
  }

  // ── Query o mutate ───────────────────────────────────────────────
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

    // Segunda llamada: redactar respuesta en lenguaje natural
    const followUpMessages = buildGroqMessages(systemPrompt, [
      ...messages,
      { role: "assistant", content: clean },
      {
        role: "user",
        content: `Resultados (${sanitized.length} filas):
${JSON.stringify(sanitized).slice(0, 6000)}

Redacta una respuesta clara en español. Formatea números con puntos de miles.
Si hay "***" son datos privados, no los menciones.
Sin JSON ni código, solo texto natural.`,
      },
    ]);

    const reply = await callGroq(followUpMessages);

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