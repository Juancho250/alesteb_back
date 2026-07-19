const crypto = require("crypto");
const db = require("../config/db");
const imageProvider = require("./auraImageOpenAI.service");

const JOB_TYPES = {
  generate: "aura_image_generate",
  edit: "aura_image_edit",
};

const FORMATS = {
  instagram_square: { size: "1024x1024", width: 1024, height: 1024, aspectRatio: "1:1" },
  instagram_story: { size: "1024x1536", width: 1024, height: 1536, aspectRatio: "9:16" },
  whatsapp_square: { size: "1024x1024", width: 1024, height: 1024, aspectRatio: "1:1" },
  facebook_feed: { size: "1536x1024", width: 1536, height: 1024, aspectRatio: "16:9" },
  ecommerce_banner: { size: "1536x1024", width: 1536, height: 1024, aspectRatio: "16:9" },
  "1:1": { size: "1024x1024", width: 1024, height: 1024, aspectRatio: "1:1" },
  "4:5": { size: "1024x1280", width: 1024, height: 1280, aspectRatio: "4:5" },
  "9:16": { size: "1152x2048", width: 1152, height: 2048, aspectRatio: "9:16" },
  "16:9": { size: "2048x1152", width: 2048, height: 1152, aspectRatio: "16:9" },
};

const MAX_INSTRUCTIONS_LENGTH = 1200;
const MAX_OBJECTIVE_LENGTH = 240;
const MAX_STYLE_LENGTH = 160;
const PROMPT_VERSION = "aura-growth-image-v1";
const IMAGE_QUALITIES = new Set(["low", "medium", "high", "auto"]);
const IMAGE_CHANNELS = new Set([
  "instagram",
  "tiktok",
  "whatsapp",
  "facebook",
  "ecommerce",
  "email",
  "push",
]);

function createImageJobError(message, code = "AURA_IMAGE_JOB_ERROR", status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function requireCtx(ctx) {
  if (!ctx?.ownerAdminId || !ctx?.userId) {
    throw createImageJobError("Contexto AURA incompleto", "AURA_IMAGE_CONTEXT_REQUIRED", 500);
  }
  return {
    ownerAdminId: Number(ctx.ownerAdminId),
    userId: Number(ctx.userId),
    roles: Array.isArray(ctx.roles) ? ctx.roles : [],
  };
}

function uuid() {
  return crypto.randomUUID();
}

function isUuid(value) {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function cleanInteger(value, field, { required = false, min = 1, max = 2_147_483_647 } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw createImageJobError(`${field} es requerido`, "AURA_IMAGE_INVALID_INPUT", 400);
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw createImageJobError(`${field} debe ser un entero valido`, "AURA_IMAGE_INVALID_INPUT", 400);
  }
  return parsed;
}

function cleanText(value, field, { required = false, max = 160 } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw createImageJobError(`${field} es requerido`, "AURA_IMAGE_INVALID_INPUT", 400);
    return null;
  }
  if (typeof value !== "string") {
    throw createImageJobError(`${field} debe ser texto`, "AURA_IMAGE_INVALID_INPUT", 400);
  }
  const text = value.trim();
  if (!text && required) {
    throw createImageJobError(`${field} es requerido`, "AURA_IMAGE_INVALID_INPUT", 400);
  }
  if (text.length > max) {
    throw createImageJobError(`${field} no puede superar ${max} caracteres`, "AURA_IMAGE_INVALID_INPUT", 400);
  }
  return text || null;
}

function cleanCampaignId(value) {
  if (value === undefined || value === null || value === "") return null;
  if (!isUuid(value)) {
    throw createImageJobError("campaignId invalido", "AURA_IMAGE_INVALID_CAMPAIGN_ID", 400);
  }
  return value;
}

function cleanFormat(value) {
  const format = cleanText(value || "instagram_square", "format", { required: true, max: 40 });
  if (!FORMATS[format]) {
    throw createImageJobError("format no soportado", "AURA_IMAGE_INVALID_FORMAT", 400);
  }
  return format;
}

function cleanQuality(value) {
  const quality = cleanText(value || "high", "quality", { required: true, max: 20 });
  if (!IMAGE_QUALITIES.has(quality)) {
    throw createImageJobError("quality no soportado", "AURA_IMAGE_INVALID_QUALITY", 400);
  }
  return quality;
}

function cleanBoolean(value, field, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  throw createImageJobError(`${field} debe ser booleano`, "AURA_IMAGE_INVALID_INPUT", 400);
}

function cleanChannels(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > IMAGE_CHANNELS.size) {
    throw createImageJobError("channels debe ser un arreglo valido", "AURA_IMAGE_INVALID_INPUT", 400);
  }
  const channels = value.map((item) => cleanText(item, "channel", { required: true, max: 40 }));
  if (channels.some((channel) => !IMAGE_CHANNELS.has(channel))) {
    throw createImageJobError("channel no soportado", "AURA_IMAGE_INVALID_INPUT", 400);
  }
  return [...new Set(channels)].sort();
}

