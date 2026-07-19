const test = require("node:test");
const assert = require("node:assert/strict");

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-aura-tools";
process.env.OPENAI_MODEL = "gpt-5-mini";
process.env.AURA_OPENAI_TIMEOUT_MS = "18000";

const dbPath = require.resolve("../config/db");
const calls = [];

function tenantAmount(ownerAdminId, base) {
  return Number(ownerAdminId) === 202 ? base * 2 : base;
}

const fakeDb = {
  async query(sql, params = []) {
    calls.push({ sql, params });

    if (sql.includes("information_schema.tables")) {
      return { rows: [{ exists: true }], rowCount: 1 };
    }

    if (sql.includes("WITH sales_filtered") && sql.includes("sales_count")) {
      const ownerAdminId = params[0];
      return {
        rows: [{
          sales_count: Number(ownerAdminId) === 202 ? 4 : 2,
          revenue: tenantAmount(ownerAdminId, 100000),
          average_ticket: tenantAmount(ownerAdminId, 50000),
          subtotal: tenantAmount(ownerAdminId, 110000),
          discounts: 10000,
          taxes: 0,
          units: Number(ownerAdminId) === 202 ? 8 : 4,
          gross_profit_estimated: tenantAmount(ownerAdminId, 30000),
        }],
        rowCount: 1,
      };
    }

    if (
      sql.includes("get_top_products") ||
      (sql.includes("gross_profit_estimated") && sql.includes("JOIN products p ON p.id = si.product_id"))
    ) {
      const ownerAdminId = params[0];
      return {
        rows: [{
          id: Number(ownerAdminId) === 202 ? 2021 : 1011,
          name: `Producto ${ownerAdminId}`,
          sku: `SKU-${ownerAdminId}`,
          units: Number(ownerAdminId) === 202 ? 20 : 10,
          revenue: tenantAmount(ownerAdminId, 50000),
          gross_profit_estimated: tenantAmount(ownerAdminId, 12000),
        }],
        rowCount: 1,
      };
    }

    if (sql.includes("WITH low_stock_items")) {
      const ownerAdminId = params[0];
      return {
        rows: [{
          id: Number(ownerAdminId) === 202 ? 2022 : 1012,
          name: `Bajo stock ${ownerAdminId}`,
          sku: `LOW-${ownerAdminId}`,
          category_name: "General",
          has_variants: false,
          variant_id: null,
          stock: 2,
          stock_reserved: 0,
          stock_safety: 0,
          available: 2,
          min_stock: 5,
          threshold_used: params[1] ?? 5,
        }],
        rowCount: 1,
      };
    }

    if (sql.includes("MAX(s.sale_date)") && sql.includes("units_in_window")) {
      const ownerAdminId = params[0];
      return {
        rows: [{
          id: Number(ownerAdminId) === 202 ? 2023 : 1013,
          name: `Dormido ${ownerAdminId}`,
          sku: `SLP-${ownerAdminId}`,
          stock: 12,
          stock_reserved: 1,
          available: 11,
          last_sale_at: null,
          units_in_window: 0,
        }],
        rowCount: 1,
      };
    }

    if (sql.includes("s.procurement_status") && sql.includes("estimated_delivery_date") && sql.includes("ORDER BY s.sale_date DESC")) {
      const ownerAdminId = params[0];
      return {
        rows: [{
          id: Number(ownerAdminId) === 202 ? 2024 : 1014,
          sale_number: `S-${ownerAdminId}`,
          sale_date: new Date("2026-07-14T10:00:00Z"),
          sale_type: "online",
          total: tenantAmount(ownerAdminId, 70000),
          amount_paid: 0,
          payment_status: "pending",
          delivery_status: "pending",
          procurement_status: "pending",
          estimated_delivery_date: null,
        }],
        rowCount: 1,
      };
    }

    if (sql.includes("FROM purchase_order_items poi") && sql.includes("pending_units")) {
      const ownerAdminId = params[0];
      return {
        rows: [{ product_id: Number(ownerAdminId) === 202 ? 2025 : 1015, pending_units: 3 }],
        rowCount: 1,
      };
    }

    if (sql.includes("FROM procurement_orders") && sql.includes("pending_units")) {
      const ownerAdminId = params[0];
      return {
        rows: [{ product_id: Number(ownerAdminId) === 202 ? 2025 : 1015, pending_units: 2 }],
        rowCount: 1,
      };
    }

    if (sql.includes("WITH sales_history")) {
      const ownerAdminId = params[0];
      return {
        rows: [{
          id: Number(ownerAdminId) === 202 ? 2025 : 1015,
          name: `Compra input ${ownerAdminId}`,
          sku: `BUY-${ownerAdminId}`,
          stock: 4,
          stock_reserved: 1,
          stock_safety: 1,
          available: 2,
          min_stock: 5,
          units_30d: 9,
          units_90d: 21,
          cost: tenantAmount(ownerAdminId, 10000),
          provider_id: Number(ownerAdminId) === 202 ? 222 : 111,
          provider_name: `Proveedor ${ownerAdminId}`,
          lead_time_days: 7,
          lead_time_verified: true,
        }],
        rowCount: 1,
      };
    }

    if (sql.includes("WITH customer_sales")) {
      const ownerAdminId = params[0];
      return {
        rows: [{
          segment: "recientes_recurrentes",
          customers: Number(ownerAdminId) === 202 ? 6 : 3,
          average_frequency: 2,
          average_monetary: tenantAmount(ownerAdminId, 60000),
          total_monetary: tenantAmount(ownerAdminId, 180000),
        }],
        rowCount: 1,
      };
    }

    if (sql.includes("FROM prediction_results pr")) {
      const ownerAdminId = params[0];
      return {
        rows: [{
          id: `forecast-${ownerAdminId}`,
          run_id: `run-${ownerAdminId}`,
          target_type: "product",
          product_id: Number(ownerAdminId) === 202 ? 2026 : 1016,
          variant_id: null,
          prediction_date: "2026-07-21",
          horizon_days: 7,
          metric: "demand_units",
          predicted_value: tenantAmount(ownerAdminId, 14),
          lower_bound: tenantAmount(ownerAdminId, 10),
          upper_bound: tenantAmount(ownerAdminId, 18),
          confidence_score: 0.8,
          features_snapshot: {
            selectedModel: "seasonal_naive",
            modelVersion: "baseline_v1",
            featureVersion: "predictive_features_v1",
            metrics: { mae: 1, wape: 0.1, bias: 0, coverage: 0.85 },
            dailyForecast: [],
            reliable: true,
            coldStart: false,
            limitations: [],
            reason: "Baseline seleccionado por menor WAPE en backtesting.",
          },
          product_name: `Forecast ${ownerAdminId}`,
          variant_sku: null,
          created_at: "2026-07-14T00:00:00Z",
        }],
        rowCount: 1,
      };
    }

    if (sql.includes("FROM aura_customer_segment_runs") && sql.includes("LIMIT 1")) {
      return {
        rows: [{
          id: `growth-run-${params[0]}`,
          owner_admin_id: params[0],
          as_of_date: "2026-07-14",
          segment_version: "aura_customer_growth_v1",
          status: "completed",
          rows_count: 2,
          created_at: "2026-07-14T00:00:00Z",
          completed_at: "2026-07-14T00:01:00Z",
        }],
        rowCount: 1,
      };
    }

    if (sql.includes("GROUP BY segment_key")) {
      const ownerAdminId = params[1];
      return {
        rows: [{
          segment_key: "en_riesgo",
          segment_label: "En riesgo",
          customers: Number(ownerAdminId) === 202 ? 4 : 2,
          avg_recency_days: 95,
          avg_frequency: 2,
          avg_monetary: tenantAmount(ownerAdminId, 120000),
          total_monetary: tenantAmount(ownerAdminId, 240000),
          avg_churn_score: 70,
          avg_repurchase_score: 45,
          email_consented: 1,
          whatsapp_consented: 1,
          push_consented: 0,
        }],
        rowCount: 1,
      };
    }

    if (sql.includes("GROUP BY churn_level")) {
      const ownerAdminId = params[1];
      return {
        rows: [{
          level: "alto",
          customers: Number(ownerAdminId) === 202 ? 4 : 2,
          avg_score: 70,
          avg_recency_days: 95,
          avg_frequency: 2,
          email_consented: 1,
          whatsapp_consented: 1,
          push_consented: 0,
        }],
        rowCount: 1,
      };
    }

    if (sql.includes("GROUP BY repurchase_level")) {
      const ownerAdminId = params[1];
      return {
        rows: [{
          level: "media",
          customers: Number(ownerAdminId) === 202 ? 4 : 2,
          avg_score: 45,
          avg_recency_days: 95,
          avg_frequency: 2,
          email_consented: 1,
          whatsapp_consented: 1,
          push_consented: 0,
        }],
        rowCount: 1,
      };
    }

    if (sql.includes("FROM aura_customer_segment_snapshots") && sql.includes("ORDER BY repurchase_score")) {
      const ownerAdminId = params[1];
      return {
        rows: [{
          example_key: `anon-${ownerAdminId}`,
          customer_id: Number(ownerAdminId) === 202 ? 51 : 41,
          segment_key: "en_riesgo",
          segment_label: "En riesgo",
          recency_days: 95,
          frequency: 2,
          monetary: tenantAmount(ownerAdminId, 120000),
          recency_score: 2,
          frequency_score: 3,
          monetary_score: 3,
          rfm_score: 233,
          churn_score: 70,
          churn_level: "alto",
          repurchase_score: 45,
          repurchase_level: "media",
          trend_label: "decreciente",
          primary_product_id: 10,
          factors: ["Recencia elevada", "Tendencia decreciente"],
          data_used: { paidNonCancelledSalesOnly: true },
          limitations: ["Score heuristico explicable; no es probabilidad calibrada."],
          consent_summary: { email: "granted", whatsapp: "revoked" },
          segment_version: "aura_customer_growth_v1",
          created_at: "2026-07-14T00:01:00Z",
        }],
        rowCount: 1,
      };
    }

    throw new Error(`Unexpected test query: ${sql.slice(0, 100)}`);
  },
};

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: fakeDb,
};

