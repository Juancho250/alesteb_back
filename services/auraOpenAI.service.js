const axios = require("axios");

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-5-mini";
const MAX_SUGGESTED_ACTIONS = 6;

const SYSTEM_PROMPT = `Eres AURA 2070, el asistente inteligente de ALESTEB.
Tu mision es ayudar al dueno del negocio a vender mas, evitar perdidas y tomar mejores decisiones.
Hablas en espanol.
Tono: ejecutivo, premium, futurista, claro y directo.
No inventes datos.
Usa unicamente el contexto entregado por el sistema.
Si no hay datos suficientes, dilo claramente.
No ejecutes acciones sensibles.
No recomiendes eliminar productos, usuarios, ventas o pedidos.
Toda accion debe ser sugerida y pendiente de confirmacion.

Debes responder exclusivamente con JSON valido, sin markdown, con esta forma:
{
  "reply": "respuesta principal de AURA",
  "suggestedActions": [
    {
      "type": "inventory_review | supplier_order_suggestion | discount_suggestion | whatsapp_message_draft | sales_opportunity | customer_followup | reporting_review",
      "label": "texto corto",
      "priority": "low | medium | high",
      "requiresConfirmation": true
    }
  ]
}`;

function missingKeyError() {
  const err = new Error("OPENAI_API_KEY no configurada");
  err.code = "AURA_OPENAI_MISSING_KEY";
  return err;
}

function normalizeSuggestedActions(actions) {
  if (!Array.isArray(actions)) return [];

  return actions.slice(0, MAX_SUGGESTED_ACTIONS).map((action) => ({
    type: typeof action?.type === "string" ? action.type : "reporting_review",
    label: typeof action?.label === "string"
      ? action.label.slice(0, 140)
      : "Revisar recomendacion de AURA",
    priority: ["low", "medium", "high"].includes(action?.priority)
      ? action.priority
      : "medium",
    requiresConfirmation: true,
  }));
}

function extractOutputText(responseData) {
  if (typeof responseData?.output_text === "string") {
    return responseData.output_text;
  }

  const output = responseData?.output;
  if (!Array.isArray(output)) return "";

  return output
    .flatMap((item) => Array.isArray(item.content) ? item.content : [])
    .map((content) => content.text || "")
    .join("\n")
    .trim();
}

function parseAuraJson(rawText) {
  const clean = String(rawText || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(clean);
  } catch {
    return {
      reply: clean || "No pude generar una respuesta clara con el contexto disponible.",
      suggestedActions: [],
    };
  }
}

function fallbackActions(insights) {
  const actions = [];

  if (insights.lowStockProducts?.length) {
    actions.push({
      type: "inventory_review",
      label: "Revisar productos con bajo stock",
      priority: "high",
      requiresConfirmation: true,
    });
  }

  if (insights.sleepingProducts?.length) {
    actions.push({
      type: "discount_suggestion",
      label: "Preparar campana para productos dormidos",
      priority: "medium",
      requiresConfirmation: true,
    });
  }

  if (insights.pendingOrders > 0) {
    actions.push({
      type: "customer_followup",
      label: "Revisar pedidos pendientes",
      priority: "high",
      requiresConfirmation: true,
    });
  }

  if (insights.topProducts?.length) {
    actions.push({
      type: "sales_opportunity",
      label: "Impulsar productos mas vendidos",
      priority: "medium",
      requiresConfirmation: true,
    });
  }

  return actions.slice(0, MAX_SUGGESTED_ACTIONS);
}

function buildInput({ message, history, businessContext }) {
  return [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: JSON.stringify({
            userMessage: message,
            recentConversation: history,
            businessContext: businessContext.promptContext,
            outputRules: [
              "No uses datos fuera de businessContext.",
              "No propongas acciones destructivas.",
              "Todas las acciones sugeridas deben tener requiresConfirmation=true.",
            ],
          }),
        },
      ],
    },
  ];
}

async function generateAuraReply({ message, history, businessContext }) {
  if (!process.env.OPENAI_API_KEY) throw missingKeyError();

  try {
    const response = await axios.post(
      OPENAI_RESPONSES_URL,
      {
        model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
        instructions: SYSTEM_PROMPT,
        input: buildInput({ message, history, businessContext }),
        max_output_tokens: 900,
        reasoning: { effort: "low" },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 25_000,
      }
    );

    const parsed = parseAuraJson(extractOutputText(response.data));
    const suggestedActions = normalizeSuggestedActions(parsed.suggestedActions);

    return {
      reply: typeof parsed.reply === "string" && parsed.reply.trim()
        ? parsed.reply.trim()
        : "Analice el contexto disponible, pero no encontre suficientes datos para una recomendacion precisa.",
      suggestedActions: suggestedActions.length
        ? suggestedActions
        : fallbackActions(businessContext.insights),
    };
  } catch (err) {
    if (err.response?.status === 429) {
      const rateErr = new Error("Rate limit de OpenAI");
      rateErr.code = "AURA_OPENAI_RATE_LIMIT";
      throw rateErr;
    }

    console.error("[AURA OpenAI]", err.response?.data || err.message);
    throw err;
  }
}

module.exports = { generateAuraReply };