function maxDailyJobs() {
  const parsed = Number.parseInt(process.env.AURA_IMAGE_MAX_JOBS_PER_DAY || "20", 10);
  if (!Number.isSafeInteger(parsed)) return 20;
  return Math.min(Math.max(parsed, 1), 500);
}

function stableHash(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function readBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    return ["true", "1", "yes", "y", "on"].includes(value.trim().toLowerCase());
  }
  return defaultValue;
}

function normalizeCloudinaryHost(hostname) {
  return String(hostname || "").toLowerCase();
}

function validateCloudinaryCatalogUrl(url) {
  if (!url || typeof url !== "string") {
    throw createImageJobError("La imagen del catalogo no tiene URL", "AURA_IMAGE_SOURCE_MISSING", 422);
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw createImageJobError("URL de imagen de catalogo invalida", "AURA_IMAGE_SOURCE_INVALID", 422);
  }

  if (parsed.protocol !== "https:") {
    throw createImageJobError("Solo se permiten imagenes HTTPS de Cloudinary", "AURA_IMAGE_SOURCE_UNTRUSTED", 422);
  }

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const expectedHost = cloudName ? `res.cloudinary.com` : "res.cloudinary.com";
  if (normalizeCloudinaryHost(parsed.hostname) !== expectedHost) {
    throw createImageJobError("Solo se permiten URLs verificadas de Cloudinary", "AURA_IMAGE_SOURCE_UNTRUSTED", 422);
  }

  if (cloudName && !parsed.pathname.startsWith(`/${cloudName}/`)) {
    throw createImageJobError("La URL de Cloudinary no pertenece a este cloud", "AURA_IMAGE_SOURCE_UNTRUSTED", 422);
  }

  if (!parsed.pathname.includes("/image/upload/")) {
    throw createImageJobError("La URL no apunta a una imagen Cloudinary autorizada", "AURA_IMAGE_SOURCE_UNTRUSTED", 422);
  }

  return url;
}

function cloudinaryPublicIdFromUrl(url) {
  try {
    const parsed = new URL(url);
    const marker = "/image/upload/";
    const idx = parsed.pathname.indexOf(marker);
    if (idx < 0) return null;
    let rest = parsed.pathname.slice(idx + marker.length);
    rest = rest.replace(/^v\d+\//, "");
    return decodeURIComponent(rest).replace(/\.[a-z0-9]+$/i, "");
  } catch {
    return null;
  }
}

function safeCloudinaryFolder(ownerAdminId, campaignId) {
  const campaignPart = campaignId || "uncategorized";
  return `alesteb/campaigns/${ownerAdminId}/${campaignPart}`;
}

function assertSafeGeneratedPublicId(ownerAdminId, publicId) {
  const prefix = `alesteb/campaigns/${ownerAdminId}/`;
  if (!publicId || !String(publicId).startsWith(prefix)) {
    throw createImageJobError("Asset no pertenece a carpeta segura AURA", "AURA_IMAGE_DELETE_UNSAFE", 409);
  }
}

function buildPrompt({
  mode,
  productName,
  objective,
  style,
  instructions,
  format,
  preserveProduct,
}) {
  const base = [
    "Crear una pieza visual premium para campana de ALESTEB.",
    `Formato: ${format}.`,
    productName ? `Producto real del catalogo: ${productName}.` : "Usar la foto real del catalogo como referencia principal.",
    objective ? `Objetivo comercial: ${objective}.` : "Objetivo comercial: promocionar producto.",
    style ? `Estilo visual: ${style}.` : "Estilo visual: premium futurista, limpio, alto valor.",
    preserveProduct
      ? "Conservar exactamente el producto, su forma, colores, proporciones, marca visible y detalles principales."
      : "Mantener el producto reconocible y no sustituirlo por otro articulo.",
    "No inventar claims medicos, descuentos, precios ni logos nuevos.",
    "No agregar texto pequeno ilegible ni datos personales.",
  ];
  if (mode === "edit") {
    base.push("Aplicar las instrucciones como edicion visual manteniendo el producto reconocible.");
  }
  if (instructions) {
    base.push(`Instrucciones del usuario: ${instructions}.`);
  }
  return base.join(" ");
}

function mapJobRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerAdminId: Number(row.owner_admin_id),
    userId: row.user_id || null,
    type: row.type,
    status: row.status,
    priority: Number(row.priority || 100),
    input: row.input || {},
    output: row.output || {},
    attempts: Number(row.attempts || 0),
    maxAttempts: Number(row.max_attempts || 0),
    availableAt: row.available_at,
    lockedAt: row.locked_at || null,
    lockedBy: row.locked_by || null,
    errorCode: row.error_code || null,
    errorMessageRedacted: row.error_message_redacted || null,
    dedupeKey: row.dedupe_key || null,
    createdAt: row.created_at,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    updatedAt: row.updated_at || null,
  };
}

function mapAssetRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerAdminId: Number(row.owner_admin_id),
    campaignId: row.campaign_id || null,
    productId: row.product_id || null,
    variantId: row.variant_id || null,
    assetType: row.asset_type,
    source: row.source,
    status: row.status,
    originalAssetUrl: row.original_asset_url || null,
    generatedAssetUrl: row.generated_asset_url || null,
    cloudinaryPublicId: row.cloudinary_public_id || null,
    width: row.width || null,
    height: row.height || null,
    format: row.format || null,
    prompt: row.prompt || null,
    promptVersion: row.prompt_version || null,
    model: row.model || null,
    moderationStatus: row.moderation_status,
    metadata: row.metadata || {},
    createdBy: row.created_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at || null,
  };
}