const imageJobsPath = require.resolve("../services/auraImageJobs.service");
const imageToolCalls = [];
const imageJobIds = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
  "10000000-0000-4000-8000-000000000004",
];
const fakeImageJobs = {
  async inspectImageRequest(input) {
    imageToolCalls.push({ operation: "inspect", input });
    if (input.payload.productId === 2020) {
      const err = new Error("Producto no encontrado para este tenant");
      err.code = "AURA_IMAGE_SOURCE_NOT_FOUND";
      err.status = 404;
      throw err;
    }
    const available = Boolean(
      input.payload.sourceImageUrl
      || input.payload.productId
      || input.payload.variantId
    );
    return {
      campaign: input.payload.campaignId
        ? { id: input.payload.campaignId, channel: "instagram", status: "draft" }
        : null,
      source: available
        ? {
            available: true,
            productId: input.payload.productId || 501,
            productName: "Chaqueta Aura",
            variantId: input.payload.variantId || null,
            sourceType: input.payload.variantId ? "variant_image" : "product_image",
          }
        : { available: false },
    };
  },
  async enqueueImageJob(input) {
    imageToolCalls.push({ operation: "enqueue", input });
    if (input.payload.productId === 2020) {
      const err = new Error("Producto no encontrado para este tenant");
      err.code = "AURA_IMAGE_SOURCE_NOT_FOUND";
      err.status = 404;
      throw err;
    }
    const index = Number(input.payload.variationIndex || 0);
    return {
      deduped: false,
      created: true,
      job: {
        id: imageJobIds[index],
        status: "queued",
        input: {
          format: input.payload.format,
        },
      },
      asset: {
        id: `asset-${index}`,
        status: "pending",
      },
    };
  },
  async getJob(input) {
    imageToolCalls.push({ operation: "get", input });
    return {
      job: {
        id: input.jobId,
        type: "aura_image_generate",
        status: "queued",
        input: { format: "1:1" },
        attempts: 0,
        maxAttempts: 3,
        errorCode: null,
        createdAt: "2026-07-19T12:00:00Z",
        completedAt: null,
      },
      asset: {
        id: "asset-1",
        status: "pending",
        generatedAssetUrl: null,
        width: null,
        height: null,
        format: "1:1",
        moderationStatus: "pending",
      },
    };
  },
};

