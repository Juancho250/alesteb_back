const db = require("../config/db");
const auraActions = require("./auraActions.service");
const auraForecasting = require("./auraForecasting.service");
const auraCustomerGrowth = require("./auraCustomerGrowth.service");
const auraSendTime = require("./auraSendTime.service");

const MAX_TOOLS_PER_RUN = 5;
const MAX_TOOL_ROUNDS = 3;
const MAX_LIMIT = 50;
const MAX_TOP_PRODUCTS_LIMIT = 10;
const DEFAULT_SLEEPING_DAYS = 30;
const DEFAULT_PURCHASE_INPUT_DAYS = 90;
const PERIODS = new Set(["today", "yesterday", "7d", "30d", "90d", "custom"]);
const TOP_PRODUCT_METRICS = new Set(["revenue", "units", "profit"]);
const CAMPAIGN_DRAFT_CHANNELS = new Set(["whatsapp", "email", "push", "instagram", "tiktok"]);
const DIRECT_CAMPAIGN_CHANNELS = new Set(["whatsapp", "email", "push"]);
const CAMPAIGN_SEGMENT_GOALS = new Set(["reactivate", "upsell", "low_stock", "new_arrivals", "retention"]);
const CAMPAIGN_OBJECTIVE_SIGNALS = new Set([
  "low_stock",
  "sleeping_products",
  "top_products",
  "churn_risk",
  "new_collection",
  "generic_growth",
]);
const AURA_ACTION_TYPES = new Set([
  "approve_campaign",
  "schedule_campaign",
  "pause_campaign",
  "create_discount_draft",
  "approve_discount",
  "enqueue_campaign_delivery",
]);
const FORECAST_HORIZONS = new Set([7, 14, 30]);
const CUSTOMER_GROWTH_SEGMENTS = new Set([
  "campeones",
  "leales",
  "nuevos",
  "potencialmente_leales",
  "requieren_atencion",
  "en_riesgo",
  "dormidos",
]);
const CUSTOMER_CHURN_LEVELS = new Set(["bajo", "medio", "alto", "critico", "insuficiente"]);

const PAID_VALID_SALES_SQL = `
  s.payment_status = 'paid'
  AND LOWER(COALESCE(s.payment_status::text, '')) NOT IN ('cancelled', 'canceled', 'anulado', 'annulled', 'void')
  AND LOWER(COALESCE(s.status::text, '')) NOT IN ('cancelled', 'canceled', 'anulado', 'annulled', 'void')
  AND LOWER(COALESCE(s.delivery_status::text, '')) NOT IN ('cancelled', 'canceled')
`;

const OPENAI_TOOLS = [
  {
    type: "function",
    name: "get_sales_summary",
    description: "Resumen agregado de ventas pagadas y no canceladas para un periodo.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        period: { type: "string", enum: [...PERIODS] },
        dateFrom: { type: "string", description: "YYYY-MM-DD, requerido solo si period=custom" },
        dateTo: { type: "string", description: "YYYY-MM-DD, requerido solo si period=custom" },
      },
      required: ["period"],
    },
  },
  {
    type: "function",
    name: "get_top_products",
    description: "Productos mas vendidos por ingresos, unidades o utilidad estimada.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        period: { type: "string", enum: [...PERIODS] },
        dateFrom: { type: "string", description: "YYYY-MM-DD, requerido solo si period=custom" },
        dateTo: { type: "string", description: "YYYY-MM-DD, requerido solo si period=custom" },
        limit: { type: "integer", minimum: 1, maximum: MAX_TOP_PRODUCTS_LIMIT },
        metric: { type: "string", enum: [...TOP_PRODUCT_METRICS] },
      },
      required: ["period", "metric"],
    },
  },
  {
    type: "function",
    name: "get_low_stock",
    description: "Productos y variantes activos con stock bajo.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        threshold: { type: "integer", minimum: 0, maximum: 1000000 },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "get_sleeping_products",
    description: "Productos activos con stock y sin ventas recientes.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        daysWithoutSales: { type: "integer", minimum: 1, maximum: 365 },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "get_pending_orders",
    description: "Pedidos no cerrados, pendientes de pago parcial/total, entrega o procurement.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: {
          type: "string",
          enum: [
            "pending",
            "partial",
            "paid",
            "ready_to_deliver",
            "procurement_pending",
            "procurement_partial",
            "procurement_complete",
          ],
        },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "get_purchase_recommendation_inputs",
    description: "Datos observables para analizar compras: stock, ventas historicas, compras pendientes, lead time, costo y proveedor.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "get_customer_rfm_summary",
    description: "Resumen RFM agregado por segmentos, sin datos personales.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        period: { type: "string", enum: ["30d", "90d"] },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "get_business_health_summary",
    description: "Resumen ejecutivo combinando salud comercial, inventario, pedidos y clientes.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        period: { type: "string", enum: ["30d", "90d"] },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "draft_campaign_copy",
    description: "Crea copy de campana en modo borrador/exportable. No envia mensajes ni crea colas.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        channel: { type: "string", enum: [...CAMPAIGN_DRAFT_CHANNELS] },
        objective: { type: "string", maxLength: 120 },
        audienceLabel: { type: "string", maxLength: 120 },
        offer: { type: "string", maxLength: 180 },
        productName: { type: "string", maxLength: 120 },
        tone: { type: "string", enum: ["premium", "direct", "warm", "urgent"] },
      },
      required: ["channel", "objective"],
    },
  },
  {
    type: "function",
    name: "suggest_campaign_segment",
    description: "Sugiere una definicion cerrada de audiencia para borrador de campana. No consulta ni exporta contactos.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        goal: { type: "string", enum: [...CAMPAIGN_SEGMENT_GOALS] },
        channel: { type: "string", enum: [...CAMPAIGN_DRAFT_CHANNELS] },
      },
      required: ["goal"],
    },
  },
  {
    type: "function",
    name: "suggest_campaign_objective",
    description: "Sugiere objetivos de campana a partir de una senal de negocio. No crea descuentos ni envia campanas.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        businessSignal: { type: "string", enum: [...CAMPAIGN_OBJECTIVE_SIGNALS] },
      },
      required: ["businessSignal"],
    },
  },
  {
    type: "function",
    name: "propose_aura_action",
    description: "Crea una accion AURA pendiente de aprobacion. No ejecuta nada ni confirma por texto libre.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        actionType: { type: "string", enum: [...AURA_ACTION_TYPES] },
        payload: {
          type: "object",
          additionalProperties: true,
          description: "Payload tipado para la accion. Sera revalidado por backend antes de guardarse.",
        },
      },
      required: ["actionType", "payload"],
    },
  },
  {
    type: "function",
    name: "get_demand_forecast",
    description: "Consulta forecasts de demanda ya calculados por AURA Predictive. No recalcula, no crea jobs y no modifica estado.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        horizon: { type: "integer", enum: [...FORECAST_HORIZONS] },
        productId: { type: "integer", minimum: 1 },
        variantId: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1, maximum: 10 },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "get_customer_growth_opportunities",
    description: "Consulta oportunidades agregadas RFM, abandono y recompra. Devuelve agregados y ejemplos anonimizados, sin PII y sin contactar clientes.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        segment: { type: "string", enum: [...CUSTOMER_GROWTH_SEGMENTS] },
        churnLevel: { type: "string", enum: [...CUSTOMER_CHURN_LEVELS] },
        limit: { type: "integer", minimum: 1, maximum: 8 },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "suggest_campaign_send_time",
    description: "Sugiere canal y franja de envio usando rendimiento observado. No agenda, no envia y usa fallback neutral si el volumen es insuficiente.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        channel: { type: "string", enum: [...DIRECT_CAMPAIGN_CHANNELS] },
        campaignType: { type: "string", maxLength: 120 },
        segment: { type: "string", maxLength: 80 },
      },
      required: [],
    },
  },
];

