// services/agent.service.js
const Groq  = require("groq-sdk");
const db    = require("../config/db");
const { TOOLS, TOOL_DESCRIPTIONS } = require("./agent.tools");

const groq      = new Groq({ apiKey: process.env.GROQ_API_KEY });
const MAX_STEPS = 6;

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

function buildSystemPrompt(schema) {
  return `Eres el agente inteligente del ERP "Alesteb". Operas el sistema con herramientas reales.

MODO DE OPERACIÓN — loop ReAct:
En cada turno debes responder ÚNICAMENTE con un objeto JSON válido. Ningún texto fuera del JSON.

FORMATOS PERMITIDOS (elige solo uno por turno):

Usar herramienta:
{"thought":"razonamiento corto","action":"nombre_tool","args":{}}

Responder al usuario (OBLIGATORIO como último paso):
{"thought":"...","action":"answer","text":"respuesta completa en español"}

Pedir confirmación antes de mutar:
{"thought":"...","action":"confirm","text":"descripción de la acción","pending_sql":"..."}

REGLA CRÍTICA: Cuando ya tienes toda la información necesaria, SIEMPRE termina con action=answer.
Nunca termines el loop en una herramienta. El usuario solo ve el campo "text" de action=answer.
Si usaste notify o generate_report, confirma al usuario qué hiciste en el text final.

AUTONOMÍA:
- query_erp, check_stock_alerts, get_erp_context, generate_report, notify → ejecuta sin pedir permiso
- mutate_erp → primero confirmed=false para mostrar plan, luego espera "sí confirmo"
- Si el usuario escribió "sí confirmo", usa mutate_erp con confirmed=true directamente

${TOOL_DESCRIPTIONS}

ESQUEMA:
${schema}

VISTAS DISPONIBLES: v_sales_full, v_products_full, v_profit_analysis,
v_cashflow_detailed, v_expenses_summary, v_invoices_summary, v_provider_balance`;
}

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
  catch { return null; }
}

// Llamada final para sintetizar todo lo que el agente hizo en lenguaje natural
async function synthesizeFinalAnswer(systemPrompt, loopConv) {
  const res = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: systemPrompt },
      ...loopConv,
      {
        role: "user",
        content: `Basándote en todo lo que hiciste arriba, responde ahora al usuario con un resumen claro en español.
Responde SOLO con este JSON: {"thought":"síntesis","action":"answer","text":"tu respuesta aquí"}
No incluyas ningún texto fuera del JSON.`,
      },
    ],
    temperature: 0.2,
    max_tokens: 1000,
  });
  const raw    = res.choices[0].message.content.trim();
  const parsed = parseStep(raw);
  return parsed?.text || raw;
}

async function runAgent(messages) {
  if (!process.env.GROQ_API_KEY)
    throw new Error("GROQ_API_KEY no configurada");

  const schema       = await getFilteredSchema();
  const systemPrompt = buildSystemPrompt(schema);
  const loopConv     = [...messages];

  let needsConfirm  = false;
  let pendingAction = null;
  let finalReply    = null;

  for (let step = 0; step < MAX_STEPS; step++) {
    const raw    = await callLLM(systemPrompt, loopConv);
    const parsed = parseStep(raw);

    // Si el LLM devolvió algo que no es JSON válido, sintetizar con lo que tenemos
    if (!parsed) {
      console.warn(`[Agent step ${step + 1}] respuesta no-JSON, sintetizando...`);
      finalReply = await synthesizeFinalAnswer(systemPrompt, loopConv);
      break;
    }

    console.log(`[Agent step ${step + 1}]`, parsed.action, "-", parsed.thought || "");

    // ── Respuesta final ───────────────────────────────────────────────
    if (parsed.action === "answer") {
      finalReply = parsed.text;
      break;
    }

    // ── Confirmación requerida ────────────────────────────────────────
    if (parsed.action === "confirm") {
      needsConfirm  = true;
      pendingAction = parsed.pending_sql;
      finalReply    = parsed.text;
      break;
    }

    // ── Ejecutar tool ─────────────────────────────────────────────────
    if (parsed.action && TOOLS[parsed.action]) {
      let observation;
      try {
        observation = await TOOLS[parsed.action](parsed.args || {});
      } catch (err) {
        observation = { error: err.message };
        console.error(`[Tool ${parsed.action} error]`, err.message);
      }

      if (observation?.status === "needs_confirm") {
        needsConfirm  = true;
        pendingAction = observation.sql;
        finalReply    = `Quiero ejecutar la siguiente acción:\n\n\`\`\`sql\n${observation.sql}\n\`\`\`\n\n${observation.reason || ""}\n\n¿Confirmas? Escribe **"sí confirmo"** para proceder.`;
        break;
      }

      loopConv.push({
        role: "assistant",
        content: JSON.stringify({ thought: parsed.thought, action: parsed.action, args: parsed.args }),
      });
      loopConv.push({
        role: "user",
        content: `Observación de ${parsed.action}: ${JSON.stringify(observation).slice(0, 4000)}`,
      });

    } else {
      // Acción desconocida — sintetizar con lo acumulado
      console.warn(`[Agent] acción desconocida: ${parsed.action}`);
      finalReply = await synthesizeFinalAnswer(systemPrompt, loopConv);
      break;
    }

    // Último paso del loop — forzar síntesis
    if (step === MAX_STEPS - 1) {
      console.log("[Agent] MAX_STEPS alcanzado, sintetizando respuesta final...");
      finalReply = await synthesizeFinalAnswer(systemPrompt, loopConv);
    }
  }

  if (!finalReply) {
    finalReply = await synthesizeFinalAnswer(systemPrompt, loopConv);
  }

  return {
    reply:   finalReply,
    history: [...messages, { role: "assistant", content: finalReply }],
    needsConfirm,
    pendingAction,
  };
}

module.exports = { runAgent };