require.cache[imageJobsPath] = {
  id: imageJobsPath,
  filename: imageJobsPath,
  loaded: true,
  exports: fakeImageJobs,
};

const auraTools = require("../services/auraTools.service");

const ctxA = {
  ownerAdminId: 101,
  userId: 11,
  roles: ["admin"],
  requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};
const ctxB = {
  ownerAdminId: 202,
  userId: 22,
  roles: ["gerente"],
  requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};

function tenantQueries() {
  return calls.filter((call) => !call.sql.includes("information_schema.tables"));
}

test.beforeEach(() => {
  calls.length = 0;
  imageToolCalls.length = 0;
});

test("AURA tool schemas do not expose trusted context to the model", () => {
  const tools = auraTools.getOpenAITools();
  const serialized = JSON.stringify(tools);

  assert.equal(tools.length, 19);
  assert.equal(serialized.includes("ownerAdminId"), false);
  assert.equal(serialized.includes("owner_admin_id"), false);
  assert.equal(serialized.includes("userId"), false);
  assert.ok(tools.every((tool) => tool.parameters.additionalProperties === false));
});

test("Responses API tool schemas satisfy strict mode requirements", () => {
  const tools = auraTools.getOpenAITools();

  assert.equal(auraTools.validateOpenAIToolSchemas(tools), true);
  for (const tool of tools.filter((item) => item.strict)) {
    assert.deepEqual(
      [...tool.parameters.required].sort(),
      Object.keys(tool.parameters.properties).sort(),
      tool.name
    );
  }

  const actionTool = tools.find((tool) => tool.name === "propose_aura_action");
  assert.equal(actionTool.strict, false);
  assert.equal(actionTool.parameters.properties.payload.additionalProperties, true);
});