function createToolError(message, code = "AURA_TOOL_ERROR", status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function requireTrustedCtx(ctx) {
  if (!ctx?.ownerAdminId || !ctx?.userId) {
    throw createToolError("Contexto AURA incompleto", "AURA_TOOL_CONTEXT_REQUIRED", 500);
  }
  return {
    ownerAdminId: ctx.ownerAdminId,
    userId: ctx.userId,
    roles: Array.isArray(ctx.roles) ? ctx.roles : [],
    requestId: ctx.requestId || null,
  };
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function daysBetween(from, to) {
  const start = new Date(`${from}T00:00:00.000Z`).getTime();
  const end = new Date(`${to}T00:00:00.000Z`).getTime();
  return Math.round((end - start) / 86_400_000);
}

function periodRange({ period = "30d", dateFrom = null, dateTo = null }) {
  if (!PERIODS.has(period)) {
    throw createToolError("period invalido", "AURA_TOOL_INVALID_PERIOD");
  }

  const today = todayUtc();
  let from;
  let to;

  if (period === "today") {
    from = today;
    to = today;
  } else if (period === "yesterday") {
    from = addDays(today, -1);
    to = from;
  } else if (period === "7d") {
    from = addDays(today, -6);
    to = today;
  } else if (period === "30d") {
    from = addDays(today, -29);
    to = today;
  } else if (period === "90d") {
    from = addDays(today, -89);
    to = today;
  } else {
    if (!isIsoDate(dateFrom) || !isIsoDate(dateTo)) {
      throw createToolError("dateFrom y dateTo son requeridos en formato YYYY-MM-DD para period=custom", "AURA_TOOL_INVALID_DATE_RANGE");
    }
    from = dateFrom;
    to = dateTo;
  }

  if (daysBetween(from, to) < 0) {
    throw createToolError("dateFrom no puede ser posterior a dateTo", "AURA_TOOL_INVALID_DATE_RANGE");
  }
  if (daysBetween(from, to) > 370) {
    throw createToolError("El rango maximo permitido es 370 dias", "AURA_TOOL_DATE_RANGE_TOO_LARGE");
  }

  return { period, dateFrom: from, dateTo: to };
}

function cleanObject(args) {
  if (args === undefined || args === null) return {};
  if (typeof args !== "object" || Array.isArray(args)) {
    throw createToolError("Los argumentos de la tool deben ser un objeto", "AURA_TOOL_INVALID_ARGUMENTS");
  }
  return args;
}

function rejectAdditionalProperties(args, allowed) {
  const extra = Object.keys(args).filter((key) => !allowed.includes(key));
  if (extra.length) {
    throw createToolError(`Propiedades no permitidas: ${extra.join(", ")}`, "AURA_TOOL_ADDITIONAL_PROPERTIES");
  }
}

function optionalInteger(value, fallback, min, max, field) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw createToolError(`${field} debe ser un entero entre ${min} y ${max}`, "AURA_TOOL_INVALID_INTEGER");
  }
  return parsed;
}

function optionalEnum(value, fallback, allowed, field) {
  if (value === undefined || value === null || value === "") return fallback;
  if (!allowed.has(value)) {
    throw createToolError(`${field} invalido`, "AURA_TOOL_INVALID_ENUM");
  }
  return value;
}

function optionalText(value, fallback, maxLength, field) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") {
    throw createToolError(`${field} debe ser texto`, "AURA_TOOL_INVALID_TEXT");
  }
  const text = value.trim();
  if (!text) return fallback;
  if (text.length > maxLength) {
    throw createToolError(`${field} no puede superar ${maxLength} caracteres`, "AURA_TOOL_INVALID_TEXT");
  }
  return text;
}