async function withTransaction(fn) {
  if (typeof db.connect !== "function") return fn(db);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error("[AURA Images] rollback failed:", rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

async function assertCampaign(client, ownerAdminId, campaignId) {
  if (!campaignId) return null;
  const { rows } = await client.query(
    `SELECT id, channel, status
     FROM marketing_campaigns
     WHERE owner_admin_id = $1
       AND id = $2
     LIMIT 1`,
    [ownerAdminId, campaignId]
  );
  if (!rows.length) {
    throw createImageJobError("Campana no encontrada para este tenant", "AURA_IMAGE_CAMPAIGN_NOT_FOUND", 404);
  }
  return rows[0];
}

async function loadCatalogImage(client, { ownerAdminId, productId, variantId }) {
  if (!productId && !variantId) {
    throw createImageJobError("productId o variantId es requerido", "AURA_IMAGE_PRODUCT_REQUIRED", 400);
  }

  if (variantId) {
    const { rows } = await client.query(
      `SELECT
         p.id AS product_id,
         p.name AS product_name,
         pv.id AS variant_id,
         COALESCE(vi.url, pi.url) AS image_url
       FROM product_variants pv
       JOIN products p ON p.id = pv.product_id
       LEFT JOIN LATERAL (
         SELECT url
         FROM variant_images
         WHERE variant_id = pv.id
         ORDER BY is_main DESC, display_order ASC, id ASC
         LIMIT 1
       ) vi ON true
       LEFT JOIN LATERAL (
         SELECT url
         FROM product_images
         WHERE product_id = p.id
         ORDER BY is_main DESC, display_order ASC, id ASC
         LIMIT 1
       ) pi ON true
       WHERE pv.id = $1
         AND p.owner_admin_id = $2
         AND ($3::int IS NULL OR p.id = $3)
       LIMIT 1`,
      [variantId, ownerAdminId, productId]
    );
    if (!rows.length || !rows[0].image_url) {
      throw createImageJobError("Imagen de variante no encontrada para este tenant", "AURA_IMAGE_SOURCE_NOT_FOUND", 404);
    }
    validateCloudinaryCatalogUrl(rows[0].image_url);
    return rows[0];
  }

  const { rows } = await client.query(
    `SELECT
       p.id AS product_id,
       p.name AS product_name,
       NULL::integer AS variant_id,
       pi.url AS image_url
     FROM products p
     JOIN LATERAL (
       SELECT url
       FROM product_images
       WHERE product_id = p.id
       ORDER BY is_main DESC, display_order ASC, id ASC
       LIMIT 1
     ) pi ON true
     WHERE p.id = $1
       AND p.owner_admin_id = $2
     LIMIT 1`,
    [productId, ownerAdminId]
  );
  if (!rows.length || !rows[0].image_url) {
    throw createImageJobError("Imagen de producto no encontrada para este tenant", "AURA_IMAGE_SOURCE_NOT_FOUND", 404);
  }
  validateCloudinaryCatalogUrl(rows[0].image_url);
  return rows[0];
}

async function loadAuthorizedSourceImage(client, {
  ownerAdminId,
  productId,
  variantId,
  sourceImageUrl,
}) {
  if (!sourceImageUrl) {
    return loadCatalogImage(client, { ownerAdminId, productId, variantId });
  }

  validateCloudinaryCatalogUrl(sourceImageUrl);
  const { rows } = await client.query(
    `/* aura_authorized_image_source */
     SELECT source.product_id, source.product_name, source.variant_id,
            source.image_url, source.source_type
     FROM (
       SELECT p.id AS product_id, p.name AS product_name,
              pv.id AS variant_id, vi.url AS image_url,
              'variant_image'::text AS source_type, 1 AS source_priority
       FROM variant_images vi
       JOIN product_variants pv ON pv.id = vi.variant_id
       JOIN products p ON p.id = pv.product_id
       WHERE vi.url = $1
         AND p.owner_admin_id = $2

       UNION ALL

       SELECT p.id AS product_id, p.name AS product_name,
              pv.id AS variant_id, pi.url AS image_url,
              CASE WHEN pv.id IS NULL
                THEN 'product_image'
                ELSE 'product_image_variant_fallback'
              END::text AS source_type,
              2 AS source_priority
       FROM product_images pi
       JOIN products p ON p.id = pi.product_id
       LEFT JOIN product_variants pv
         ON pv.product_id = p.id
        AND pv.id = $4
       WHERE pi.url = $1
         AND p.owner_admin_id = $2
         AND ($4::int IS NULL OR pv.id IS NOT NULL)

       UNION ALL

       SELECT ca.product_id, p.name AS product_name, ca.variant_id,
              CASE
                WHEN ca.generated_asset_url = $1 THEN ca.generated_asset_url
                ELSE ca.original_asset_url
              END AS image_url,
              'campaign_asset'::text AS source_type,
              3 AS source_priority
       FROM campaign_assets ca
       LEFT JOIN products p
         ON p.id = ca.product_id
        AND p.owner_admin_id = ca.owner_admin_id
       WHERE ca.owner_admin_id = $2
         AND ca.status <> 'deleted'
         AND (ca.generated_asset_url = $1 OR ca.original_asset_url = $1)
     ) source
     WHERE ($3::int IS NULL OR source.product_id = $3)
       AND ($4::int IS NULL OR source.variant_id = $4)
     ORDER BY source.source_priority ASC
     LIMIT 1`,
    [sourceImageUrl, ownerAdminId, productId, variantId]
  );

  if (!rows.length) {
    throw createImageJobError(
      "La imagen fuente no pertenece al catalogo o assets autorizados de este tenant",
      "AURA_IMAGE_SOURCE_UNAUTHORIZED",
      404
    );
  }
  return rows[0];
}

async function reserveDailyQuota(client, ownerAdminId) {
  await client.query("SELECT pg_advisory_xact_lock(2070, $1)", [ownerAdminId]);
  const limit = maxDailyJobs();
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS jobs_today
     FROM ai_jobs
     WHERE owner_admin_id = $1
       AND type IN ('aura_image_generate', 'aura_image_edit')
       AND created_at >= CURRENT_DATE`,
    [ownerAdminId]
  );
  const used = Number(rows[0]?.jobs_today || 0);
  if (used >= limit) {
    throw createImageJobError("Limite diario de imagenes AURA alcanzado", "AURA_IMAGE_DAILY_LIMIT_EXCEEDED", 429);
  }
  return { used, limit };
}

async function findExistingJob(client, ownerAdminId, type, dedupeKey) {
  const { rows } = await client.query(
    `SELECT *
     FROM ai_jobs
     WHERE owner_admin_id = $1
       AND type = $2
       AND dedupe_key = $3
       AND status IN ('queued', 'running')
     ORDER BY created_at DESC
     LIMIT 1`,
    [ownerAdminId, type, dedupeKey]
  );
  return rows[0] || null;
}

async function findReusableCompletedJob(client, ownerAdminId, type, dedupeKey) {
  const { rows } = await client.query(
    `SELECT *
     FROM ai_jobs
     WHERE owner_admin_id = $1
       AND type = $2
       AND dedupe_key = $3
       AND status = 'completed'
     ORDER BY completed_at DESC NULLS LAST, created_at DESC
     LIMIT 1`,
    [ownerAdminId, type, dedupeKey]
  );
  if (!rows.length) return null;

  const job = mapJobRow(rows[0]);
  const assetId = job.output?.assetId || job.input?.assetId || null;
  if (!assetId) return null;

  const asset = await getAssetById({ ownerAdminId, assetId, client });
  if (!asset || asset.status === "deleted") return null;

  return { job, asset };
}

function imageJobDedupeKey({
  type,
  ownerAdminId,
  campaignId,
  productId,
  variantId = null,
  objective,
  format,
  style,
  instructions,
  sourceImagePublicId,
  quality = "high",
  preserveProduct = true,
  variationIndex = 0,
  channels = [],
}) {
  return stableHash({
    type,
    ownerAdminId,
    campaignId,
    productId,
    variantId,
    objective,
    format,
    style,
    instructions,
    promptVersion: PROMPT_VERSION,
    sourceImagePublicId,
    quality,
    preserveProduct,
    variationIndex,
    channels: [...channels].sort(),
  });
}

function normalizePayload(payload = {}, mode) {
  const campaignId = cleanCampaignId(payload.campaignId);
  const productId = cleanInteger(payload.productId, "productId");
  const variantId = cleanInteger(payload.variantId, "variantId");
  const format = cleanFormat(payload.format);
  const objective = cleanText(payload.objective, "objective", { max: MAX_OBJECTIVE_LENGTH });
  const style = cleanText(payload.style, "style", { max: MAX_STYLE_LENGTH });
  const sourceImageUrl = cleanText(payload.sourceImageUrl, "sourceImageUrl", { max: 2048 });
  const instructions = cleanText(payload.instructions, "instructions", {
    required: mode === "edit",
    max: MAX_INSTRUCTIONS_LENGTH,
  });
  const quality = cleanQuality(payload.quality);
  const preserveProduct = cleanBoolean(payload.preserveProduct, "preserveProduct", true);
  const variationIndex = cleanInteger(payload.variationIndex, "variationIndex", {
    min: 0,
    max: 3,
  }) ?? 0;
  const channels = cleanChannels(payload.channels);
  return {
    campaignId,
    productId,
    variantId,
    sourceImageUrl,
    objective,
    format,
    style,
    instructions,
    quality,
    preserveProduct,
    variationIndex,
    channels,
  };
}

async function inspectImageRequest(input) {
  const ctx = requireCtx(input);
  const payload = normalizePayload(input.payload || {}, input.mode === "edit" ? "edit" : "generate");
  const campaign = await assertCampaign(db, ctx.ownerAdminId, payload.campaignId);
  const hasSourceReference = Boolean(
    payload.sourceImageUrl || payload.productId || payload.variantId
  );
  const source = hasSourceReference
    ? await loadAuthorizedSourceImage(db, {
        ownerAdminId: ctx.ownerAdminId,
        productId: payload.productId,
        variantId: payload.variantId,
        sourceImageUrl: payload.sourceImageUrl,
      })
    : null;

  return {
    campaign: campaign
      ? { id: campaign.id, channel: campaign.channel, status: campaign.status }
      : null,
    source: source
      ? {
          available: true,
          productId: source.product_id === null ? null : Number(source.product_id),
          productName: source.product_name || null,
          variantId: source.variant_id === null ? null : Number(source.variant_id),
          sourceType: source.source_type || "catalog",
        }
      : { available: false },
  };
}

async function enqueueImageJob(input) {
  const ctx = requireCtx(input);
  const mode = input.mode === "edit" ? "edit" : "generate";
  const payload = normalizePayload(input.payload || {}, mode);
  const type = JOB_TYPES[mode];
  const forceRequested = readBoolean(input.payload?.force, false);
  const cacheRequested = !forceRequested && readBoolean(
    input.payload?.cache || input.payload?.reuseCompleted || input.payload?.useCache
  );

  return withTransaction(async (client) => {
    await assertCampaign(client, ctx.ownerAdminId, payload.campaignId);
    const source = await loadAuthorizedSourceImage(client, {
      ownerAdminId: ctx.ownerAdminId,
      productId: payload.productId,
      variantId: payload.variantId,
      sourceImageUrl: payload.sourceImageUrl,
    });
    const formatSpec = FORMATS[payload.format];
    const prompt = buildPrompt({
      mode,
      productName: source.product_name,
      objective: payload.objective,
      style: payload.style,
      instructions: payload.instructions,
      format: payload.format,
      preserveProduct: payload.preserveProduct,
    });
    const dedupeKey = imageJobDedupeKey({
      type,
      ownerAdminId: ctx.ownerAdminId,
      campaignId: payload.campaignId,
      productId: source.product_id === null ? null : Number(source.product_id),
      variantId: source.variant_id === null ? null : Number(source.variant_id),
      objective: payload.objective,
      format: payload.format,
      style: payload.style,
      instructions: payload.instructions,
      sourceImagePublicId: cloudinaryPublicIdFromUrl(source.image_url),
      quality: payload.quality,
      preserveProduct: payload.preserveProduct,
      variationIndex: payload.variationIndex,
      channels: payload.channels,
    });

    const existing = await findExistingJob(client, ctx.ownerAdminId, type, dedupeKey);
    if (existing) {
      return {
        deduped: true,
        cached: false,
        forced: forceRequested,
        created: false,
        job: mapJobRow(existing),
        asset: existing.input?.assetId
          ? await getAssetById({ ownerAdminId: ctx.ownerAdminId, assetId: existing.input.assetId, client })
          : null,
      };
    }

    if (cacheRequested) {
      const cached = await findReusableCompletedJob(client, ctx.ownerAdminId, type, dedupeKey);
      if (cached) {
        return {
          deduped: true,
          cached: true,
          forced: false,
          created: false,
          job: cached.job,
          asset: cached.asset,
        };
      }
    }

    const usage = await reserveDailyQuota(client, ctx.ownerAdminId);
    const jobId = uuid();
    const assetId = uuid();
    const jobInput = {
      mode,
      assetId,
      campaignId: payload.campaignId,
      productId: source.product_id === null ? null : Number(source.product_id),
      variantId: source.variant_id === null ? null : Number(source.variant_id),
      objective: payload.objective,
      format: payload.format,
      size: formatSpec.size,
      requestedAspectRatio: formatSpec.aspectRatio,
      style: payload.style,
      instructions: payload.instructions,
      quality: payload.quality,
      preserveProduct: payload.preserveProduct,
      variationIndex: payload.variationIndex,
      channels: payload.channels,
      sourceImageUrl: source.image_url,
      sourceImagePublicId: cloudinaryPublicIdFromUrl(source.image_url),
      sourceType: source.source_type || "catalog",
      prompt,
      promptVersion: PROMPT_VERSION,
      requestedAt: new Date().toISOString(),
    };

    const { rows: jobRows } = await client.query(
      `INSERT INTO ai_jobs
         (id, owner_admin_id, user_id, type, status, priority, input, output, max_attempts, dedupe_key)
       VALUES ($1, $2, $3, $4, 'queued', $5, $6, '{}'::jsonb, $7, $8)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        jobId,
        ctx.ownerAdminId,
        ctx.userId,
        type,
        mode === "edit" ? 80 : 100,
        JSON.stringify(jobInput),
        3,
        dedupeKey,
      ]
    );

    if (!jobRows.length) {
      const deduped = await findExistingJob(client, ctx.ownerAdminId, type, dedupeKey);
      if (deduped) {
        return {
          deduped: true,
          cached: false,
          forced: forceRequested,
          created: false,
          job: mapJobRow(deduped),
          asset: deduped.input?.assetId
            ? await getAssetById({ ownerAdminId: ctx.ownerAdminId, assetId: deduped.input.assetId, client })
            : null,
        };
      }

      if (cacheRequested) {
        const cached = await findReusableCompletedJob(client, ctx.ownerAdminId, type, dedupeKey);
        if (cached) {
          return {
            deduped: true,
            cached: true,
            forced: false,
            created: false,
            job: cached.job,
            asset: cached.asset,
          };
        }
      }

      throw createImageJobError("No se pudo crear el job de imagen", "AURA_IMAGE_JOB_INSERT_FAILED", 409);
    }

    const { rows: assetRows } = await client.query(
      `INSERT INTO campaign_assets
         (id, owner_admin_id, campaign_id, product_id, variant_id, asset_type, source, status,
          original_asset_url, format, prompt, prompt_version, model, moderation_status, metadata, created_by)
       VALUES ($1, $2, $3, $4, $5, 'image', $6, 'pending', $7, $8, $9, $10, $11, 'pending', $12, $13)
       RETURNING *`,
      [
        assetId,
        ctx.ownerAdminId,
        payload.campaignId,
        source.product_id === null ? null : Number(source.product_id),
        source.variant_id === null ? null : Number(source.variant_id),
        mode === "edit" ? "aura_edited" : "aura_generated",
        source.image_url,
        payload.format,
        prompt,
        PROMPT_VERSION,
        process.env.OPENAI_IMAGE_MODEL || null,
        JSON.stringify({
          requestedSize: formatSpec,
          quality: payload.quality,
          preserveProduct: payload.preserveProduct,
          variationIndex: payload.variationIndex,
          channels: payload.channels,
          sourceType: source.source_type || "catalog",
          sourceImagePublicId: cloudinaryPublicIdFromUrl(source.image_url),
          quota: { usedBeforeRequest: usage.used, limit: usage.limit },
        }),
        ctx.userId,
      ]
    );

    return {
      deduped: false,
      cached: false,
      forced: forceRequested,
      created: true,
      job: mapJobRow(jobRows[0]),
      asset: mapAssetRow(assetRows[0]),
      usage: {
        jobsRemaining: Math.max(usage.limit - usage.used - 1, 0),
        dailyLimit: usage.limit,
      },
    };
  });
}

