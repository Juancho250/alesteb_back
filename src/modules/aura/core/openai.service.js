const axios = require("axios");
const auraTools = require("../../../../services/auraTools.service");

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-5-mini";
const MAX_SUGGESTED_ACTIONS = 6;
const DEFAULT_TIMEOUT_MS = 18_000;
const PROVIDER_ERROR_MESSAGE_MAX = 300;
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

function normalizeOpenAIModel(value = process.env.OPENAI_MODEL || DEFAULT_MODEL) {
  let model = String(value || "").trim();
  const quote = model[0];
  if ((quote === '"' || quote === "'") && model.endsWith(quote)) {
    model = model.slice(1, -1).trim();
  }
  return model || DEFAULT_MODEL;
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
Usa unicamente el contexto entregado por el sistema y los resultados de tools autorizadas.
Diferencia claramente hechos, estimaciones y recomendaciones.
Cita siempre el periodo analizado cuando uses metricas.
Si no hay datos suficientes, dilo claramente.
Usa valores monetarios en COP cuando corresponda.
No afirmes haber ejecutado acciones.
No ejecutes acciones sensibles.
No recomiendes eliminar productos, usuarios, ventas o pedidos.
Toda accion debe ser sugerida y pendiente de confirmacion.
Las tools consultivas solo leen datos agregados o listas acotadas.
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
Ante una solicitud visual explicita puedes usar prepare_campaign_creatives, generate_campaign_images, edit_campaign_image o get_image_job_status.
prepare_campaign_creatives solo prepara el plan y no crea jobs.
generate_campaign_images y edit_campaign_image solo encolan jobs asincronos; no generan dentro del chat y no publican en ninguna plataforma.
No invoques tools de imagen sin una solicitud visual explicita.
Para generar o editar exige una imagen fuente autorizada. Si falta, pide al usuario seleccionar o adjuntar una imagen.
No afirmes que conservaras exactamente el producto si no hay una fuente disponible.
Cuando una tool devuelva jobs, informa que fueron encolados y que su estado debe consultarse; no inventes jobIds.
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
  ],
  "jobs": [
    {
      "jobId": "uuid real devuelto por la tool",
      "format": "1:1 | 4:5 | 9:16 | 16:9",
      "status": "queued | running | completed | failed"
    }
  ],
  "requiresPolling": false
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
  const requestedModel = normalizeOpenAIModel();
  console.log(JSON.stringify({
    level: "info",
    event: "aura_provider_config_validated",
    provider: mockEnabled ? "mock" : "openai",
    model: mockEnabled ? "aura-mock-v1" : sanitizeProviderField(requestedModel, 100),
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

function sanitizeProviderField(value, maxLength) {
  if (value === undefined || value === null || value === "") return null;
  return String(value)
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/gi, "[redacted-secret]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted-secret]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[redacted-phone]")
    .slice(0, maxLength);
}

function sanitizeOpenAIProviderError(err) {
  const providerError = err?.response?.data?.error;
  const status = Number(err?.response?.status);
  return {
    status: Number.isInteger(status) && status > 0 ? status : null,
    type: sanitizeProviderField(providerError?.type, 100),
    code: sanitizeProviderField(providerError?.code || err?.code, 100),
    param: sanitizeProviderField(providerError?.param, 160),
    message: sanitizeProviderField(
      providerError?.message || err?.message || "OpenAI request failed",
      PROVIDER_ERROR_MESSAGE_MAX
    ),
  };
}

function providerAuditCode(status) {
  if (status === 400) return "AURA_OPENAI_BAD_REQUEST";
  if (status === 401) return "AURA_OPENAI_AUTHENTICATION_ERROR";
  if (status === 403) return "AURA_OPENAI_PERMISSION_ERROR";
  if (status === 404) return "AURA_OPENAI_MODEL_NOT_FOUND";
  if (status === 429) return "AURA_OPENAI_RATE_LIMIT";
  if (status >= 500) return "AURA_OPENAI_UNAVAILABLE";
  return "AURA_OPENAI_ERROR";
}

function approximateInputBytes(input) {
  try {
    return Buffer.byteLength(JSON.stringify(input), "utf8");
  } catch {
    return null;
  }
}

function summarizeOpenAIRequest(payload, requestId) {
  return {
    model: sanitizeProviderField(normalizeOpenAIModel(payload?.model), 100),
    requestId: sanitizeProviderField(requestId, 100),
    toolCount: Array.isArray(payload?.tools) ? payload.tools.length : 0,
    inputBytes: approximateInputBytes(payload?.input),
  };
}

function logOpenAIRequestFailure(err, requestSummary) {
  const diagnostic = sanitizeOpenAIProviderError(err);
  console.error(JSON.stringify({
    level: "error",
    event: "aura_openai_request_failed",
    provider: "openai",
    status: diagnostic.status,
    error: {
      type: diagnostic.type,
      code: diagnostic.code,
      param: diagnostic.param,
      message: diagnostic.message,
    },
    model: requestSummary.model,
    requestId: requestSummary.requestId,
    toolCount: requestSummary.toolCount,
    inputBytes: requestSummary.inputBytes,
  }));
  return diagnostic;
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
    jobs: [],
    requiresPolling: false,
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

function buildOpenAIResponsePayload({
  model,
  input,
  instructions,
  tools,
  toolChoice,
  previousResponseId,
  maxOutputTokens,
  reasoning,
}) {
  const payload = {
    model: normalizeOpenAIModel(model),
    input,
  };

  if (typeof instructions === "string" && instructions) payload.instructions = instructions;
  if (typeof previousResponseId === "string" && previousResponseId) {
    payload.previous_response_id = previousResponseId;
  }
  if (Array.isArray(tools) && tools.length) {
    payload.tools = tools;
    if (toolChoice !== undefined) payload.tool_choice = toolChoice;
  }
  if (Number.isSafeInteger(maxOutputTokens) && maxOutputTokens > 0) {
    payload.max_output_tokens = maxOutputTokens;
  }
  if (reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)) {
    payload.reasoning = reasoning;
  }

  return payload;
}

function appendImageJobs(target, execution) {
  const jobs = execution?.output?.data?.jobs;
  if (!Array.isArray(jobs)) return;
  for (const job of jobs) {
    if (
      typeof job?.jobId !== "string"
      || typeof job?.format !== "string"
      || typeof job?.status !== "string"
    ) {
      continue;
    }
    if (target.some((item) => item.jobId === job.jobId)) continue;
    target.push({
      jobId: job.jobId,
      format: job.format,
      status: job.status,
    });
  }
}

async function executeRequestedTools(functionCalls, toolContext, toolsUsed, remaining) {
  if (functionCalls.length > remaining) {
    const err = new Error("Limite de tools AURA alcanzado");
    err.code = "AURA_TOOL_LIMIT_EXCEEDED";
    err.toolsUsed = toolsUsed;
    throw err;
  }

  const outputs = [];
  const imageJobs = [];
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
    appendImageJobs(imageJobs, execution);
    outputs.push({
      type: "function_call_output",
      call_id: call.callId,
      output: JSON.stringify(execution.output),
    });
  }
  return { outputs, imageJobs };
}

async function generateAuraReply({ message, history, businessContext, toolContext }) {
  const toolSelection = typeof auraTools.selectOpenAITools === "function"
    ? auraTools.selectOpenAITools(message)
    : {
        tools: auraTools.getOpenAITools(),
        imageToolsEnabled: false,
        imageIntent: false,
      };
  console.log(JSON.stringify({
    level: "info",
    event: "aura_tools_selected",
    requestId: sanitizeProviderField(toolContext?.requestId, 100),
    toolsCount: toolSelection.tools.length,
    imageToolsEnabled: Boolean(toolSelection.imageToolsEnabled),
    selectedToolNames: toolSelection.tools.map((tool) => tool.name),
  }));

  if (isAuraMockProviderEnabled()) return generateMockAuraReply(businessContext);
  if (!process.env.OPENAI_API_KEY) throw missingKeyError();

  const controller = new AbortController();
  const timeoutMs = configuredTimeoutMs();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const toolsUsed = [];
  const imageJobs = [];
  const trustedToolContext = {
    ...toolContext,
    imageJobBudget: { remaining: auraTools.MAX_IMAGE_JOBS_PER_RUN || 4 },
  };
  let providerUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const requestedModel = normalizeOpenAIModel();
  let requestSummary = summarizeOpenAIRequest(
    { model: requestedModel, input: null, tools: [] },
    toolContext?.requestId
  );
  const sendOpenAIResponse = async (payload) => {
    requestSummary = summarizeOpenAIRequest(payload, toolContext?.requestId);
    return postOpenAIResponse(payload, timeoutMs, controller.signal);
  };

  try {
    const openAITools = toolSelection.tools;
    const basePayload = buildOpenAIResponsePayload({
      model: requestedModel,
      instructions: SYSTEM_PROMPT,
      input: buildInput({ message, history, businessContext }),
      tools: openAITools,
      toolChoice: "auto",
      maxOutputTokens: 900,
      reasoning: { effort: "low" },
    });

    let response = await sendOpenAIResponse(basePayload);
    providerUsage = addUsage(providerUsage, response.data?.usage || {});

    for (let round = 0; round < auraTools.MAX_TOOL_ROUNDS; round += 1) {
      const calls = extractFunctionCalls(response.data);
      if (!calls.length) break;

      const execution = await executeRequestedTools(
        calls,
        trustedToolContext,
        toolsUsed,
        auraTools.MAX_TOOLS_PER_RUN - toolsUsed.length
      );
      for (const job of execution.imageJobs) {
        if (!imageJobs.some((item) => item.jobId === job.jobId)) imageJobs.push(job);
      }

      response = await sendOpenAIResponse(
        buildOpenAIResponsePayload({
          model: requestedModel,
          instructions: SYSTEM_PROMPT,
          previousResponseId: response.data?.id,
          input: execution.outputs,
          tools: openAITools,
          toolChoice: "auto",
          maxOutputTokens: 900,
          reasoning: { effort: "low" },
        })
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
    const requiresPolling = imageJobs.some((job) => ["queued", "running"].includes(job.status));

    return {
      reply: imageJobs.length
        ? "Se crearon los trabajos de imagen."
        : typeof parsed.reply === "string" && parsed.reply.trim()
          ? parsed.reply.trim()
          : "Analice el contexto disponible, pero no encontre suficientes datos para una recomendacion precisa.",
      suggestedActions: suggestedActions.length
        ? suggestedActions
        : fallbackActions(businessContext.insights),
      provider: "openai",
      model: response.data?.model || requestedModel,
      usage: providerUsage,
      toolsUsed,
      jobs: imageJobs,
      requiresPolling,
    };
  } catch (err) {
    if (toolsUsed.length && !err.toolsUsed) err.toolsUsed = toolsUsed;

    if (err.code && err.code.startsWith("AURA_TOOL")) throw err;

    const timedOut = (
      err.code === "ECONNABORTED" ||
      err.code === "ETIMEDOUT" ||
      err.code === "ERR_CANCELED" ||
      err.name === "CanceledError"
    );
    const diagnostic = logOpenAIRequestFailure(err, requestSummary);
    const providerErr = new Error(diagnostic.message || "Error del proveedor OpenAI");
    providerErr.code = timedOut
      ? "AURA_OPENAI_TIMEOUT"
      : diagnostic.status === 429
        ? "AURA_OPENAI_RATE_LIMIT"
        : "AURA_OPENAI_ERROR";
    providerErr.auditCode = timedOut
      ? "AURA_OPENAI_TIMEOUT"
      : providerAuditCode(diagnostic.status);
    providerErr.providerStatus = diagnostic.status;
    providerErr.providerError = diagnostic;
    providerErr.toolsUsed = toolsUsed;
    throw providerErr;
  } finally {
    clearTimeout(timeout);
  }
}

validateAuraProviderConfig();

module.exports = {
  generateAuraReply,
  buildOpenAIResponsePayload,
  normalizeOpenAIModel,
  normalizeSuggestedActions,
  validateAuraProviderConfig,
  isAuraMockProviderEnabled,
  generateMockAuraReply,
};
