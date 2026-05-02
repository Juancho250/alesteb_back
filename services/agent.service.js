// services/agent.service.js  (reemplaza el anterior)
// ── Agente ReAct con tools tipadas ─────────────────────────────────────────
// Loop: Thought → Action → Observation → (repite hasta Answer o Confirm)
// Máximo MAX_STEPS pasos para evitar loops infinitos.

const Groq  = require("groq-sdk");
const db    = require("../config/db");
const { TOOLS, TOOL_DESCRIPTIONS } = require("./agent.tools");

const groq     = new Groq({ apiKey: process.env.GROQ_API_KEY });
const MAX_STEPS = 6;

// ── Schema del ERP (solo columnas permitidas) ────────────────────────────────
async function getFilteredSchema() {
  const ALLOWED_TABLES = [
    "sales","sale_items","coupon_usage","products","product_variants",
    "product_images","product_price_history","categories",
    "attribute_types","attribute_values","variant_attribute_values",
    "bundle_items","variant_images","expenses","invoices","invoice_items",
    "invoice_payments","financial_budgets","provider_payments",
    "providers","purchase_orders","purchase_order_items",
    "discounts","discount_coupons","discount_targets","banners",
    "agent_conversations",
    "v_sales_full","v_products_full","v_profit_analysis",
    "v_cashflow_detailed","v_expenses_summary",
    "v_invoices_summary","v_provider_balance",
  ];
  const HIDE = [
    "password","token","secret","cedula","documento",
    "customer_phone","shipping_address","shipping_lat","shipping_lng",
    "payment_proof_url","tax_id","contact_person","device_info","token_hash",
  ];
  const { rows } = await db.query(`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ANY($1)
    ORDER BY table_name, ordinal_position
  `, [ALLOWED_TABLES]);

  const schema = {};
  for (const r of rows) {
    if (HIDE.some(h => r.column_name.toLowerCase().includes(h))) continue;
    if (!schema[r.table_name]) schema[r.table_name] = [];
    schema[r.table_name].push(`${r.column_name}(${r.data_type})`);
  }
  return Object.entries(schema)
    .map(([t, c]) => `  ${t}: ${c.join(", ")}`)
    .join("\n");
}

// ── System prompt ─────────────────────────────────────────────────────────────
function buildSystemPrompt(schema) {
  return `Eres el agente inteligente del ERP "Alesteb". Tienes acceso a herramientas reales para operar el sistema.

MODO DE OPERACIÓN (ReAct loop):
Piensa paso a paso. Para cada turno responde SOLO con JSON siguiendo UNO de estos formatos:

A) Para usar una herramienta:
{ "thought": "razonamiento breve", "action": "nombre_tool", "args": { ...parámetros } }

B) Para responder al usuario (sin más acciones):
{ "thought": "...", "action": "answer", "text": "respuesta en español" }

C) Para pedir confirmación antes de mutar datos:
{ "thought": "...", "action": "confirm", "text": "¿Confirmas que quieres...?", "pending_sql": "..." }

REGLAS DE AUTONOMÍA:
- query_erp, check_stock_alerts, get_erp_context, generate_report, notify → AUTÓNOMO (no pide permiso)
- mutate_erp → siempre llama primero con confirmed=false para mostrar el plan, luego espera "sí confirmo"
- Si el usuario ya escribió "sí confirmo" o "confirmo" en este mensaje, puedes llamar mutate_erp con confirmed=true
- Nunca inventes datos. Si no encuentras algo, dilo.
- Responde siempre en español. Usa puntos de miles en números.
- No incluyas backticks ni texto fuera del JSON.

${TOOL_DESCRIPTIONS}

ESQUEMA DEL ERP:
${schema}

VISTAS RECOMENDADAS:
  v_sales_full, v_products_full, v_profit_analysis,
  v_cashflow_detailed, v_expenses_summary, v_invoices_summary, v_provider_balance`;
}

// ── Llamada al LLM ────────────────────────────────────────────────────────────
async function callLLM(systemPrompt, conversation) {
  const res = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: systemPrompt },
      ...conversation.map(m => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      })),
    ],
    temperature: 0.1,
    max_tokens: 1500,
  });
  return res.choices[0].message.content.trim();
}

function parseStep(raw) {
  const clean = raw.replace(/```json|```/g, "").trim();
  try { return JSON.parse(clean); }
  catch { return { action: "answer", text: raw }; }
}

// ── Loop ReAct principal ───────────────────────────────────────────────────────
async function runAgent(messages) {
  if (!process.env.GROQ_API_KEY)
    throw new Error("GROQ_API_KEY no configurada");

  const schema       = await getFilteredSchema();
  const systemPrompt = buildSystemPrompt(schema);

  // Conversación interna del loop (incluye observaciones de tools)
  const loopConv = [...messages];
  let needsConfirm   = false;
  let pendingAction  = null;
  let finalReply     = null;

  for (let step = 0; step < MAX_STEPS; step++) {
    const raw    = await callLLM(systemPrompt, loopConv);
    const parsed = parseStep(raw);

    console.log(`[Agent step ${step + 1}]`, parsed.action, parsed.thought || "");

    // ── Respuesta final ───────────────────────────────────────────────────
    if (parsed.action === "answer") {
      finalReply = parsed.text;
      break;
    }

    // ── Pedir confirmación ────────────────────────────────────────────────
    if (parsed.action === "confirm") {
      needsConfirm  = true;
      pendingAction = parsed.pending_sql;
      finalReply    = parsed.text;
      break;
    }

    // ── Ejecutar tool ─────────────────────────────────────────────────────
    if (parsed.action && TOOLS[parsed.action]) {
      let observation;
      try {
        observation = await TOOLS[parsed.action](parsed.args || {});
      } catch (err) {
        observation = { error: err.message };
        console.error(`[Tool ${parsed.action} error]`, err.message);
      }

      // Si mutate devolvió needs_confirm, cerramos el loop
      if (observation?.status === "needs_confirm") {
        needsConfirm  = true;
        pendingAction = observation.sql;
        finalReply    = `Quiero ejecutar la siguiente acción:\n\n\`\`\`sql\n${observation.sql}\n\`\`\`\n\n${observation.reason || ""}\n\n¿Confirmas? Escribe **"sí confirmo"** para proceder.`;
        break;
      }

      // Añadir la acción y la observación al contexto del loop
      loopConv.push({
        role: "assistant",
        content: JSON.stringify({ thought: parsed.thought, action: parsed.action, args: parsed.args }),
      });
      loopConv.push({
        role: "user",
        content: `Observación de ${parsed.action}: ${JSON.stringify(observation).slice(0, 4000)}`,
      });

    } else {
      // Acción desconocida → intentar responder
      finalReply = parsed.text || raw;
      break;
    }
  }

  if (!finalReply) finalReply = "No pude completar la tarea en los pasos disponibles. Intenta reformular tu consulta.";

  // Historial limpio para el frontend (solo mensajes usuario/asistente)
  const history = [
    ...messages,
    { role: "assistant", content: finalReply },
  ];

  return { reply: finalReply, history, needsConfirm, pendingAction };
}

module.exports = { runAgent };