async function getAssetById({ ownerAdminId, assetId, client = db }) {
  const { rows } = await client.query(
    `SELECT *
     FROM campaign_assets
     WHERE owner_admin_id = $1
       AND id = $2
     LIMIT 1`,
    [ownerAdminId, assetId]
  );
  return rows.length ? mapAssetRow(rows[0]) : null;
}

async function getJob(input) {
  const ctx = requireCtx(input);
  if (!isUuid(input.jobId)) {
    throw createImageJobError("jobId invalido", "AURA_IMAGE_INVALID_JOB_ID", 400);
  }
  const { rows } = await db.query(
    `SELECT *
     FROM ai_jobs
     WHERE owner_admin_id = $1
       AND id = $2
     LIMIT 1`,
    [ctx.ownerAdminId, input.jobId]
  );
  if (!rows.length) {
    throw createImageJobError("Job no encontrado", "AURA_IMAGE_JOB_NOT_FOUND", 404);
  }
  const job = mapJobRow(rows[0]);
  const asset = job.input?.assetId
    ? await getAssetById({ ownerAdminId: ctx.ownerAdminId, assetId: job.input.assetId })
    : null;
  return { job, asset };
}

async function listCampaignAssets(input) {
  const ctx = requireCtx(input);
  const campaignId = cleanCampaignId(input.campaignId);
  await assertCampaign(db, ctx.ownerAdminId, campaignId);
  const limit = Math.min(Math.max(Number.parseInt(input.query?.limit || "50", 10) || 50, 1), 100);
  const offset = Math.min(Math.max(Number.parseInt(input.query?.offset || "0", 10) || 0, 0), 10_000);

  const { rows } = await db.query(
    `SELECT *
     FROM campaign_assets
     WHERE owner_admin_id = $1
       AND campaign_id = $2
       AND status <> 'deleted'
     ORDER BY created_at DESC
     LIMIT $3 OFFSET $4`,
    [ctx.ownerAdminId, campaignId, limit, offset]
  );
  return {
    rows: rows.map(mapAssetRow),
    pagination: { limit, offset, count: rows.length },
  };
}

