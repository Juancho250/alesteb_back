const Groq = require("groq-sdk");
const { neon } = require("@neondatabase/serverless");

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const sql = neon(process.env.NEON_DB_URL);

// ── Schema de la BD ─────────────────────────────────────────────────
async function getSchema() {
  const rows = await sql`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `;
  const schema = {};
  for (const row of rows) {
    if (!schema[row.table_name]) schema[row.table_name] = [];
    schema[row.table_name].push(`${row.column_name} (${row.data_type})`);
  }
  return Object.entries(schema)
    .map(([table, cols]) => `- ${table}: ${cols.join(", ")}`)
    .join("\n");
}

// ── Ejecutor seguro ──────────────────────────────────────────────────
async function executeQuery(query, params = []) {
  const forbidden = /\b(drop|truncate|alter\s+table|create\s+table)\b/i;
  if (forbidden.test(query)) throw new Error("Query no permitida por seguridad");

  if (params.length > 0) {
    return await sql(query, params);
  }
  // Para queries sin parámetros usamos template literal
  return await sql.query(query);
}

// ── Agente principal ─────────────────────────────────────────────────
async function runAgent(messages) {
  const schema = await getSchema();

  const systemPrompt = `Eres el asistente inteligente del ERP "Alesteb".
Tienes acceso a una base de datos PostgreSQL con estas tablas:

${schema}

Cuando el usuario te haga una pregunta sobre datos, responde SOLO con JSON:
{ "action": "query", "sql": "SELECT ...", "explanation": "Voy a consultar..." }

Cuando el usuario quiera modificar datos y YA haya confirmado:
{ "action": "mutate", "sql": "INSERT/UPDATE/DELETE...", "explanation": "Voy a modificar..." }

Cuando puedas responder sin consultar la BD:
{ "action": "answer", "text": "tu respuesta aquí" }

Cuando necesites confirmación antes de modificar:
{ "action": "confirm", "text": "¿Estás seguro de que quieres...?" }

REGLAS IMPORTANTES:
- Responde SOLO con el JSON, sin texto extra ni backticks ni markdown
- Para fechas usa NOW(), CURRENT_DATE, DATE_TRUNC, etc.
- El mes actual en PostgreSQL: DATE_TRUNC('month', CURRENT_DATE)
- Usa aliases claros en los SELECT para que los resultados sean legibles
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

  // Limpiar posibles backticks que el modelo agregue
  const clean = raw.replace(/```json|```/g, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    // Si no es JSON válido, lo tratamos como respuesta directa
    return {
      reply: raw,
      history: [...messages, { role: "assistant", content: raw }],
    };
  }

  // ── Respuesta directa o confirmación ────────────────────────────
  if (parsed.action === "answer" || parsed.action === "confirm") {
    return {
      reply: parsed.text,
      history: [...messages, { role: "assistant", content: parsed.text }],
      needsConfirm: parsed.action === "confirm",
    };
  }

  // ── Ejecutar query ───────────────────────────────────────────────
  if (parsed.action === "query" || parsed.action === "mutate") {
    let rows;
    try {
      rows = await executeQuery(parsed.sql);
    } catch (err) {
      const errMsg = `No pude ejecutar la consulta: ${err.message}`;
      return {
        reply: errMsg,
        history: [...messages, { role: "assistant", content: errMsg }],
      };
    }

    // Segunda llamada: convertir resultados en respuesta legible
    const followUp = [
      ...groqMessages,
      { role: "assistant", content: raw },
      {
        role: "user",
        content: `Resultados obtenidos de la base de datos: ${JSON.stringify(rows)}

Ahora redacta una respuesta clara y amigable en español para el usuario.
- Formatea los números con separadores (ej: 1.250.000)
- Si son listas, máximo 10 items
- NO incluyas JSON ni código, solo texto natural`,
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

  // Fallback
  return {
    reply: raw,
    history: [...messages, { role: "assistant", content: raw }],
  };
}

module.exports = { runAgent };