test("Responses API schema validation identifies the first missing required property", () => {
  assert.throws(
    () => auraTools.validateOpenAIToolSchemas([{
      type: "function",
      name: "get_sales_summary",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          period: { type: "string" },
          dateFrom: { type: ["string", "null"] },
        },
        required: ["period"],
      },
    }]),
    /tools\[0\]\.parameters\.required debe incluir: dateFrom/
  );
});

test("AURA tools reject additional properties such as forged ownerAdminId", async () => {
  await assert.rejects(
    () => auraTools.executeAuraTool(
      "get_sales_summary",
      { period: "today", ownerAdminId: 202 },
      ctxA
    ),
    /Propiedades no permitidas/
  );
  assert.equal(calls.length, 0);
});

test("AURA Growth draft tools do not send campaigns or expose trusted context", async () => {
  const copy = await auraTools.executeAuraTool("draft_campaign_copy", {
    channel: "whatsapp",
    objective: "reactivar clientes dormidos",
    audienceLabel: "clientes sin compra reciente",
    offer: "beneficio sujeto a aprobacion",
  }, ctxA);
  const segment = await auraTools.executeAuraTool("suggest_campaign_segment", {
    goal: "reactivate",
    channel: "email",
  }, ctxA);
  const objective = await auraTools.executeAuraTool("suggest_campaign_objective", {
    businessSignal: "sleeping_products",
  }, ctxA);

  assert.equal(copy.data.sendable, false);
  assert.equal(copy.data.requiresApproval, true);
  assert.equal(copy.data.safety.noQueueCreated, true);
  assert.equal(segment.data.suggestion.definition.type, "inactive_customers");
  assert.equal(objective.data.constraints.includes("No enviar campanas automaticamente"), true);
  assert.equal(calls.length, 0);
});

test("AURA Growth draft tools reject forged tenant fields", async () => {
  await assert.rejects(
    () => auraTools.executeAuraTool(
      "draft_campaign_copy",
      { channel: "email", objective: "crecer", ownerAdminId: 202 },
      ctxA
    ),
    /Propiedades no permitidas/
  );
  assert.equal(calls.length, 0);
});

test("AURA image tools are strict, registered and selected only for explicit visual intent", () => {
  const tools = auraTools.getOpenAITools();
  const imageToolNames = [
    "prepare_campaign_creatives",
    "generate_campaign_images",
    "edit_campaign_image",
    "get_image_job_status",
  ];

  for (const name of imageToolNames) {
    const tool = tools.find((item) => item.name === name);
    assert.ok(tool, name);
    assert.equal(tool.strict, true, name);
    assert.equal(tool.parameters.additionalProperties, false, name);
    assert.deepEqual(
      [...tool.parameters.required].sort(),
      Object.keys(tool.parameters.properties).sort(),
      name
    );
  }

  const consultative = auraTools.selectOpenAITools("Resume las ventas de hoy");
  const visual = auraTools.selectOpenAITools("Genera las imagenes para la campana");
  assert.equal(consultative.imageToolsEnabled, true);
  assert.equal(
    consultative.tools.some((tool) => imageToolNames.includes(tool.name)),
    false
  );
  assert.ok(imageToolNames.every(
    (name) => visual.tools.some((tool) => tool.name === name)
  ));
});

