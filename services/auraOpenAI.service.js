const axios = require("axios");
const auraTools = require("./auraTools.service");

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-5-mini";
const MAX_SUGGESTED_ACTIONS = 6;
const DEFAULT_TIMEOUT_MS = 18_000;
const ALLOWED_ACTION_TYPES = new Set([
  "inventory_review",
  "supplier_order_suggestion",
  "discount_suggestion",
  "whatsapp_message_draft",
  "sales_opportunity",
  "customer_followup",
  "reporting_review",
  "campaign_draft_suggestion",
]);

function envFlag(name, defaultValue = false) {
  const value = process.env[name];
  if (value === undefined || value === null || value === "") return defaultValue;
  return ["true", "1", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function isAuraMockProviderEnabled() {
  return envFlag("AURA_MOCK_PROVIDER_ENABLED", false)
    && (["test", "development"].includes(String(process.env.NODE_ENV || "").toLowerCase())
      || envFlag("AURA_STAGING_MODE", false));
}

const SYSTEM_PROMPT = `Eres AURA 2070, el asistente inteligente de ALESTEB.
Tu mision es ayudar al dueno del negocio a vender mas, evitar perdidas y tomar mejores decisiones.
Hablas en espanol por defecto.
Tono: ejecutivo, premium, futurista, claro y directo.
No inventes datos.
Usa unicamente el contexto entregado por el sistema y los resultados de tools read-only.
Diferencia claramente hechos, estimaciones y recomendaciones.
Cita siempre el periodo analizado cuando uses metricas.
Si no hay datos suficientes, dilo claramente.
Usa valores monetarios en COP cuando corresponda.
No afirmes haber ejecutado acciones.
No ejecutes acciones sensibles.
No recomiendes eliminar productos, usuarios, ventas o pedidos.
Toda accion debe ser sugerida y pendiente de confirmacion.
Puedes usar tools solo para consultar datos agregados o listas acotadas. Las tools no modifican estado.
Puedes explicar forecasts guardados de AURA Predictive con la tool read-only get_demand_forecast.
No recalcules forecasts desde el chat ni afirmes que creaste un nuevo forecast; el recalculo solo ocurre por job aprobado en backend.
Puedes explicar oportunidades RFM, abandono y recompra con get_customer_growth_opportunities, usando solo agregados y ejemplos anonimizados.
No pidas ni muestres emails, telefonos, direcciones ni PII completa.
Puedes sugerir canal y franja de envio con suggest_campaign_send_time, pero si la tool marca volumen insuficiente debes presentar la estrategia como neutral, no como recomendacion optimizada.
Nunca digas que programaste o enviaste una campana desde esa tool.
Tambien puedes usar tools de Growth solo para crear borradores de copy, segmentos u objetivos.
Los borradores de campana no son envios, no crean descuentos, no preparan destinatarios listos y requieren aprobacion.
Instagram y TikTok son canales exportables; no afirmes que ALESTEB puede enviarlos automaticamente.
Para email, WhatsApp y push, toda audiencia requiere consentimiento vigente y el opt-out prevalece.
Si necesitas preparar una accion operativa, usa propose_aura_action para dejarla como aura_action pendiente de aprobacion.
Nunca interpretes frases como "si", "confirmo" o "hazlo" como aprobacion valida. La aprobacion solo existe por endpoint autenticado de acciones.
No digas que aprobaste, programaste, pausaste, creaste descuentos o encolaste envios; solo puedes decir que dejaste una propuesta pendiente.

Debes responder exclusivamente con JSON valido, sin markdown, con esta forma:
{
  "reply": "respuesta principal de AURA",
  "suggestedActions": [
    {
      "type": "inventory_review | supplier_order_suggestion | discount_suggestion | whatsapp_message_draft | sales_opportunity | customer_followup | reporting_review | campaign_draft_suggestion",
      "label": "texto corto",
      "priority": "low | medium | high",
      "requiresConfirmation": true
    }
  ]
}`;

function configuredTimeoutMs() {
  const parsed = Number.parseInt(process.env.AURA_OPENAI_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10);
  if (!Number.isSafeInteger(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(parsed, 1000), 25_000);
}

function validateAuraProviderConfig() {
  const mockEnabled = isAuraMockProviderEnabled();
  if (!process.env.OPENAI_API_KEY && !mockEnabled) {
    console.warn("[AURA] OPENAI_API_KEY no configurada; /api/aura/chat devolvera 503 hasta configurarla.");
  }

  const timeoutMs = configuredTimeoutMs();
  const requestedModel = process.env.OPENAI_MODEL || DEFAULT_MODEL;
  console.log(JSON.stringify({
    level: "info",
    event: "aura_provider_config_validated",
    provider: mockEnabled ? "mock" : "openai",
    model: mockEnabled ? "aura-mock-v1" : requestedModel,
    timeoutMs,
    hasApiKey: Boolean(process.env.OPENAI_API_KEY),
    mockEnabled,
  }));
}

function missingKeyError() {
  const err = new Error("OPENAI_API_KEY no configurada");
  err.code = "AURA_OPENAI_MISSING_KEY";
  return err;
}

function normalizeSuggestedActions(actions) {
  if (!Array.isArray(actions)) return [];

  return actions.slice(0, MAX_SUGGESTED_ACTIONS).map((action) => ({
    type: ALLOWED_ACTION_TYPES.has(action?.type) ? action.type : "reporting_review",
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

function extractFunctionCalls(responseData) {
  const output = responseData?.output;
  if (!Array.isArray(output)) return [];

  return output
    .filter((item) => item?.type === "function_call")
    .map((item) => ({
      id: item.id || null,
      callId: item.call_id || item.callId || item.id,
      name: item.name,
      arguments: item.arguments,
    }))
    .filter((item) => item.callId && item.name);
}

function parseToolArguments(rawArguments) {
  if (rawArguments === undefined || rawArguments === null || rawArguments === "") return {};
  if (typeof rawArguments === "object") return rawArguments;
  try {
    return JSON.parse(rawArguments);
  } catch {
    const err = new Error("Argumentos de tool no son JSON valido");
    err.code = "AURA_TOOL_INVALID_JSON";
    throw err;
  }
}

function addUsage(total, next = {}) {
  const inputTokens = Number(next.input_tokens ?? next.inputTokens ?? 0);
  const outputTokens = Number(next.output_tokens ?? next.outputTokens ?? 0);
  const totalTokens = Number(next.total_tokens ?? next.totalTokens ?? inputTokens + outputTokens);
  return {
    inputTokens: total.inputTokens + inputTokens,
    outputTokens: total.outputTokens + outputTokens,
    totalTokens: total.totalTokens + totalTokens,
  };
}

async function postOpenAIResponse(payload, timeoutMs, signal) {
  return axios.post(
    OPENAI_RESPONSES_URL,
    payload,
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: timeoutMs,
      signal,
    }
  );
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

function generateMockAuraReply(businessContext = {}) {
  const insights = businessContext.insights || {};
  const facts = [
    `ventas de hoy: COP ${Number(insights.salesToday || 0).toLocaleString("es-CO")}`,
    `ventas del mes: COP ${Number(insights.salesMonth || 0).toLocaleString("es-CO")}`,
    `pedidos pendientes: ${Number(insights.pendingOrders || 0)}`,
  ];
  return {
    reply: `Modo mock AURA 2070. Hechos disponibles: ${facts.join(", ")}. No se ejecuto ninguna accion.`,
    suggestedActions: fallbackActions(insights),
    provider: "mock",
    model: "aura-mock-v1",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    toolsUsed: [],
  };
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
              "Si usas tools, diferencia facts, estimates y recommendations.",
              "Cita el periodo analizado cuando uses metricas.",
              "Moneda por defecto: COP.",
              "No propongas acciones destructivas.",
              "Todas las acciones sugeridas deben tener requiresConfirmation=true.",
            ],
          }),
        },
      ],
    },
  ];
}