async function deleteCampaignAsset(input) {
  const ctx = requireCtx(input);
  const asset = await getAssetById({ ownerAdminId: ctx.ownerAdminId, assetId: input.assetId });
  if (!asset || asset.status === "deleted") {
    throw createImageJobError("Asset no encontrado", "AURA_IMAGE_ASSET_NOT_FOUND", 404);
  }

  if (asset.cloudinaryPublicId) {
    assertSafeGeneratedPublicId(ctx.ownerAdminId, asset.cloudinaryPublicId);
    await imageProvider.destroyGeneratedImage(asset.cloudinaryPublicId);
  }

  const { rows } = await db.query(
    `UPDATE campaign_assets
     SET status = 'deleted',
         generated_asset_url = NULL,
         deleted_at = NOW(),
         updated_at = NOW()
     WHERE owner_admin_id = $1
       AND id = $2
     RETURNING *`,
    [ctx.ownerAdminId, input.assetId]
  );
  return mapAssetRow(rows[0]);
}

function normalizeImageClaimScope({ ownerAdminId = null, jobId = null } = {}) {
  const hasOwner = ownerAdminId !== undefined && ownerAdminId !== null;
  const hasJob = jobId !== undefined && jobId !== null;
  if (!hasOwner && !hasJob) return null;
  if (!hasOwner || !hasJob) {
    throw createImageJobError(
      "Un claim acotado requiere ownerAdminId y jobId",
      "AURA_IMAGE_CLAIM_SCOPE_INCOMPLETE",
      500
    );
  }
  const parsedOwner = Number(ownerAdminId);
  if (!Number.isSafeInteger(parsedOwner) || parsedOwner <= 0 || !isUuid(jobId)) {
    throw createImageJobError(
      "Alcance de claim invalido",
      "AURA_IMAGE_CLAIM_SCOPE_INVALID",
      500
    );
  }
  return { ownerAdminId: parsedOwner, jobId };
}