test("prepare_campaign_creatives validates the tenant source without creating jobs", async () => {
  const result = await auraTools.executeAuraTool("prepare_campaign_creatives", {
    campaignId: "11111111-1111-4111-8111-111111111111",
    productId: 501,
    variantId: null,
    sourceImageUrl: null,
    channels: ["instagram", "whatsapp"],
    formats: ["1:1", "9:16"],
    prompt: "Producto sobre fondo limpio",
    copy: "Nueva coleccion",
    callToAction: "Ver producto",
    preserveProduct: true,
  }, ctxA);

  assert.equal(result.data.mode, "creative_plan_only");
  assert.equal(result.data.sourceImage.available, true);
  assert.equal(result.data.jobs.length, 0);
  assert.equal(result.data.publication.automatic, false);
  assert.equal(imageToolCalls.filter((call) => call.operation === "enqueue").length, 0);
  assert.equal(imageToolCalls[0].input.ownerAdminId, 101);
});

test("prepare_campaign_creatives reports a missing source without claiming product fidelity", async () => {
  const result = await auraTools.executeAuraTool("prepare_campaign_creatives", {
    campaignId: null,
    productId: null,
    variantId: null,
    sourceImageUrl: null,
    channels: ["instagram"],
    formats: ["1:1"],
    prompt: "Pieza premium",
    copy: null,
    callToAction: null,
    preserveProduct: true,
  }, ctxA);

  assert.equal(result.data.sourceImage.available, false);
  assert.equal(result.data.warnings.length, 2);
  assert.match(result.data.warnings[1], /No se puede prometer/);
});

test("generate_campaign_images creates at most four asynchronous jobs with product source", async () => {
  const imageJobBudget = { remaining: 4 };
  const result = await auraTools.executeAuraTool("generate_campaign_images", {
    campaignId: "11111111-1111-4111-8111-111111111111",
    productId: 501,
    variantId: null,
    sourceImageUrl: null,
    prompt: "Crear piezas premium conservando el producto",
    formats: ["1:1", "4:5", "9:16", "16:9"],
    quality: "high",
    imageCount: 4,
    preserveProduct: true,
    channelMapping: {
      instagram: "4:5",
      whatsapp: "1:1",
      tiktok: "9:16",
      facebook: "16:9",
    },
  }, {
    ...ctxA,
    imageJobBudget,
  });

  assert.equal(result.data.jobs.length, 4);
  assert.equal(result.data.requiresPolling, true);
  assert.equal(result.data.publication.automatic, false);
  assert.deepEqual(
    result.data.jobs.map((job) => job.format),
    ["1:1", "4:5", "9:16", "16:9"]
  );
  const enqueues = imageToolCalls.filter((call) => call.operation === "enqueue");
  assert.equal(enqueues.length, 4);
  assert.ok(enqueues.every((call) => call.input.ownerAdminId === 101));
  assert.ok(enqueues.every((call) => call.input.payload.productId === 501));
  assert.equal(imageJobBudget.remaining, 0);
  await assert.rejects(
    () => auraTools.executeAuraTool("edit_campaign_image", {
      campaignId: null,
      productId: 501,
      variantId: null,
      sourceImageUrl: null,
      prompt: "Quinto job no permitido",
      format: "1:1",
      quality: "high",
      preserveProduct: true,
    }, {
      ...ctxA,
      imageJobBudget,
    }),
    /maximo 4 jobs/
  );
});

test("generate_campaign_images accepts a tenant variant and rejects more than four jobs", async () => {
  const result = await auraTools.executeAuraTool("generate_campaign_images", {
    campaignId: null,
    productId: 501,
    variantId: 701,
    sourceImageUrl: null,
    prompt: "Crear dos variantes visuales",
    formats: ["1:1"],
    quality: "medium",
    imageCount: 2,
    preserveProduct: true,
    channelMapping: null,
  }, ctxA);

  assert.equal(result.data.jobs.length, 2);
  assert.ok(imageToolCalls.every((call) => call.input.payload.variantId === 701));
  await assert.rejects(
    () => auraTools.executeAuraTool("generate_campaign_images", {
      campaignId: null,
      productId: 501,
      variantId: null,
      sourceImageUrl: null,
      prompt: "Demasiadas imagenes",
      formats: ["1:1"],
      quality: "low",
      imageCount: 5,
      preserveProduct: true,
      channelMapping: null,
    }, ctxA),
    /entre 1 y 4/
  );
});