function validateToolArguments(toolName, rawArgs = {}) {
  const args = cleanObject(rawArgs);

  if (toolName === "get_sales_summary") {
    rejectAdditionalProperties(args, ["period", "dateFrom", "dateTo"]);
    return periodRange({
      period: optionalEnum(args.period, null, PERIODS, "period"),
      dateFrom: args.dateFrom,
      dateTo: args.dateTo,
    });
  }

  if (toolName === "get_top_products") {
    rejectAdditionalProperties(args, ["period", "dateFrom", "dateTo", "limit", "metric"]);
    return {
      ...periodRange({
        period: optionalEnum(args.period, null, PERIODS, "period"),
        dateFrom: args.dateFrom,
        dateTo: args.dateTo,
      }),
      limit: optionalInteger(args.limit, MAX_TOP_PRODUCTS_LIMIT, 1, MAX_TOP_PRODUCTS_LIMIT, "limit"),
      metric: optionalEnum(args.metric, "revenue", TOP_PRODUCT_METRICS, "metric"),
    };
  }

  if (toolName === "get_low_stock") {
    rejectAdditionalProperties(args, ["threshold", "limit"]);
    return {
      threshold: args.threshold === undefined || args.threshold === null
        ? null
        : optionalInteger(args.threshold, null, 0, 1_000_000, "threshold"),
      limit: optionalInteger(args.limit, MAX_LIMIT, 1, MAX_LIMIT, "limit"),
    };
  }

  if (toolName === "get_sleeping_products") {
    rejectAdditionalProperties(args, ["daysWithoutSales", "limit"]);
    return {
      daysWithoutSales: optionalInteger(args.daysWithoutSales, DEFAULT_SLEEPING_DAYS, 1, 365, "daysWithoutSales"),
      limit: optionalInteger(args.limit, MAX_LIMIT, 1, MAX_LIMIT, "limit"),
    };
  }

  if (toolName === "get_pending_orders") {
    const statuses = new Set([
      "pending",
      "partial",
      "paid",
      "ready_to_deliver",
      "procurement_pending",
      "procurement_partial",
      "procurement_complete",
    ]);
    rejectAdditionalProperties(args, ["status", "limit"]);
    return {
      status: optionalEnum(args.status, null, statuses, "status"),
      limit: optionalInteger(args.limit, MAX_LIMIT, 1, MAX_LIMIT, "limit"),
    };
  }

  if (toolName === "get_purchase_recommendation_inputs") {
    rejectAdditionalProperties(args, ["limit"]);
    return {
      limit: optionalInteger(args.limit, MAX_LIMIT, 1, MAX_LIMIT, "limit"),
    };
  }

  if (toolName === "get_customer_rfm_summary") {
    rejectAdditionalProperties(args, ["period"]);
    return {
      period: optionalEnum(args.period, "90d", new Set(["30d", "90d"]), "period"),
    };
  }

  if (toolName === "get_business_health_summary") {
    rejectAdditionalProperties(args, ["period"]);
    return {
      period: optionalEnum(args.period, "30d", new Set(["30d", "90d"]), "period"),
    };
  }

  if (toolName === "draft_campaign_copy") {
    rejectAdditionalProperties(args, ["channel", "objective", "audienceLabel", "offer", "productName", "tone"]);
    const channel = optionalEnum(args.channel, null, CAMPAIGN_DRAFT_CHANNELS, "channel");
    const objective = optionalText(args.objective, null, 120, "objective");
    if (!channel || !objective) {
      throw createToolError("channel y objective son requeridos", "AURA_TOOL_MISSING_REQUIRED");
    }
    return {
      channel,
      objective,
      audienceLabel: optionalText(args.audienceLabel, "clientes seleccionados", 120, "audienceLabel"),
      offer: optionalText(args.offer, null, 180, "offer"),
      productName: optionalText(args.productName, null, 120, "productName"),
      tone: optionalEnum(args.tone, "premium", new Set(["premium", "direct", "warm", "urgent"]), "tone"),
    };
  }

  if (toolName === "suggest_campaign_segment") {
    rejectAdditionalProperties(args, ["goal", "channel"]);
    const goal = optionalEnum(args.goal, null, CAMPAIGN_SEGMENT_GOALS, "goal");
    if (!goal) throw createToolError("goal es requerido", "AURA_TOOL_MISSING_REQUIRED");
    return {
      goal,
      channel: optionalEnum(args.channel, "whatsapp", CAMPAIGN_DRAFT_CHANNELS, "channel"),
    };
  }

  if (toolName === "suggest_campaign_objective") {
    rejectAdditionalProperties(args, ["businessSignal"]);
    const businessSignal = optionalEnum(args.businessSignal, null, CAMPAIGN_OBJECTIVE_SIGNALS, "businessSignal");
    if (!businessSignal) throw createToolError("businessSignal es requerido", "AURA_TOOL_MISSING_REQUIRED");
    return {
      businessSignal,
    };
  }

  if (toolName === "propose_aura_action") {
    rejectAdditionalProperties(args, ["actionType", "payload"]);
    const actionType = optionalEnum(args.actionType, null, AURA_ACTION_TYPES, "actionType");
    if (!actionType) throw createToolError("actionType es requerido", "AURA_TOOL_MISSING_REQUIRED");
    if (!args.payload || typeof args.payload !== "object" || Array.isArray(args.payload)) {
      throw createToolError("payload es requerido y debe ser objeto", "AURA_TOOL_INVALID_ARGUMENTS");
    }
    return {
      actionType,
      payload: auraActions.validateActionPayload(actionType, args.payload),
    };
  }

  if (toolName === "get_demand_forecast") {
    rejectAdditionalProperties(args, ["horizon", "productId", "variantId", "limit"]);
    const horizon = optionalInteger(args.horizon, 7, 7, 30, "horizon");
    if (!FORECAST_HORIZONS.has(horizon)) {
      throw createToolError("horizon debe ser 7, 14 o 30", "AURA_TOOL_INVALID_HORIZON");
    }
    return {
      horizon,
      productId: optionalInteger(args.productId, null, 1, 2_147_483_647, "productId"),
      variantId: optionalInteger(args.variantId, null, 1, 2_147_483_647, "variantId"),
      limit: optionalInteger(args.limit, 5, 1, 10, "limit"),
    };
  }

  if (toolName === "get_customer_growth_opportunities") {
    rejectAdditionalProperties(args, ["segment", "churnLevel", "limit"]);
    return {
      segment: optionalEnum(args.segment, null, CUSTOMER_GROWTH_SEGMENTS, "segment"),
      churnLevel: optionalEnum(args.churnLevel, null, CUSTOMER_CHURN_LEVELS, "churnLevel"),
      limit: optionalInteger(args.limit, 5, 1, 8, "limit"),
    };
  }

  if (toolName === "suggest_campaign_send_time") {
    rejectAdditionalProperties(args, ["channel", "campaignType", "segment"]);
    return {
      channel: optionalEnum(args.channel, null, DIRECT_CAMPAIGN_CHANNELS, "channel"),
      campaignType: optionalText(args.campaignType, null, 120, "campaignType"),
      segment: optionalText(args.segment, null, 80, "segment"),
    };
  }

  throw createToolError("Tool AURA no permitida", "AURA_TOOL_NOT_ALLOWED", 400);
}

function roundMoney(value) {
  return Math.round(Number(value || 0));
}

async function safeQuery(label, sql, params) {
  try {
    const { rows } = await db.query(sql, params);
    return rows;
  } catch (err) {
    console.error(JSON.stringify({
      level: "error",
      event: "aura_tool_query_failed",
      toolQuery: label,
      errorCode: err.code || "DB_ERROR",
    }));
    throw createToolError("No fue posible ejecutar la tool AURA", "AURA_TOOL_QUERY_ERROR", 500);
  }
}