async function claimNextImageJob({ workerId, ownerAdminId = null, jobId = null }) {
  const scope = normalizeImageClaimScope({ ownerAdminId, jobId });
  const params = [workerId];
  let scopeSql = "";
  if (scope) {
    params.push(scope.ownerAdminId, scope.jobId);
    scopeSql = `
         AND owner_admin_id = $2
         AND id = $3`;
  }

  const { rows } = await db.query(
    `WITH next_job AS (
       SELECT id
       FROM ai_jobs
       WHERE status = 'queued'
         AND type IN ('aura_image_generate', 'aura_image_edit')
         AND available_at <= NOW()
         AND attempts < max_attempts
         ${scopeSql}
       ORDER BY priority ASC, created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE ai_jobs j
     SET status = 'running',
         attempts = attempts + 1,
         locked_at = NOW(),
         locked_by = $1,
         started_at = COALESCE(started_at, NOW()),
         updated_at = NOW()
     FROM next_job
     WHERE j.id = next_job.id
     RETURNING j.*`,
    params
  );
  return rows.length ? mapJobRow(rows[0]) : null;
}

async function recoverStaleImageJobs({ staleMinutes = 15 } = {}) {
  const parsed = Number.parseInt(staleMinutes, 10);
  const safeMinutes = Number.isSafeInteger(parsed) ? Math.min(Math.max(parsed, 5), 240) : 15;
  const { rows } = await db.query(
    `UPDATE ai_jobs
     SET status = 'failed',
         error_code = 'AURA_IMAGE_STALE_CLAIM',
         error_message_redacted = 'Job abandonado; revision manual requerida para evitar generacion duplicada',
         completed_at = NOW(),
         locked_at = NULL,
         locked_by = NULL,
         updated_at = NOW()
     WHERE status = 'running'
       AND type IN ('aura_image_generate', 'aura_image_edit')
       AND locked_at < NOW() - ($1::int * INTERVAL '1 minute')
     RETURNING id, owner_admin_id, input`,
    [safeMinutes]
  );

  for (const row of rows) {
    const assetId = row.input?.assetId;
    if (assetId) {
      await markAssetFailed({
        ownerAdminId: row.owner_admin_id,
        assetId,
        code: "AURA_IMAGE_STALE_CLAIM",
        message: "Job abandonado; revision manual requerida",
      }).catch(() => {});
    }
  }
  return { recovered: rows.length, strategy: "failed_manual_review" };
}