test("generate_campaign_images asks for a source instead of creating prompt-only jobs", async () => {
  const result = await auraTools.executeAuraTool("generate_campaign_images", {
    campaignId: null,
    productId: null,
    variantId: null,
    sourceImageUrl: null,
    prompt: "Crear imagen",
    formats: ["1:1"],
    quality: "high",
    imageCount: 1,
    preserveProduct: true,
    channelMapping: null,
  }, ctxA);

  assert.equal(result.data.jobs.length, 0);
  assert.equal(result.data.requiresSourceImage, true);
  assert.equal(imageToolCalls.length, 0);
});

test("edit_campaign_image requires and forwards an authorized source", async () => {
  const sourceImageUrl = "https://res.cloudinary.com/demo/image/upload/alesteb/products/chaqueta.png";
  const result = await auraTools.executeAuraTool("edit_campaign_image", {
    campaignId: null,
    productId: null,
    variantId: null,
    sourceImageUrl,
    prompt: "Mejorar iluminacion sin alterar el producto",
    format: "4:5",
    quality: "high",
    preserveProduct: true,
  }, ctxA);

  assert.equal(result.data.jobs.length, 1);
  assert.equal(result.data.publication.automatic, false);
  assert.equal(imageToolCalls[0].input.mode, "edit");
  assert.equal(imageToolCalls[0].input.payload.sourceImageUrl, sourceImageUrl);

  await assert.rejects(
    () => auraTools.executeAuraTool("edit_campaign_image", {
      campaignId: null,
      productId: null,
      variantId: null,
      sourceImageUrl: null,
      prompt: "Mejorar imagen",
      format: "1:1",
      quality: "high",
      preserveProduct: true,
    }, ctxA),
    /Selecciona o adjunta/
  );
});

test("image tools preserve tenant context and sanitize prompt and source from tools_used", async () => {
  await assert.rejects(
    () => auraTools.executeAuraTool("generate_campaign_images", {
      campaignId: null,
      productId: 2020,
      variantId: null,
      sourceImageUrl: null,
      prompt: "No debe cruzar tenants",
      formats: ["1:1"],
      quality: "high",
      imageCount: 1,
      preserveProduct: true,
      channelMapping: null,
    }, ctxA),
    /Producto no encontrado/
  );

  const sourceImageUrl = "https://res.cloudinary.com/demo/image/upload/private-source.png";
  const execution = await auraTools.runAuraToolCall("edit_campaign_image", {
    campaignId: null,
    productId: null,
    variantId: null,
    sourceImageUrl,
    prompt: "PROMPT_PRIVATE_MARKER",
    format: "1:1",
    quality: "high",
    preserveProduct: true,
  }, ctxA);
  const serializedAudit = JSON.stringify(execution.audit);

  assert.equal(execution.output.success, true);
  assert.equal(serializedAudit.includes("PROMPT_PRIVATE_MARKER"), false);
  assert.equal(serializedAudit.includes(sourceImageUrl), false);
  assert.equal(execution.audit.arguments.sourceImageProvided, true);
  assert.equal(execution.audit.arguments.promptLength, "PROMPT_PRIVATE_MARKER".length);
});

test("get_image_job_status uses the authenticated tenant and returns no prompt", async () => {
  const jobId = "10000000-0000-4000-8000-000000000001";
  const result = await auraTools.executeAuraTool("get_image_job_status", { jobId }, ctxB);

  assert.equal(result.data.job.jobId, jobId);
  assert.equal(result.data.job.status, "queued");
  assert.equal(result.data.publication.automatic, false);
  assert.equal(imageToolCalls[0].input.ownerAdminId, 202);
  assert.equal(JSON.stringify(result.data).includes("prompt"), false);
});

test("get_sales_summary is tenant-scoped", async () => {
  const tenantA = await auraTools.executeAuraTool("get_sales_summary", { period: "today" }, ctxA);
  const tenantB = await auraTools.executeAuraTool("get_sales_summary", { period: "today" }, ctxB);

  assert.equal(tenantA.data.revenue, 100000);
  assert.equal(tenantB.data.revenue, 200000);
  assert.deepEqual(tenantQueries().map((call) => call.params[0]), [101, 202]);
});

