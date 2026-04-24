import Groq from "groq-sdk";
import { neon } from "@neondatabase/serverless";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const sql = neon(process.env.DATABASE_URL);

// ── Obtener schema de la BD para dárselo al modelo ──────────────────
async function getSchema() {
  const rows = await sql(`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `);

  // Agrupa por tabla para que sea más legible
  const schema = {};
  for (const row of rows) {
    if (!schema[row.table_name]) schema[row.table_name] = [];
    schema[row.table_name].push(`${row.column_name} (${row.data_type})`);
  }

  return Object.entries(schema)
    .map(([table, cols]) => `- ${table}: ${cols.join(", ")}`)
    .join("\n");
}

// ── Ejecutar query segura ───────────────────────────────────────────
async function executeQuery(query, params = []) {
  // Bloquea queries peligrosas
  const forbidden = /drop|truncate|alter|create\s+table/i;
  if (forbidden.test(query)) throw new Error("Query no permitida");
  return await sql(query, params);
}

// ── Loop agentico principal ─────────────────────────────────────────
export async function runAgent(messages) {
  const schema = await getSchema();

  const systemPrompt = `Eres el asistente inteligente del ERP "Alesteb".
Tienes acceso a una base de datos PostgreSQL con estas tablas:

${schema}

Cuando el usuario te haga una pregunta sobre datos, debes responder con un JSON así:
{ "action": "query", "sql": "SELECT ...", "explanation": "Voy a consultar..." }

Cuando el usuario quiera modificar datos y YA haya confirmado, responde:
{ "action": "mutate", "sql": "INSERT/UPDATE...", "explanation": "Voy a crear/modificar..." }

Cuando puedas responder sin consultar la BD:
{ "action": "answer", "text": "tu respuesta aquí" }

Cuando necesites que el usuario confirme algo antes de modificar:
{ "action": "confirm", "text": "¿Estás seguro de que quieres...?" }

IMPORTANTE:
- Responde SOLO con el JSON, sin texto extra ni backticks
- Para fechas usa NOW(), CURRENT_DATE, etc.
- Filtra siempre por datos relevantes, no hagas SELECT * sin WHERE en tablas grandes
- Responde siempre en español`;

  // Construye el historial para Groq
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
    temperature: 0.1, // bajo para que sea preciso con SQL
    max_tokens: 1024,
  });

  const raw = completion.choices[0].message.content.trim();

  let parsed;
  try {
    // A veces el modelo envuelve en ```json ... ``` — lo limpiamos
    const clean = raw.replace(/```json|```/g, "").trim();
    parsed = JSON.parse(clean);
  } catch {
    // Si no puede parsear, lo tratamos como respuesta directa
    return { reply: raw, history: [...messages, { role: "assistant", content: raw }] };
  }

  // ── Ejecutar la acción ────────────────────────────────────────────
  if (parsed.action === "answer" || parsed.action === "confirm") {
    const reply = parsed.text;
    return {
      reply,
      history: [...messages, { role: "assistant", content: reply }],
      needsConfirm: parsed.action === "confirm",
    };
  }

  if (parsed.action === "query" || parsed.action === "mutate") {
    try {
      const rows = await executeQuery(parsed.sql);

      // Le pasamos los resultados al modelo para que genere respuesta legible
      const followUp = [
        ...groqMessages,
        { role: "assistant", content: raw },
        {
          role: "user",
          content: `Resultados de la query: ${JSON.stringify(rows)}
          
Ahora responde al usuario en español de forma clara y amigable, con los números formateados. 
Responde SOLO con el texto final, sin JSON.`,
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
    } catch (err) {
      const errMsg = `Hubo un error ejecutando la consulta: ${err.message}`;
      return {
        reply: errMsg,
        history: [...messages, { role: "assistant", content: errMsg }],
      };
    }
  }

  return { reply: raw, history: [...messages, { role: "assistant", content: raw }] };
}