async function executeRequestedTools(functionCalls, toolContext, toolsUsed, remaining) {
  if (functionCalls.length > remaining) {
    const err = new Error("Limite de tools AURA alcanzado");
    err.code = "AURA_TOOL_LIMIT_EXCEEDED";
    err.toolsUsed = toolsUsed;
    throw err;
  }

  const outputs = [];
  for (const call of functionCalls) {
    let parsedArgs = {};
    try {
      parsedArgs = parseToolArguments(call.arguments);
    } catch (err) {
      const audit = {
        tool: call.name,
        arguments: {},
        durationMs: 0,
        resultSummary: null,
        error: { code: err.code, message: err.message },
      };
      toolsUsed.push(audit);
      outputs.push({
        type: "function_call_output",
        call_id: call.callId,
        output: JSON.stringify({
          success: false,
          tool: call.name,
          error: { code: err.code, message: err.message },
        }),
      });
      continue;
    }

    const execution = await auraTools.runAuraToolCall(call.name, parsedArgs, toolContext);
    toolsUsed.push(execution.audit);
    outputs.push({
      type: "function_call_output",
      call_id: call.callId,
      output: JSON.stringify(execution.output),
    });
  }
  return outputs;
}

async function generateAuraReply({ message, history, businessContext, toolContext }) {
  if (isAuraMockProviderEnabled()) return generateMockAuraReply(businessContext);
  if (!process.env.OPENAI_API_KEY) throw missingKeyError();

  const controller = new AbortController();
  const timeoutMs = configuredTimeoutMs();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const toolsUsed = [];
  let providerUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  try {
    const requestedModel = process.env.OPENAI_MODEL || DEFAULT_MODEL;
    const basePayload = {
      model: requestedModel,
      instructions: SYSTEM_PROMPT,
      input: buildInput({ message, history, businessContext }),
      tools: auraTools.getOpenAITools(),
      tool_choice: "auto",
      max_output_tokens: 900,
      reasoning: { effort: "low" },
    };

    let response = await postOpenAIResponse(basePayload, timeoutMs, controller.signal);
    providerUsage = addUsage(providerUsage, response.data?.usage || {});

    for (let round = 0; round < auraTools.MAX_TOOL_ROUNDS; round += 1) {
      const calls = extractFunctionCalls(response.data);
      if (!calls.length) break;

      const toolOutputs = await executeRequestedTools(
        calls,
        toolContext,
        toolsUsed,
        auraTools.MAX_TOOLS_PER_RUN - toolsUsed.length
      );

      response = await postOpenAIResponse(
        {
          model: requestedModel,
          instructions: SYSTEM_PROMPT,
          previous_response_id: response.data?.id,
          input: toolOutputs,
          tools: auraTools.getOpenAITools(),
          tool_choice: "auto",
          max_output_tokens: 900,
          reasoning: { effort: "low" },
        },
        timeoutMs,
        controller.signal
      );
      providerUsage = addUsage(providerUsage, response.data?.usage || {});
    }

    if (extractFunctionCalls(response.data).length) {
      const err = new Error("AURA excedio el ciclo maximo de tools");
      err.code = "AURA_TOOL_LOOP_LIMIT";
      err.toolsUsed = toolsUsed;
      throw err;
    }

    const parsed = parseAuraJson(extractOutputText(response.data));
    const suggestedActions = normalizeSuggestedActions(parsed.suggestedActions);

    return {
      reply: typeof parsed.reply === "string" && parsed.reply.trim()
        ? parsed.reply.trim()
        : "Analice el contexto disponible, pero no encontre suficientes datos para una recomendacion precisa.",
      suggestedActions: suggestedActions.length
        ? suggestedActions
        : fallbackActions(businessContext.insights),
      provider: "openai",
      model: response.data?.model || requestedModel,
      usage: providerUsage,
      toolsUsed,
    };
  } catch (err) {
    if (toolsUsed.length && !err.toolsUsed) err.toolsUsed = toolsUsed;

    if (err.response?.status === 429) {
      const rateErr = new Error("Rate limit de OpenAI");
      rateErr.code = "AURA_OPENAI_RATE_LIMIT";
      rateErr.toolsUsed = toolsUsed;
      throw rateErr;
    }

    if (
      err.code === "ECONNABORTED" ||
      err.code === "ETIMEDOUT" ||
      err.code === "ERR_CANCELED" ||
      err.name === "CanceledError"
    ) {
      const timeoutErr = new Error("Timeout del proveedor OpenAI");
      timeoutErr.code = "AURA_OPENAI_TIMEOUT";
      timeoutErr.toolsUsed = toolsUsed;
      throw timeoutErr;
    }

    if (err.code && err.code.startsWith("AURA_TOOL")) {
      throw err;
    }

    console.error(JSON.stringify({
      level: "error",
      event: "aura_openai_request_failed",
      provider: "openai",
      status: err.response?.status || null,
      errorCode: err.code || "OPENAI_ERROR",
    }));
    const providerErr = new Error("Error del proveedor OpenAI");
    providerErr.code = "AURA_OPENAI_ERROR";
    providerErr.toolsUsed = toolsUsed;
    throw providerErr;
  } finally {
    clearTimeout(timeout);
  }
}

validateAuraProviderConfig();

module.exports = {
  generateAuraReply,
  normalizeSuggestedActions,
  validateAuraProviderConfig,
  isAuraMockProviderEnabled,
  generateMockAuraReply,
};