test("each read-only AURA tool filters by the trusted tenant", async () => {
  const cases = [
    ["get_top_products", { period: "30d", metric: "revenue", limit: 3 }],
    ["get_low_stock", { threshold: 5, limit: 3 }],
    ["get_sleeping_products", { daysWithoutSales: 45, limit: 3 }],
    ["get_pending_orders", { status: "pending", limit: 3 }],
    ["get_purchase_recommendation_inputs", { limit: 3 }],
    ["get_customer_rfm_summary", { period: "90d" }],
    ["get_business_health_summary", { period: "30d" }],
    ["get_demand_forecast", { horizon: 7, limit: 3 }],
  ];

  for (const [tool, args] of cases) {
    calls.length = 0;
    const result = await auraTools.executeAuraTool(tool, args, ctxA);
    assert.equal(result.success, true, tool);
    assert.ok(tenantQueries().every((call) => call.params[0] === 101), tool);
  }
});

test("get_demand_forecast reads saved forecasts without recalculating", async () => {
  const result = await auraTools.executeAuraTool("get_demand_forecast", { horizon: 7, limit: 5 }, ctxA);

  assert.equal(result.data.mode, "read_only");
  assert.equal(result.data.recalculated, false);
  assert.equal(result.data.rows[0].predictedUnits, 14);
  assert.equal(result.data.rows[0].selectedModel, "seasonal_naive");
  assert.equal(calls.some((call) => call.sql.includes("INSERT INTO ai_jobs")), false);
});

test("get_customer_growth_opportunities returns aggregates and anonymized examples only", async () => {
  const result = await auraTools.executeAuraTool("get_customer_growth_opportunities", { limit: 3 }, ctxA);
  const serialized = JSON.stringify(result.data);

  assert.equal(result.data.safety.noPii, true);
  assert.equal(result.data.safety.noAutomaticContact, true);
  assert.equal(result.data.anonymizedExamples[0].exampleKey.startsWith("anon-"), true);
  assert.equal(Object.prototype.hasOwnProperty.call(result.data.anonymizedExamples[0], "customerId"), false);
  assert.equal(serialized.includes("email@"), false);
  assert.equal(serialized.includes("+57"), false);
  assert.equal(calls.some((call) => call.sql.includes("page_views")), false);
});

test("get_purchase_recommendation_inputs returns observable inputs, not numeric recommendations", async () => {
  const result = await auraTools.executeAuraTool("get_purchase_recommendation_inputs", { limit: 5 }, ctxA);
  const row = result.data.rows[0];

  assert.equal(row.available, 2);
  assert.equal(row.unitsSold90d, 21);
  assert.equal(row.pendingPurchaseUnits, 3);
  assert.equal(row.pendingProcurementUnits, 2);
  assert.equal(row.leadTimeVerified, true);
  assert.equal(Object.prototype.hasOwnProperty.call(row, "recommendedQuantity"), false);
});

test("get_customer_rfm_summary exposes only aggregate segments", async () => {
  const result = await auraTools.executeAuraTool("get_customer_rfm_summary", { period: "90d" }, ctxA);

  assert.deepEqual(Object.keys(result.data.segments[0]).sort(), [
    "averageFrequency",
    "averageMonetary",
    "customers",
    "segment",
    "totalMonetary",
  ]);
  assert.equal(JSON.stringify(result.data).includes("email"), false);
  assert.equal(JSON.stringify(result.data).includes("phone"), false);
});

