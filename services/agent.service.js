const Groq = require("groq-sdk");
const db = require("../config/db"); // ← usa tu db existente, NO @neondatabase/serverless

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── 1. WHITELIST de tablas permitidas ───────────────────────────────
// El agente SOLO puede ver y tocar estas tablas
const ALLOWED_TABLES = [
  "products", "categories", "sales", "sale_items",
  "users", "providers", "finance", "discounts", "banners",
];

// ── 2. WHITELIST de columnas sensibles PROHIBIDAS ───────────────────
const FORBIDDEN_COLUMNS = [
  "password", "password_hash", "token", "secret",
  "jwt_secret", "api_key", "reset_token", "verification_token",
];

// ── 3. Solo estas operaciones están permitidas ──────────────────────
const ALLOWED_OPERATIONS = {
  query:  /^\s*(SELECT)\s+/i,          // solo lectura
  mutate: /^\s*(INSERT|UPDATE)\s+/i,   // sin DELETE ni DROP
};

// ── 4. Blacklist de keywords peligrosos ────────────────────────────
const DANGEROUS_KEYWORDS = /\b(DROP|TRUNCATE|ALTER|CREATE\s+TABLE|DELETE\s+FROM|GRANT|REVOKE|EXEC|EXECUTE|xp_|pg_read_file|pg_write_file|COPY\s+.*\s+TO|INTO\s+OUTFILE)\b/i;

// ── 5. Validador de queries ─────────────────────────────────────────
function validateQuery(sql, action) {
  // Bloquear keywords peligrosos sin excepción
  if (DANGEROUS_KEYWORDS.test(sql)) {
    throw new Error("Query bloqueada por contener operaciones peligrosas.");
  }

  // Verificar que sea la operación correcta
  if (!ALLOWED_OPERATIONS[action].test(sql)) {
    throw new Error(`Solo se permiten ${action === "query" ? "SELECT" : "INSERT/UPDATE"} para esta acción.`);
  }

  // Bloquear acceso a columnas sensibles
  const sqlLower = sql.toLowerCase();
  for (const col of FORBIDDEN_COLUMNS) {
    if (sqlLower.includes(col)) {
      throw new Error(`Acceso a columna sensible '${col}' bloqueado.`);
    }
  }

  // Verificar que solo acceda a tablas permitidas
  // Extrae nombres de tablas del SQL con regex simple
  const tablePattern = /\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;
  let match;
  while ((match = tablePattern.exec(sql)) !== null) {
    const table = match[1].toLowerCase();
    if (!ALLOWED_TABLES.includes(table)) {
      throw new Error(`Acceso a tabla '${table}' no permitido.`);
    }
  }

  return true;
}

// ── 6. Schema filtrado — solo tablas permitidas, sin columnas sensibles
async function getFilteredSchema() {
  const result = await db.query(`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ANY($1)
    ORDER BY table_name, ordinal_position
  `, [ALLOWED_TABLES]);

  const schema = {};
  for (const row of result.rows) {
    // No incluir columnas sensibles en el schema que ve el modelo
    if (FORBIDDEN_COLUMNS.some(fc => row.column_name.toLowerCase().includes(fc))) continue;
    if (!schema[row.table_name]) schema[row.table_name] = [];
    schema[row.table_name].push(`${row.column_name} (${row.data_type})`);
  }

  return Object.entries(schema)
    .map(([table, cols]) => `- ${table}: ${cols.join(", ")}`)
    .join("\n");
}

// ── 7. Ejecutor con usuario de solo lectura para queries ────────────
async function executeQuery(sql, action) {
  validateQuery(sql, action); // lanza error si no pasa validación

  // Para mutaciones: pedir siempre doble confirmación a nivel de código
  if (action === "mutate") {
    // Limitar a máximo 100 filas afectadas por seguridad
    if (!/WHERE\s+/i.test(sql)) {
      throw new Error("Las mutaciones deben incluir una cláusula WHERE.");
    }
  }

  const result = await db.query(sql);
  return result.rows ?? result;
}

// ── 8. Agente principal ─────────────────────────────────────────────
async function runAgent(messages, userContext = {}) {
  const schema = await getFilteredSchema();

  const systemPrompt = `Eres el asistente inteligente del ERP "Alesteb".
Solo tienes acceso a estas tablas: ${ALLOWED_TABLES.join(", ")}.

Esquema disponible:
${schema}

REGLAS ESTRICTAS:
- Responde SOLO con JSON válido, sin texto extra ni backticks
- Para consultas: { "action": "query", "sql": "SELECT...", "explanation": "..." }
- Para modificar (solo si el usuario confirmó): { "action": "mutate", "sql": "INSERT/UPDATE...", "explanation": "..." }
- Para respuestas directas: { "action": "answer", "text": "..." }
- Para pedir confirmación: { "action": "confirm", "text": "¿Estás seguro de que quieres...?" }
- NUNCA uses DELETE, DROP, TRUNCATE, ALTER, CREATE TABLE
- NUNCA accedas a columnas de contraseñas, tokens o claves
- NUNCA hagas SELECT * en tablas grandes, usa columnas específicas
- Siempre incluye LIMIT en los SELECT (máximo 100)
- Para fechas usa NOW(), CURRENT_DATE, DATE_TRUNC
- Responde siempre en español`;

  const groqMessages = [
    { role: "system", content: systemPrompt },
    ...messages.map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    })),
  ];

  const completion = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: groqMessages,
    temperature: 0.1,
    max_tokens: 1024,
  });

  const raw = completion.choices[0].message.content.trim();
  const clean = raw.replace(/```json|```/g, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    return { reply: raw, history: [...messages, { role: "assistant", content: raw }] };
  }

  if (parsed.action === "answer" || parsed.action === "confirm") {
    return {
      reply: parsed.text,
      history: [...messages, { role: "assistant", content: parsed.text }],
      needsConfirm: parsed.action === "confirm",
    };
  }

  if (parsed.action === "query" || parsed.action === "mutate") {
    let rows;
    try {
      rows = await executeQuery(parsed.sql, parsed.action);
    } catch (err) {
      // Log interno pero mensaje genérico al usuario
      console.error("[Agent Query Blocked]", err.message, "| SQL:", parsed.sql);
      const errMsg = `No pude ejecutar esa consulta: ${err.message}`;
      return {
        reply: errMsg,
        history: [...messages, { role: "assistant", content: errMsg }],
      };
    }

    const followUp = [
      ...groqMessages,
      { role: "assistant", content: raw },
      {
        role: "user",
        content: `Resultados: ${JSON.stringify(rows).slice(0, 8000)}
        
Redacta una respuesta clara en español. Formatea números. Sin JSON ni código.`,
      },
    ];

    const finalCompletion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: followUp,
      temperature: 0.3,
      max_tokens: 1024,
    });

    const reply = finalCompletion.choices[0].message.content.trim();
    return {
      reply,
      history: [...messages, { role: "assistant", content: reply }],
    };
  }

  return { reply: raw, history: [...messages, { role: "assistant", content: raw }] };
}

module.exports = { runAgent };