function nextBackoffMinutes(attempts) {
  return Math.min(60, Math.max(1, 2 ** Math.max(Number(attempts || 1) - 1)));
}

async function markJobFailed({ jobId, ownerAdminId, attempts, maxAttempts, errorCode, errorMessageRedacted }) {
  const terminal = Number(attempts || 0) >= Number(maxAttempts || 3);
  const { rows } = await db.query(
    `UPDATE ai_jobs
     SET status = $1,
         available_at = CASE WHEN $1 = 'queued' THEN NOW() + ($2::int * INTERVAL '1 minute') ELSE available_at END,
         locked_at = NULL,
         locked_by = NULL,
         error_code = $3,
         error_message_redacted = $4,
         completed_at = CASE WHEN $1 = 'failed' THEN NOW() ELSE completed_at END,
         updated_at = NOW()
     WHERE id = $5
       AND owner_admin_id = $6
     RETURNING *`,
    [
      terminal ? "failed" : "queued",
      nextBackoffMinutes(attempts),
      String(errorCode || "AURA_IMAGE_JOB_FAILED").slice(0, 80),
      String(errorMessageRedacted || "Error procesando imagen").slice(0, 500),
      jobId,
      ownerAdminId,
    ]
  );
  return rows.length ? mapJobRow(rows[0]) : null;
}

async function markAssetProcessing({ ownerAdminId, assetId }) {
  await db.query(
    `UPDATE campaign_assets
     SET status = 'processing',
         updated_at = NOW()
     WHERE owner_admin_id = $1
       AND id = $2`,
    [ownerAdminId, assetId]
  );
}