test("Responses API flow executes read-only tools and returns audited tool usage", async () => {
  const axios = require("axios");
  const originalPost = axios.post;
  const posts = [];

  delete require.cache[require.resolve("../services/auraOpenAI.service")];
  const auraOpenAI = require("../services/auraOpenAI.service");

  axios.post = async (_url, payload) => {
    posts.push(payload);
    if (posts.length === 1) {
      return {
        data: {
          id: "resp-1",
          model: "gpt-5-mini",
          output: [{
            type: "function_call",
            call_id: "call-1",
            name: "get_sales_summary",
            arguments: JSON.stringify({ period: "today" }),
          }],
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        },
      };
    }
    return {
      data: {
        id: "resp-2",
        model: "gpt-5-mini",
        output_text: JSON.stringify({
          reply: "Hechos: ventas de hoy por COP 100.000. Recomendacion: revisar productos lideres.",
          suggestedActions: [],
        }),
        output: [],
        usage: { input_tokens: 8, output_tokens: 12, total_tokens: 20 },
      },
    };
  };

  try {
    const result = await auraOpenAI.generateAuraReply({
      message: "Resumen de ventas",
      history: [],
      businessContext: {
        insights: {},
        promptContext: { period: { today: "2026-07-14" }, metrics: {}, lists: {} },
      },
      toolContext: ctxA,
    });

    assert.equal(posts.length, 2);
    assert.ok(posts[0].tools.some((tool) => tool.name === "get_sales_summary"));
    assert.equal(JSON.stringify(posts[0].tools).includes("ownerAdminId"), false);
    assert.equal(posts[1].previous_response_id, "resp-1");
    assert.equal(posts[1].input[0].type, "function_call_output");
    assert.equal(result.reply.includes("COP"), true);
    assert.equal(result.toolsUsed.length, 1);
    assert.equal(result.toolsUsed[0].tool, "get_sales_summary");
    assert.equal(result.toolsUsed[0].arguments.period, "today");
    assert.equal(result.usage.totalTokens, 32);
  } finally {
    axios.post = originalPost;
  }
});

test("Responses API image flow returns backend job ids and requires polling", async () => {
  const axios = require("axios");
  const originalPost = axios.post;
  const originalConsoleLog = console.log;
  const posts = [];
  const logs = [];

  delete require.cache[require.resolve("../services/auraOpenAI.service")];
  const auraOpenAI = require("../services/auraOpenAI.service");

  console.log = (line) => logs.push(String(line));
  axios.post = async (_url, payload) => {
    posts.push(payload);
    if (posts.length === 1) {
      return {
        data: {
          id: "resp-image-1",
          model: "gpt-5-mini",
          output: [{
            type: "function_call",
            call_id: "call-image-1",
            name: "generate_campaign_images",
            arguments: JSON.stringify({
              campaignId: "11111111-1111-4111-8111-111111111111",
              productId: 501,
              variantId: null,
              sourceImageUrl: null,
              prompt: "PROMPT_NOT_FOR_LOGS",
              formats: ["1:1", "4:5", "9:16", "16:9"],
              quality: "high",
              imageCount: 4,
              preserveProduct: true,
              channelMapping: null,
            }),
          }],
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        },
      };
    }
    return {
      data: {
        id: "resp-image-2",
        model: "gpt-5-mini",
        output_text: JSON.stringify({
          reply: "Texto del modelo que no debe reemplazar la confirmacion estructurada.",
          jobs: [{ jobId: "fabricated", format: "1:1", status: "completed" }],
          requiresPolling: false,
          suggestedActions: [],
        }),
        output: [],
        usage: { input_tokens: 8, output_tokens: 12, total_tokens: 20 },
      },
    };
  };

  try {
    const result = await auraOpenAI.generateAuraReply({
      message: "Genera las imagenes para todas las redes",
      history: [],
      businessContext: {
        insights: {},
        promptContext: { period: { today: "2026-07-19" }, metrics: {}, lists: {} },
      },
      toolContext: ctxA,
    });

    assert.equal(posts.length, 2);
    assert.ok(posts[0].tools.some((tool) => tool.name === "generate_campaign_images"));
    assert.equal(result.reply, "Se crearon los trabajos de imagen.");
    assert.equal(result.jobs.length, 4);
    assert.deepEqual(result.jobs.map((job) => job.jobId), imageJobIds);
    assert.equal(result.jobs.some((job) => job.jobId === "fabricated"), false);
    assert.equal(result.requiresPolling, true);
    assert.equal(result.toolsUsed[0].tool, "generate_campaign_images");
    assert.equal(JSON.stringify(result.toolsUsed).includes("PROMPT_NOT_FOR_LOGS"), false);

    const selectionLog = logs
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .find((entry) => entry?.event === "aura_tools_selected");
    assert.equal(selectionLog.imageToolsEnabled, true);
    assert.ok(selectionLog.selectedToolNames.includes("generate_campaign_images"));
    assert.equal(JSON.stringify(selectionLog).includes("PROMPT_NOT_FOR_LOGS"), false);
  } finally {
    axios.post = originalPost;
    console.log = originalConsoleLog;
  }
});