async function tableExists(tableName) {
  const rows = await safeQuery(
    "table exists",
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = $1
     ) AS exists`,
    [tableName]
  );
  return Boolean(rows[0]?.exists);
}

function mapPeriodForRfm(period) {
  return period === "30d" ? periodRange({ period: "30d" }) : periodRange({ period: "90d" });
}

async function getSalesSummary(ctx, args) {
  const safeCtx = requireTrustedCtx(ctx);
  const range = periodRange(args);
  const rows = await safeQuery(
    "get_sales_summary",
    `WITH sales_filtered AS (
       SELECT s.id, s.total, s.subtotal, s.discount_amount, s.tax_amount, s.sale_date
       FROM sales s
       WHERE s.owner_admin_id = $1
         AND s.sale_date >= $2::date
         AND s.sale_date < ($3::date + INTERVAL '1 day')
         AND ${PAID_VALID_SALES_SQL}
     ),
     item_totals AS (
       SELECT
         COALESCE(SUM(si.quantity), 0)::int AS units,
         COALESCE(SUM(si.total_profit), 0) AS gross_profit_estimated
       FROM sale_items si
       JOIN sales_filtered sf ON sf.id = si.sale_id
     )
     SELECT
       COUNT(sf.id)::int AS sales_count,
       COALESCE(SUM(sf.total), 0) AS revenue,
       COALESCE(AVG(sf.total), 0) AS average_ticket,
       COALESCE(SUM(sf.subtotal), 0) AS subtotal,
       COALESCE(SUM(sf.discount_amount), 0) AS discounts,
       COALESCE(SUM(sf.tax_amount), 0) AS taxes,
       it.units,
       it.gross_profit_estimated
     FROM sales_filtered sf
     CROSS JOIN item_totals it
     GROUP BY it.units, it.gross_profit_estimated`,
    [safeCtx.ownerAdminId, range.dateFrom, range.dateTo]
  );
  const row = rows[0] || {};
  return {
    period: range,
    currency: "COP",
    salesCount: Number(row.sales_count || 0),
    revenue: roundMoney(row.revenue),
    averageTicket: roundMoney(row.average_ticket),
    subtotal: roundMoney(row.subtotal),
    discounts: roundMoney(row.discounts),
    taxes: roundMoney(row.taxes),
    units: Number(row.units || 0),
    grossProfitEstimated: roundMoney(row.gross_profit_estimated),
    estimates: {
      grossProfitEstimated: true,
      note: "La utilidad usa sale_items.total_profit; devoluciones y ajustes no se descuentan si no estan modelados en esos items.",
    },
  };
}

async function getTopProducts(ctx, args) {
  const safeCtx = requireTrustedCtx(ctx);
  const validated = validateToolArguments("get_top_products", args);
  const orderColumn = {
    revenue: "revenue",
    units: "units",
    profit: "gross_profit_estimated",
  }[validated.metric];

  const rows = await safeQuery(
    "get_top_products",
    `SELECT
       p.id,
       p.name,
       p.sku,
       COALESCE(SUM(si.quantity), 0)::int AS units,
       COALESCE(SUM(si.subtotal), 0) AS revenue,
       COALESCE(SUM(si.total_profit), 0) AS gross_profit_estimated
     FROM sale_items si
     JOIN sales s ON s.id = si.sale_id
     JOIN products p ON p.id = si.product_id
     WHERE s.owner_admin_id = $1
       AND p.owner_admin_id = $1
       AND s.sale_date >= $2::date
       AND s.sale_date < ($3::date + INTERVAL '1 day')
       AND ${PAID_VALID_SALES_SQL}
     GROUP BY p.id, p.name, p.sku
     ORDER BY ${orderColumn} DESC, p.name ASC
     LIMIT $4`,
    [safeCtx.ownerAdminId, validated.dateFrom, validated.dateTo, validated.limit]
  );

  return {
    period: { period: validated.period, dateFrom: validated.dateFrom, dateTo: validated.dateTo },
    metric: validated.metric,
    currency: "COP",
    rows: rows.map((row) => ({
      id: row.id,
      name: row.name,
      sku: row.sku,
      units: Number(row.units || 0),
      revenue: roundMoney(row.revenue),
      grossProfitEstimated: roundMoney(row.gross_profit_estimated),
    })),
    estimates: {
      grossProfitEstimated: true,
      note: "La utilidad es estimada desde sale_items.total_profit.",
    },
  };
}

async function getLowStock(ctx, args) {
  const safeCtx = requireTrustedCtx(ctx);
  const validated = validateToolArguments("get_low_stock", args);
  const rows = await safeQuery(
    "get_low_stock",
    `WITH low_stock_items AS (
       SELECT
         p.id,
         p.name,
         false AS has_variants,
         NULL::int AS variant_id,
         p.sku AS sku,
         COALESCE(p.stock, 0)::int AS stock,
         COALESCE(p.stock_reserved, 0)::int AS stock_reserved,
         COALESCE(p.stock_safety, 0)::int AS stock_safety,
         COALESCE(p.min_stock, 5)::int AS min_stock,
         COALESCE(c.name, 'Sin categoria') AS category_name
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.owner_admin_id = $1
         AND p.is_active = true
         AND COALESCE(p.has_variants, false) = false

       UNION ALL

       SELECT
         p.id,
         p.name,
         true AS has_variants,
         pv.id AS variant_id,
         COALESCE(pv.sku, p.sku) AS sku,
         COALESCE(pv.stock, 0)::int AS stock,
         COALESCE(pv.stock_reserved, 0)::int AS stock_reserved,
         COALESCE(pv.stock_safety, 0)::int AS stock_safety,
         COALESCE(p.min_stock, 5)::int AS min_stock,
         COALESCE(c.name, 'Sin categoria') AS category_name
       FROM product_variants pv
       JOIN products p ON p.id = pv.product_id
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.owner_admin_id = $1
         AND p.is_active = true
         AND pv.is_active = true
     )
     SELECT *,
       GREATEST(0, stock - stock_reserved - stock_safety)::int AS available,
       COALESCE($2::int, min_stock)::int AS threshold_used
     FROM low_stock_items
     WHERE GREATEST(0, stock - stock_reserved - stock_safety) <= COALESCE($2::int, min_stock)
     ORDER BY available ASC, name ASC
     LIMIT $3`,
    [safeCtx.ownerAdminId, validated.threshold, validated.limit]
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    sku: row.sku,
    categoryName: row.category_name,
    hasVariants: Boolean(row.has_variants),
    variantId: row.variant_id,
    stock: Number(row.stock || 0),
    stockReserved: Number(row.stock_reserved || 0),
    stockSafety: Number(row.stock_safety || 0),
    available: Number(row.available || 0),
    minStock: Number(row.min_stock || 0),
    thresholdUsed: Number(row.threshold_used || 0),
  }));
}

async function getSleepingProducts(ctx, args) {
  const safeCtx = requireTrustedCtx(ctx);
  const validated = validateToolArguments("get_sleeping_products", args);
  const rows = await safeQuery(
    "get_sleeping_products",
    `SELECT
       p.id,
       p.name,
       p.sku,
       COALESCE(p.stock, 0)::int AS stock,
       COALESCE(p.stock_reserved, 0)::int AS stock_reserved,
       GREATEST(0, COALESCE(p.stock, 0) - COALESCE(p.stock_reserved, 0) - COALESCE(p.stock_safety, 0))::int AS available,
       MAX(s.sale_date) AS last_sale_at,
       COALESCE(SUM(CASE WHEN s.sale_date >= CURRENT_DATE - ($2::int * INTERVAL '1 day') THEN si.quantity ELSE 0 END), 0)::int AS units_in_window
     FROM products p
     LEFT JOIN sale_items si ON si.product_id = p.id
     LEFT JOIN sales s ON s.id = si.sale_id
       AND s.owner_admin_id = p.owner_admin_id
       AND ${PAID_VALID_SALES_SQL}
     WHERE p.owner_admin_id = $1
       AND p.is_active = true
       AND COALESCE(p.stock, 0) > 0
     GROUP BY p.id, p.name, p.sku, p.stock, p.stock_reserved, p.stock_safety
     HAVING MAX(s.sale_date) IS NULL
        OR MAX(s.sale_date) < CURRENT_DATE - ($2::int * INTERVAL '1 day')
     ORDER BY MAX(s.sale_date) ASC NULLS FIRST, available DESC, p.name ASC
     LIMIT $3`,
    [safeCtx.ownerAdminId, validated.daysWithoutSales, validated.limit]
  );

  return {
    daysWithoutSales: validated.daysWithoutSales,
    rows: rows.map((row) => ({
      id: row.id,
      name: row.name,
      sku: row.sku,
      stock: Number(row.stock || 0),
      stockReserved: Number(row.stock_reserved || 0),
      available: Number(row.available || 0),
      lastSaleAt: row.last_sale_at || null,
      unitsInWindow: Number(row.units_in_window || 0),
    })),
  };
}

function pendingOrderStatusClause(status, startIndex) {
  if (!status) return { clause: "", params: [], next: startIndex };
  if (["pending", "partial", "paid"].includes(status)) {
    return { clause: `AND s.payment_status = $${startIndex}`, params: [status], next: startIndex + 1 };
  }
  if (status === "ready_to_deliver") {
    return { clause: `AND s.delivery_status = $${startIndex}`, params: [status], next: startIndex + 1 };
  }
  const procurementStatus = status.replace("procurement_", "");
  return { clause: `AND s.procurement_status = $${startIndex}`, params: [procurementStatus], next: startIndex + 1 };
}

async function getPendingOrders(ctx, args) {
  const safeCtx = requireTrustedCtx(ctx);
  const validated = validateToolArguments("get_pending_orders", args);
  const filter = pendingOrderStatusClause(validated.status, 3);
  const rows = await safeQuery(
    "get_pending_orders",
    `SELECT
       s.id,
       s.sale_number,
       s.sale_date,
       s.sale_type,
       s.total,
       s.amount_paid,
       s.payment_status,
       s.delivery_status,
       s.procurement_status,
       s.estimated_delivery_date
     FROM sales s
     WHERE s.owner_admin_id = $1
       AND LOWER(COALESCE(s.payment_status::text, '')) NOT IN ('cancelled', 'canceled', 'anulado', 'annulled', 'void')
       AND LOWER(COALESCE(s.delivery_status::text, '')) NOT IN ('delivered', 'cancelled', 'canceled')
       AND (
         s.payment_status IN ('pending', 'partial')
         OR COALESCE(s.delivery_status, 'pending') NOT IN ('delivered', 'cancelled')
         OR COALESCE(s.procurement_status, 'not_required') IN ('pending', 'partial')
       )
       ${filter.clause}
     ORDER BY s.sale_date DESC
     LIMIT $2`,
    [safeCtx.ownerAdminId, validated.limit, ...filter.params]
  );

  return rows.map((row) => ({
    id: row.id,
    saleNumber: row.sale_number,
    saleDate: row.sale_date,
    saleType: row.sale_type,
    total: roundMoney(row.total),
    amountPaid: roundMoney(row.amount_paid),
    paymentStatus: row.payment_status,
    deliveryStatus: row.delivery_status,
    procurementStatus: row.procurement_status,
    estimatedDeliveryDate: row.estimated_delivery_date || null,
  }));
}

async function getPendingPurchaseUnits(ownerAdminId) {
  const hasPurchaseOrders = await tableExists("purchase_orders");
  const hasPurchaseItems = await tableExists("purchase_order_items");
  if (!hasPurchaseOrders || !hasPurchaseItems) return new Map();

  const rows = await safeQuery(
    "purchase inputs pending purchase orders",
    `SELECT
       poi.product_id,
       COALESCE(SUM(GREATEST(0, COALESCE(poi.quantity, 0) - COALESCE(poi.received_quantity, 0))), 0)::int AS pending_units
     FROM purchase_order_items poi
     JOIN purchase_orders po ON po.id = poi.purchase_order_id
     WHERE po.owner_admin_id = $1
       AND po.status NOT IN ('received', 'cancelled')
     GROUP BY poi.product_id`,
    [ownerAdminId]
  );
  return new Map(rows.map((row) => [Number(row.product_id), Number(row.pending_units || 0)]));
}

async function getPendingProcurementUnits(ownerAdminId) {
  if (!(await tableExists("procurement_orders"))) return new Map();
  const rows = await safeQuery(
    "purchase inputs pending procurement",
    `SELECT
       product_id,
       COALESCE(SUM(quantity), 0)::int AS pending_units
     FROM procurement_orders
     WHERE owner_admin_id = $1
       AND status IN ('pending', 'ordered_to_supplier')
     GROUP BY product_id`,
    [ownerAdminId]
  );
  return new Map(rows.map((row) => [Number(row.product_id), Number(row.pending_units || 0)]));
}

async function getPurchaseRecommendationInputs(ctx, args) {
  const safeCtx = requireTrustedCtx(ctx);
  const validated = validateToolArguments("get_purchase_recommendation_inputs", args);
  const [pendingPurchaseUnits, pendingProcurementUnits, rows] = await Promise.all([
    getPendingPurchaseUnits(safeCtx.ownerAdminId),
    getPendingProcurementUnits(safeCtx.ownerAdminId),
    safeQuery(
      "get_purchase_recommendation_inputs",
      `WITH sales_history AS (
         SELECT
           si.product_id,
           COALESCE(SUM(CASE WHEN s.sale_date >= CURRENT_DATE - INTERVAL '30 days' THEN si.quantity ELSE 0 END), 0)::int AS units_30d,
           COALESCE(SUM(CASE WHEN s.sale_date >= CURRENT_DATE - INTERVAL '90 days' THEN si.quantity ELSE 0 END), 0)::int AS units_90d
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         WHERE s.owner_admin_id = $1
           AND s.sale_date >= CURRENT_DATE - INTERVAL '90 days'
           AND ${PAID_VALID_SALES_SQL}
         GROUP BY si.product_id
       )
       SELECT
         p.id,
         p.name,
         p.sku,
         COALESCE(p.stock, 0)::int AS stock,
         COALESCE(p.stock_reserved, 0)::int AS stock_reserved,
         COALESCE(p.stock_safety, 0)::int AS stock_safety,
         GREATEST(0, COALESCE(p.stock, 0) - COALESCE(p.stock_reserved, 0) - COALESCE(p.stock_safety, 0))::int AS available,
         COALESCE(p.min_stock, 0)::int AS min_stock,
         COALESCE(sh.units_30d, 0)::int AS units_30d,
         COALESCE(sh.units_90d, 0)::int AS units_90d,
         ROUND(COALESCE(p.purchase_price, p.supplier_cost_estimate, 0), 0) AS cost,
         p.default_supplier_id AS provider_id,
         pr.name AS provider_name,
         COALESCE(p.supplier_lead_time_days, pr.lead_time_days)::int AS lead_time_days,
         (p.supplier_lead_time_days IS NOT NULL OR pr.lead_time_days IS NOT NULL) AS lead_time_verified
       FROM products p
       LEFT JOIN sales_history sh ON sh.product_id = p.id
       LEFT JOIN providers pr ON pr.id = p.default_supplier_id AND pr.owner_admin_id = p.owner_admin_id
       WHERE p.owner_admin_id = $1
         AND p.is_active = true
       ORDER BY available ASC, units_90d DESC, p.name ASC
       LIMIT $2`,
      [safeCtx.ownerAdminId, validated.limit]
    ),
  ]);

  return {
    observationWindowDays: DEFAULT_PURCHASE_INPUT_DAYS,
    currency: "COP",
    rows: rows.map((row) => {
      const productId = Number(row.id);
      return {
        id: productId,
        name: row.name,
        sku: row.sku,
        stock: Number(row.stock || 0),
        stockReserved: Number(row.stock_reserved || 0),
        stockSafety: Number(row.stock_safety || 0),
        available: Number(row.available || 0),
        minStock: Number(row.min_stock || 0),
        unitsSold30d: Number(row.units_30d || 0),
        unitsSold90d: Number(row.units_90d || 0),
        pendingPurchaseUnits: Number(pendingPurchaseUnits.get(productId) || 0),
        pendingProcurementUnits: Number(pendingProcurementUnits.get(productId) || 0),
        leadTimeDays: row.lead_time_days === null || row.lead_time_days === undefined
          ? null
          : Number(row.lead_time_days),
        leadTimeVerified: Boolean(row.lead_time_verified),
        cost: roundMoney(row.cost),
        provider: row.provider_id ? { id: row.provider_id, name: row.provider_name || null } : null,
      };
    }),
    note: "Estos son insumos observables. No incluyen una recomendacion numerica automatica.",
  };
}

async function getCustomerRfmSummary(ctx, args) {
  const safeCtx = requireTrustedCtx(ctx);
  const validated = validateToolArguments("get_customer_rfm_summary", args);
  const range = mapPeriodForRfm(validated.period);
  const rows = await safeQuery(
    "get_customer_rfm_summary",
    `WITH customer_sales AS (
       SELECT
         s.customer_id,
         MAX(s.sale_date) AS last_purchase_at,
         COUNT(*)::int AS frequency,
         COALESCE(SUM(s.total), 0) AS monetary
       FROM sales s
       WHERE s.owner_admin_id = $1
         AND s.customer_id IS NOT NULL
         AND s.sale_date >= $2::date
         AND s.sale_date < ($3::date + INTERVAL '1 day')
         AND ${PAID_VALID_SALES_SQL}
       GROUP BY s.customer_id
     ),
     segmented AS (
       SELECT
         CASE
           WHEN last_purchase_at >= CURRENT_DATE - INTERVAL '30 days' AND frequency >= 2 THEN 'recientes_recurrentes'
           WHEN last_purchase_at >= CURRENT_DATE - INTERVAL '30 days' THEN 'recientes'
           WHEN last_purchase_at >= CURRENT_DATE - INTERVAL '90 days' THEN 'en_observacion'
           ELSE 'dormidos'
         END AS segment,
         frequency,
         monetary
       FROM customer_sales
     )
     SELECT
       segment,
       COUNT(*)::int AS customers,
       ROUND(AVG(frequency), 2) AS average_frequency,
       ROUND(AVG(monetary), 0) AS average_monetary,
       ROUND(SUM(monetary), 0) AS total_monetary
     FROM segmented
     GROUP BY segment
     ORDER BY customers DESC`,
    [safeCtx.ownerAdminId, range.dateFrom, range.dateTo]
  );

  return {
    period: range,
    currency: "COP",
    methodology: "Segmentacion agregada por recencia y frecuencia; no incluye nombres, datos de contacto ni direcciones.",
    segments: rows.map((row) => ({
      segment: row.segment,
      customers: Number(row.customers || 0),
      averageFrequency: Number(row.average_frequency || 0),
      averageMonetary: roundMoney(row.average_monetary),
      totalMonetary: roundMoney(row.total_monetary),
    })),
  };
}

async function getBusinessHealthSummary(ctx, args) {
  const validated = validateToolArguments("get_business_health_summary", args);
  const period = validated.period || "30d";
  const [
    salesSummary,
    topProducts,
    lowStock,
    pendingOrders,
    rfmSummary,
  ] = await Promise.all([
    getSalesSummary(ctx, periodRange({ period })),
    getTopProducts(ctx, { period, metric: "revenue", limit: 5 }),
    getLowStock(ctx, { limit: 10 }),
    getPendingOrders(ctx, { limit: 10 }),
    getCustomerRfmSummary(ctx, { period: period === "90d" ? "90d" : "30d" }),
  ]);

  return {
    period: salesSummary.period,
    currency: "COP",
    facts: {
      sales: salesSummary,
      topProducts: topProducts.rows,
      lowStockCount: lowStock.length,
      pendingOrdersCount: pendingOrders.length,
      customerSegments: rfmSummary.segments,
    },
    estimates: {
      grossProfitEstimated: salesSummary.estimates.grossProfitEstimated,
      note: salesSummary.estimates.note,
    },
    recommendationsAllowed: "Solo sugerencias; AURA no ejecuta acciones.",
  };
}

function campaignCta(channel) {
  if (channel === "email") return "Ver opciones";
  if (channel === "push") return "Abrir tienda";
  if (channel === "instagram") return "Enviar mensaje";
  if (channel === "tiktok") return "Ver coleccion";
  return "Responder ahora";
}

function draftCampaignCopy(ctx, args) {
  requireTrustedCtx(ctx);
  const validated = validateToolArguments("draft_campaign_copy", args);
  const product = validated.productName ? ` de ${validated.productName}` : "";
  const offer = validated.offer ? ` ${validated.offer}` : "";
  const audience = validated.audienceLabel || "clientes seleccionados";
  const cta = campaignCta(validated.channel);

  const tonePrefix = {
    premium: "Seleccion premium",
    direct: "Oferta directa",
    warm: "Pensado para ti",
    urgent: "Ultima oportunidad",
  }[validated.tone];

  const contentByChannel = {
    whatsapp: {
      headline: `${tonePrefix}${product}`,
      body: `Hola. En ALESTEB detectamos una oportunidad para ${audience}: ${validated.objective}.${offer} Si te interesa, responde este mensaje y te ayudamos a elegir.`,
      callToAction: cta,
    },
    email: {
      headline: `${tonePrefix}${product}`,
      body: `Creamos esta recomendacion para ${audience} con un objetivo claro: ${validated.objective}.${offer} Revisa la seleccion y decide con calma antes de que cambie la disponibilidad.`,
      callToAction: cta,
    },
    push: {
      headline: `${tonePrefix}${product}`,
      body: `${validated.objective}.${offer}`.slice(0, 150),
      callToAction: cta,
    },
    instagram: {
      headline: `${tonePrefix}${product}`,
      body: `Copy exportable: ${validated.objective}.${offer} Ideal para historia o reel corto con CTA a DM.`,
      callToAction: cta,
    },
    tiktok: {
      headline: `${tonePrefix}${product}`,
      body: `Guion exportable: muestra el producto, plantea la oportunidad para ${audience}, remata con ${validated.objective}.${offer}`,
      callToAction: cta,
    },
  };

  return {
    mode: "draft_only",
    channel: validated.channel,
    exportOnly: !DIRECT_CAMPAIGN_CHANNELS.has(validated.channel),
    sendable: false,
    requiresApproval: true,
    requiresConsent: DIRECT_CAMPAIGN_CHANNELS.has(validated.channel),
    content: contentByChannel[validated.channel],
    safety: {
      noQueueCreated: true,
      noDiscountCreated: true,
      optOutMustPrevail: true,
    },
    note: "Borrador consultivo. No se envio ningun mensaje ni se creo una campana ejecutable.",
  };
}

function suggestCampaignSegment(ctx, args) {
  requireTrustedCtx(ctx);
  const validated = validateToolArguments("suggest_campaign_segment", args);
  const exportOnly = !DIRECT_CAMPAIGN_CHANNELS.has(validated.channel);

  const suggestions = {
    reactivate: {
      name: "Clientes dormidos 60 dias",
      definition: { type: "inactive_customers", days: 60 },
      rationale: "Segmento cerrado para recuperar compradores previos sin exponer datos personales.",
    },
    upsell: {
      name: "Clientes de alto valor",
      definition: { type: "high_value", minSpent: 500000, periodDays: 365 },
      rationale: "Prioriza compradores con mayor valor historico pagado.",
    },
    low_stock: {
      name: "Compradores recientes",
      definition: { type: "recent_buyers", days: 30 },
      rationale: "Evita ampliar demanda sin control cuando el inventario esta sensible.",
    },
    new_arrivals: {
      name: "Todos los clientes activos",
      definition: { type: "all_customers" },
      rationale: "Audiencia amplia para novedades; requiere estimar consentimiento antes de enviar.",
    },
    retention: {
      name: "Clientes recientes",
      definition: { type: "recent_buyers", days: 90 },
      rationale: "Refuerza recompra sin usar datos de contacto crudos.",
    },
  };

  return {
    mode: "draft_only",
    channel: validated.channel,
    exportOnly,
    sendable: false,
    requiresConsent: !exportOnly,
    suggestion: suggestions[validated.goal],
    note: "La audiencia debe estimarse en backend y solo puede quedar lista si el consentimiento esta vigente.",
  };
}

function suggestCampaignObjective(ctx, args) {
  requireTrustedCtx(ctx);
  const validated = validateToolArguments("suggest_campaign_objective", args);
  const objectives = {
    low_stock: [
      "Proteger margen priorizando productos disponibles",
      "Redirigir demanda hacia alternativas con inventario sano",
    ],
    sleeping_products: [
      "Reactivar productos dormidos con comunicacion segmentada",
      "Recuperar rotacion sin crear descuentos automaticos",
    ],
    top_products: [
      "Aumentar recompra de productos lideres",
      "Crear prueba social alrededor de productos con traccion",
    ],
    churn_risk: [
      "Recuperar clientes con baja recencia",
      "Aumentar frecuencia de compra con seguimiento consultivo",
    ],
    new_collection: [
      "Presentar novedades a clientes con afinidad historica",
      "Validar interes antes de comprometer presupuesto de pauta",
    ],
    generic_growth: [
      "Incrementar ventas con audiencia consentida",
      "Detectar oportunidad comercial sin ejecutar acciones automaticas",
    ],
  };

  return {
    mode: "draft_only",
    businessSignal: validated.businessSignal,
    objectives: objectives[validated.businessSignal],
    constraints: [
      "No crear descuentos reales desde IA",
      "No enviar campanas automaticamente",
      "No incluir contactos sin consentimiento vigente",
    ],
  };
}

async function proposeAuraAction(ctx, args) {
  const safeCtx = requireTrustedCtx(ctx);
  const validated = validateToolArguments("propose_aura_action", args);
  const action = await auraActions.proposeAction({
    ownerAdminId: safeCtx.ownerAdminId,
    userId: safeCtx.userId,
    roles: safeCtx.roles,
    actionType: validated.actionType,
    payload: validated.payload,
  });
  return {
    mode: "approval_required",
    executed: false,
    requiresEndpointApproval: true,
    action,
    note: "Accion propuesta. No se ejecutara por chat ni por confirmacion textual.",
  };
}

async function getDemandForecast(ctx, args) {
  const safeCtx = requireTrustedCtx(ctx);
  const validated = validateToolArguments("get_demand_forecast", args);
  const rows = await auraForecasting.getDemandForecasts({
    ownerAdminId: safeCtx.ownerAdminId,
    query: {
      horizon: validated.horizon,
      productId: validated.productId,
      variantId: validated.variantId,
      limit: validated.limit,
    },
  });

  return {
    mode: "read_only",
    recalculated: false,
    rows: rows.map((row) => ({
      targetType: row.targetType,
      productId: row.productId,
      variantId: row.variantId,
      productName: row.productName,
      variantSku: row.variantSku,
      horizonDays: row.horizonDays,
      predictedUnits: row.predictedValue,
      lowerBound: row.lowerBound,
      upperBound: row.upperBound,
      selectedModel: row.selectedModel,
      reliable: row.reliable,
      coldStart: row.coldStart,
      metrics: row.metrics,
      limitations: row.limitations,
      explanation: row.explanation,
      createdAt: row.createdAt,
    })),
    note: "Forecast consultivo guardado. Esta tool no recalcula ni crea jobs.",
  };
}

async function getCustomerGrowthOpportunities(ctx, args) {
  const safeCtx = requireTrustedCtx(ctx);
  const validated = validateToolArguments("get_customer_growth_opportunities", args);
  return auraCustomerGrowth.getCustomerGrowthOpportunities({
    ownerAdminId: safeCtx.ownerAdminId,
    userId: safeCtx.userId,
    roles: safeCtx.roles,
    query: validated,
  });
}

async function suggestCampaignSendTime(ctx, args) {
  const safeCtx = requireTrustedCtx(ctx);
  const validated = validateToolArguments("suggest_campaign_send_time", args);
  return auraSendTime.getSendTimeRecommendation({
    ownerAdminId: safeCtx.ownerAdminId,
    userId: safeCtx.userId,
    roles: safeCtx.roles,
    query: validated,
  });
}

const TOOL_HANDLERS = {
  get_sales_summary: getSalesSummary,
  get_top_products: getTopProducts,
  get_low_stock: getLowStock,
  get_sleeping_products: getSleepingProducts,
  get_pending_orders: getPendingOrders,
  get_purchase_recommendation_inputs: getPurchaseRecommendationInputs,
  get_customer_rfm_summary: getCustomerRfmSummary,
  get_business_health_summary: getBusinessHealthSummary,
  draft_campaign_copy: draftCampaignCopy,
  suggest_campaign_segment: suggestCampaignSegment,
  suggest_campaign_objective: suggestCampaignObjective,
  propose_aura_action: proposeAuraAction,
  get_demand_forecast: getDemandForecast,
  get_customer_growth_opportunities: getCustomerGrowthOpportunities,
  suggest_campaign_send_time: suggestCampaignSendTime,
};

function summarizeToolResult(result) {
  if (Array.isArray(result)) {
    return { kind: "array", count: result.length };
  }
  if (!result || typeof result !== "object") {
    return { kind: typeof result };
  }
  if (Array.isArray(result.rows)) {
    return { kind: "object_with_rows", rowCount: result.rows.length };
  }
  if (Array.isArray(result.segments)) {
    return { kind: "rfm_segments", segmentCount: result.segments.length };
  }
  return { kind: "object", keys: Object.keys(result).slice(0, 10) };
}

async function executeAuraTool(toolName, rawArgs, ctx) {
  const safeCtx = requireTrustedCtx(ctx);
  const validatedArgs = validateToolArguments(toolName, rawArgs);
  const handler = TOOL_HANDLERS[toolName];
  if (!handler) throw createToolError("Tool AURA no permitida", "AURA_TOOL_NOT_ALLOWED", 400);
  const data = await handler(safeCtx, validatedArgs);
  return {
    success: true,
    tool: toolName,
    arguments: validatedArgs,
    data,
  };
}

async function runAuraToolCall(toolName, rawArgs, ctx) {
  const startedAt = Date.now();
  let validatedArgs = {};
  try {
    validatedArgs = validateToolArguments(toolName, rawArgs);
    const result = await executeAuraTool(toolName, validatedArgs, ctx);
    const durationMs = Date.now() - startedAt;
    return {
      output: {
        success: true,
        tool: toolName,
        data: result.data,
      },
      audit: {
        tool: toolName,
        arguments: validatedArgs,
        durationMs,
        resultSummary: summarizeToolResult(result.data),
        error: null,
      },
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    return {
      output: {
        success: false,
        tool: toolName,
        error: {
          code: err.code || "AURA_TOOL_ERROR",
          message: err.status && err.status >= 500
            ? "No fue posible consultar esta informacion."
            : err.message,
        },
      },
      audit: {
        tool: toolName,
        arguments: validatedArgs,
        durationMs,
        resultSummary: null,
        error: {
          code: err.code || "AURA_TOOL_ERROR",
          message: err.message,
        },
      },
    };
  }
}

function getOpenAITools() {
  return OPENAI_TOOLS.map((tool) => ({ ...tool, parameters: { ...tool.parameters } }));
}

module.exports = {
  MAX_TOOLS_PER_RUN,
  MAX_TOOL_ROUNDS,
  getOpenAITools,
  executeAuraTool,
  runAuraToolCall,
  validateToolArguments,
  getSalesSummary,
  getTopProducts,
  getLowStock,
  getSleepingProducts,
  getPendingOrders,
  getPurchaseRecommendationInputs,
  getCustomerRfmSummary,
  getBusinessHealthSummary,
  draftCampaignCopy,
  suggestCampaignSegment,
  suggestCampaignObjective,
  proposeAuraAction,
  getDemandForecast,
  getCustomerGrowthOpportunities,
  suggestCampaignSendTime,
};