async function markAssetFailed({ ownerAdminId, assetId, code, message }) {
  await db.query(
    `UPDATE campaign_assets
     SET status = 'failed',
         metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
         updated_at = NOW()
     WHERE owner_admin_id = $1
       AND id = $2`,
    [ownerAdminId, assetId, JSON.stringify({ errorCode: code, errorMessageRedacted: message })]
  );
}

async function completeImageJob({ job, providerResult, uploadResult, moderation }) {
  const assetId = job.input.assetId;
  const { rows: assetRows } = await db.query(
    `UPDATE campaign_assets
     SET status = 'ready',
         generated_asset_url = $3,
         cloudinary_public_id = $4,
         width = $5,
         height = $6,
         model = $7,
         moderation_status = $8,
         metadata = COALESCE(metadata, '{}'::jsonb) || $9::jsonb,
         updated_at = NOW()
     WHERE owner_admin_id = $1
       AND id = $2
     RETURNING *`,
    [
      job.ownerAdminId,
      assetId,
      uploadResult.secureUrl,
      uploadResult.publicId,
      uploadResult.width,
      uploadResult.height,
      providerResult.model,
      moderation.status,
      JSON.stringify({
        openaiEndpoint: providerResult.endpoint,
        usage: providerResult.usage,
        estimatedCostUsd: Number(providerResult.estimatedCostUsd || providerResult.usage?.estimatedCostUsd || 0),
        cloudinary: {
          bytes: uploadResult.bytes,
          format: uploadResult.format,
        },
        completedAt: new Date().toISOString(),
      }),
    ]
  );

  const { rows: jobRows } = await db.query(
    `UPDATE ai_jobs
     SET status = 'completed',
         output = $3::jsonb,
         locked_at = NULL,
         locked_by = NULL,
         completed_at = NOW(),
         updated_at = NOW()
     WHERE owner_admin_id = $1
       AND id = $2
     RETURNING *`,
    [
      job.ownerAdminId,
      job.id,
      JSON.stringify({
        assetId,
        generatedAssetUrl: uploadResult.secureUrl,
        cloudinaryPublicId: uploadResult.publicId,
        model: providerResult.model,
        moderationStatus: moderation.status,
        estimatedCostUsd: Number(providerResult.estimatedCostUsd || providerResult.usage?.estimatedCostUsd || 0),
      }),
    ]
  );

  return {
    job: mapJobRow(jobRows[0]),
    asset: mapAssetRow(assetRows[0]),
  };
}

async function processImageJob(job) {
  if (!job?.input?.assetId) {
    throw createImageJobError("Job sin assetId", "AURA_IMAGE_JOB_INVALID_INPUT", 500);
  }
  await markAssetProcessing({ ownerAdminId: job.ownerAdminId, assetId: job.input.assetId });

  const inputModeration = await imageProvider.moderateImageRequest({
    prompt: job.input.prompt,
    imageUrl: job.input.sourceImageUrl,
  });
  if (inputModeration.flagged) {
    const err = createImageJobError("Solicitud bloqueada por moderacion", "AURA_IMAGE_MODERATION_FLAGGED", 422);
    err.moderationStatus = "flagged";
    throw err;
  }

  const providerResult = job.input.sourceImageUrl
    ? await imageProvider.editImageFromCatalog({
        prompt: job.input.prompt,
        sourceImageUrl: job.input.sourceImageUrl,
        size: job.input.size,
        quality: job.input.quality,
      })
    : await imageProvider.createImageFromPrompt({
        prompt: job.input.prompt,
        size: job.input.size,
        quality: job.input.quality,
      });

  const outputModeration = await imageProvider.moderateImageRequest({
    prompt: job.input.prompt,
    imageBase64: providerResult.b64Json,
  });
  if (outputModeration.flagged) {
    const err = createImageJobError("Resultado bloqueado por moderacion", "AURA_IMAGE_OUTPUT_FLAGGED", 422);
    err.moderationStatus = "flagged";
    throw err;
  }

  const folder = safeCloudinaryFolder(job.ownerAdminId, job.input.campaignId);
  const uploadResult = await imageProvider.uploadGeneratedImage({
    b64Json: providerResult.b64Json,
    folder,
    assetId: job.input.assetId,
  });
  try {
    return await completeImageJob({
      job,
      providerResult,
      uploadResult,
      moderation: outputModeration,
    });
  } catch (err) {
    if (uploadResult.publicId) {
      await imageProvider.destroyGeneratedImage(uploadResult.publicId).catch(() => {});
    }
    throw err;
  }
}

module.exports = {
  JOB_TYPES,
  FORMATS,
  PROMPT_VERSION,
  createImageJobError,
  validateCloudinaryCatalogUrl,
  cloudinaryPublicIdFromUrl,
  safeCloudinaryFolder,
  assertSafeGeneratedPublicId,
  imageJobDedupeKey,
  inspectImageRequest,
  enqueueImageJob,
  getJob,
  listCampaignAssets,
  deleteCampaignAsset,
  normalizeImageClaimScope,
  claimNextImageJob,
  recoverStaleImageJobs,
  markJobFailed,
  markAssetFailed,
  processImageJob,
  mapJobRow,
  mapAssetRow,
};
