const test = require("node:test");
const assert = require("node:assert/strict");

process.env.CLOUDINARY_CLOUD_NAME = "demo";
process.env.OPENAI_API_KEY = "sk-test-images";
process.env.OPENAI_IMAGE_MODEL = "gpt-image-test";
process.env.AURA_IMAGE_MAX_JOBS_PER_DAY = "20";

const dbPath = require.resolve("../src/platform/database");
const providerPath = require.resolve("../services/auraImageOpenAI.service");
const calls = [];
const jobs = [];
const assets = [];
const destroyedPublicIds = [];
let providerMode = "success";

const campaignA = "11111111-1111-4111-8111-111111111111";
const campaignB = "22222222-2222-4222-8222-222222222222";

const products = [
  {
    id: 501,
    owner_admin_id: 101,
    name: "Chaqueta Aura",
    image_url: "https://res.cloudinary.com/demo/image/upload/v1720000000/alesteb/products/chaqueta.webp",
  },
  {
    id: 502,
    owner_admin_id: 202,
    name: "Bolso Tenant B",
    image_url: "https://res.cloudinary.com/demo/image/upload/v1720000000/alesteb/products/bolso.webp",
  },
  {
    id: 503,
    owner_admin_id: 101,
    name: "Imagen externa",
    image_url: "https://example.com/not-allowed.png",
  },
];
const variants = [
  {
    id: 701,
    product_id: 501,
    owner_admin_id: 101,
    image_url: "https://res.cloudinary.com/demo/image/upload/v1720000000/alesteb/products/chaqueta-negra.webp",
  },
  {
    id: 702,
    product_id: 502,
    owner_admin_id: 202,
    image_url: "https://res.cloudinary.com/demo/image/upload/v1720000000/alesteb/products/bolso-rojo.webp",
  },
];

function now() {
  return new Date("2026-07-14T12:00:00Z");
}

function imageDedupeKey({ ownerAdminId, campaignId, productId, variantId = null, objective, format, style, instructions, type = "aura_image_generate" }) {
  return imageJobs.imageJobDedupeKey({
    type,
    ownerAdminId,
    campaignId,
    productId,
    variantId,
    objective,
    format,
    style,
    instructions,
    sourceImagePublicId: `alesteb/products/chaqueta`,
  });
}

function jobRow(row) {
  return {
    id: row.id,
    owner_admin_id: row.owner_admin_id,
    user_id: row.user_id,
    type: row.type,
    status: row.status,
    priority: row.priority,
    input: row.input,
    output: row.output || {},
    attempts: row.attempts || 0,
    max_attempts: row.max_attempts || 3,
    available_at: row.available_at || now(),
    locked_at: row.locked_at || null,
    locked_by: row.locked_by || null,
    error_code: row.error_code || null,
    error_message_redacted: row.error_message_redacted || null,
    dedupe_key: row.dedupe_key || null,
    created_at: row.created_at || now(),
    started_at: row.started_at || null,
    completed_at: row.completed_at || null,
    updated_at: row.updated_at || now(),
  };
}

function assetRow(row) {
  return {
    id: row.id,
    owner_admin_id: row.owner_admin_id,
    campaign_id: row.campaign_id || null,
    product_id: row.product_id || null,
    variant_id: row.variant_id || null,
    asset_type: row.asset_type || "image",
    source: row.source || "aura_generated",
    status: row.status || "pending",
    original_asset_url: row.original_asset_url || null,
    generated_asset_url: row.generated_asset_url || null,
    cloudinary_public_id: row.cloudinary_public_id || null,
    width: row.width || null,
    height: row.height || null,
    format: row.format || null,
    prompt: row.prompt || null,
    prompt_version: row.prompt_version || null,
    model: row.model || null,
    moderation_status: row.moderation_status || "pending",
    metadata: row.metadata || {},
    created_by: row.created_by || null,
    created_at: row.created_at || now(),
    updated_at: row.updated_at || now(),
  };
}

async function handleQuery(sql, params = []) {
  calls.push({ sql, params });

  if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
    return { rows: [], rowCount: 0 };
  }

  if (sql.includes("pg_advisory_xact_lock")) {
    return { rows: [], rowCount: 1 };
  }

  if (sql.includes("FROM marketing_campaigns") && sql.includes("LIMIT 1")) {
    const owner = Number(params[0]);
    const id = params[1];
    if (owner === 101 && id === campaignA) {
      return { rows: [{ id, channel: "instagram", status: "draft" }], rowCount: 1 };
    }
    if (owner === 202 && id === campaignB) {
      return { rows: [{ id, channel: "instagram", status: "draft" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  if (sql.includes("aura_authorized_image_source")) {
    const [sourceImageUrl, ownerAdminId, productId, variantId] = params;
    const variant = variants.find(
      (item) => item.image_url === sourceImageUrl
        && item.owner_admin_id === Number(ownerAdminId)
        && (!productId || item.product_id === Number(productId))
        && (!variantId || item.id === Number(variantId))
    );
    if (variant) {
      const product = products.find((item) => item.id === variant.product_id);
      return {
        rows: [{
          product_id: product.id,
          product_name: product.name,
          variant_id: variant.id,
          image_url: variant.image_url,
          source_type: "variant_image",
        }],
        rowCount: 1,
      };
    }
    const product = products.find(
      (item) => item.image_url === sourceImageUrl
        && item.owner_admin_id === Number(ownerAdminId)
        && (!productId || item.id === Number(productId))
    );
    if (product && !variantId) {
      return {
        rows: [{
          product_id: product.id,
          product_name: product.name,
          variant_id: null,
          image_url: product.image_url,
          source_type: "product_image",
        }],
        rowCount: 1,
      };
    }
    const asset = assets.find(
      (item) => item.owner_admin_id === Number(ownerAdminId)
        && item.status !== "deleted"
        && [item.original_asset_url, item.generated_asset_url].includes(sourceImageUrl)
        && (!productId || item.product_id === Number(productId))
        && (!variantId || item.variant_id === Number(variantId))
    );
    if (asset) {
      const assetProduct = products.find((item) => item.id === asset.product_id);
      return {
        rows: [{
          product_id: asset.product_id,
          product_name: assetProduct?.name || null,
          variant_id: asset.variant_id,
          image_url: sourceImageUrl,
          source_type: "campaign_asset",
        }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  }

  if (sql.includes("FROM product_variants pv")) {
    const variantId = Number(params[0]);
    const ownerAdminId = Number(params[1]);
    const productId = params[2] === null ? null : Number(params[2]);
    const variant = variants.find(
      (item) => item.id === variantId
        && item.owner_admin_id === ownerAdminId
        && (!productId || item.product_id === productId)
    );
    if (!variant) return { rows: [], rowCount: 0 };
    const product = products.find((item) => item.id === variant.product_id);
    return {
      rows: [{
        product_id: product.id,
        product_name: product.name,
        variant_id: variant.id,
        image_url: variant.image_url,
      }],
      rowCount: 1,
    };
  }

  if (sql.includes("FROM products p") && sql.includes("product_images")) {
    const productId = Number(params[0]);
    const owner = Number(params[1]);
    const product = products.find((item) => item.id === productId && item.owner_admin_id === owner);
    if (!product) return { rows: [], rowCount: 0 };
    return {
      rows: [{
        product_id: product.id,
        product_name: product.name,
        variant_id: null,
        image_url: product.image_url,
      }],
      rowCount: 1,
    };
  }

  if (sql.includes("FROM ai_jobs") && sql.includes("dedupe_key = $3") && sql.includes("status IN ('queued', 'running')")) {
    const existing = jobs.find(
      (job) => job.owner_admin_id === Number(params[0])
        && job.type === params[1]
        && job.dedupe_key === params[2]
        && ["queued", "running"].includes(job.status)
    );
    return { rows: existing ? [jobRow(existing)] : [], rowCount: existing ? 1 : 0 };
  }

  if (sql.includes("FROM ai_jobs") && sql.includes("status = 'completed'")) {
    const completed = jobs.find(
      (job) => job.owner_admin_id === Number(params[0])
        && job.type === params[1]
        && job.dedupe_key === params[2]
        && job.status === "completed"
    );
    return { rows: completed ? [jobRow(completed)] : [], rowCount: completed ? 1 : 0 };
  }

  if (sql.includes("COUNT(*)::int AS jobs_today")) {
    const count = jobs.filter((job) => job.owner_admin_id === Number(params[0])).length;
    return { rows: [{ jobs_today: count }], rowCount: 1 };
  }

  if (sql.includes("INSERT INTO ai_jobs")) {
    const row = jobRow({
      id: params[0],
      owner_admin_id: params[1],
      user_id: params[2],
      type: params[3],
      status: "queued",
      priority: params[4],
      input: JSON.parse(params[5]),
      output: {},
      max_attempts: params[6],
      dedupe_key: params[7],
      attempts: 0,
    });
    const duplicate = jobs.find(
      (job) => job.owner_admin_id === row.owner_admin_id
        && job.type === row.type
        && job.dedupe_key === row.dedupe_key
        && ["queued", "running"].includes(job.status)
    );
    if (duplicate) return { rows: [], rowCount: 0 };
    jobs.push(row);
    return { rows: [row], rowCount: 1 };
  }

  if (sql.includes("INSERT INTO campaign_assets")) {
    const row = assetRow({
      id: params[0],
      owner_admin_id: params[1],
      campaign_id: params[2],
      product_id: params[3],
      variant_id: params[4],
      source: params[5],
      status: "pending",
      original_asset_url: params[6],
      format: params[7],
      prompt: params[8],
      prompt_version: params[9],
      model: params[10],
      metadata: JSON.parse(params[11]),
      created_by: params[12],
    });
    assets.push(row);
    return { rows: [row], rowCount: 1 };
  }

  if (sql.includes("FROM campaign_assets") && sql.includes("id = $2") && sql.includes("LIMIT 1")) {
    const asset = assets.find((row) => row.owner_admin_id === Number(params[0]) && row.id === params[1]);
    return { rows: asset ? [assetRow(asset)] : [], rowCount: asset ? 1 : 0 };
  }

  if (sql.includes("FROM campaign_assets") && sql.includes("campaign_id = $2")) {
    const rows = assets.filter((row) => row.owner_admin_id === Number(params[0]) && row.campaign_id === params[1] && row.status !== "deleted");
    return { rows: rows.map(assetRow), rowCount: rows.length };
  }

  if (sql.includes("WITH next_job AS")) {
    const next = jobs.find((job) => job.status === "queued");
    if (!next) return { rows: [], rowCount: 0 };
    next.status = "running";
    next.attempts = (next.attempts || 0) + 1;
    next.locked_by = params[0];
    next.locked_at = now();
    next.started_at = next.started_at || now();
    return { rows: [jobRow(next)], rowCount: 1 };
  }

  if (sql.includes("SET status = 'processing'")) {
    const asset = assets.find((row) => row.owner_admin_id === Number(params[0]) && row.id === params[1]);
    if (asset) asset.status = "processing";
    return { rows: [], rowCount: asset ? 1 : 0 };
  }

  if (sql.includes("SET status = 'failed'")) {
    const asset = assets.find((row) => row.owner_admin_id === Number(params[0]) && row.id === params[1]);
    if (asset) {
      asset.status = "failed";
      asset.metadata = { ...asset.metadata, ...JSON.parse(params[2]) };
    }
    return { rows: [], rowCount: asset ? 1 : 0 };
  }

  if (sql.includes("UPDATE ai_jobs") && sql.includes("SET status = $1")) {
    const job = jobs.find((row) => row.id === params[4] && row.owner_admin_id === Number(params[5]));
    if (!job) return { rows: [], rowCount: 0 };
    job.status = params[0];
    job.error_code = params[2];
    job.error_message_redacted = params[3];
    if (job.status === "failed") job.completed_at = now();
    job.locked_by = null;
    job.locked_at = null;
    return { rows: [jobRow(job)], rowCount: 1 };
  }

  if (sql.includes("UPDATE campaign_assets") && sql.includes("status = 'deleted'")) {
    const asset = assets.find((row) => row.owner_admin_id === Number(params[0]) && row.id === params[1]);
    if (!asset) return { rows: [], rowCount: 0 };
    asset.status = "deleted";
    asset.generated_asset_url = null;
    return { rows: [assetRow(asset)], rowCount: 1 };
  }

  throw new Error(`Unexpected image test query: ${sql.slice(0, 140)}`);
}

const fakeDb = {
  query: handleQuery,
  async connect() {
    return {
      query: handleQuery,
      release() {},
    };
  },
};

const fakeProvider = {
  async moderateImageRequest() {
    if (providerMode === "flagged") return { status: "flagged", flagged: true, model: "moderation-test" };
    return { status: "approved", flagged: false, model: "moderation-test" };
  },
  async editImageFromCatalog() {
    if (providerMode === "external_error") {
      const err = new Error("raw provider secret details");
      err.code = "PROVIDER_DOWN";
      err.status = 502;
      throw err;
    }
    return { b64Json: Buffer.from("fake-image").toString("base64"), model: "gpt-image-test", usage: { total_tokens: 10 }, endpoint: "images/edits" };
  },
  async createImageFromPrompt() {
    return { b64Json: Buffer.from("fake-image").toString("base64"), model: "gpt-image-test", usage: { total_tokens: 10 }, endpoint: "images/generations" };
  },
  async uploadGeneratedImage({ assetId }) {
    return {
      secureUrl: `https://res.cloudinary.com/demo/image/upload/v1720000000/alesteb/campaigns/101/${campaignA}/aura-${assetId}.png`,
      publicId: `alesteb/campaigns/101/${campaignA}/aura-${assetId}`,
      width: 1024,
      height: 1024,
      format: "png",
      bytes: 1234,
    };
  },
  async destroyGeneratedImage(publicId) {
    destroyedPublicIds.push(publicId);
    return { result: "ok" };
  },
};

require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };
require.cache[providerPath] = { id: providerPath, filename: providerPath, loaded: true, exports: fakeProvider };

const imageJobs = require("../services/auraImageJobs.service");
const imageWorker = require("../services/auraImageWorker.service");

const ctxA = { ownerAdminId: 101, userId: 11, roles: ["admin"] };
const ctxB = { ownerAdminId: 202, userId: 22, roles: ["admin"] };

test.beforeEach(() => {
  calls.length = 0;
  jobs.length = 0;
  assets.length = 0;
  destroyedPublicIds.length = 0;
  providerMode = "success";
  process.env.AURA_IMAGE_MAX_JOBS_PER_DAY = "20";
});

async function enqueueBasic(ctx = ctxA, overrides = {}) {
  return imageJobs.enqueueImageJob({
    ...ctx,
    mode: "generate",
    payload: {
      campaignId: ctx.ownerAdminId === 101 ? campaignA : campaignB,
      productId: ctx.ownerAdminId === 101 ? 501 : 502,
      objective: "promocionar producto",
      format: "instagram_square",
      style: "premium futurista",
      instructions: "conservar exactamente el producto",
      ...overrides,
    },
  });
}

test("AURA image jobs enqueue quickly, tenant-scoped and without processing inline", async () => {
  const result = await enqueueBasic();

  assert.equal(result.deduped, false);
  assert.equal(result.job.status, "queued");
  assert.equal(result.asset.status, "pending");
  assert.equal(result.asset.ownerAdminId, 101);
  assert.equal(result.asset.originalAssetUrl.includes("res.cloudinary.com/demo"), true);
  assert.equal(calls.some((call) => call.sql.includes("WITH next_job AS")), false);
});

test("AURA image jobs reject catalog images from another tenant", async () => {
  await assert.rejects(
    () => enqueueBasic(ctxA, { productId: 502 }),
    /Imagen de producto no encontrada/
  );
  assert.equal(jobs.length, 0);
  assert.equal(assets.length, 0);
});

test("AURA image jobs reject campaigns from another tenant", async () => {
  await assert.rejects(
    () => enqueueBasic(ctxA, { campaignId: campaignB }),
    /Campana no encontrada/
  );
  assert.equal(jobs.length, 0);
  assert.equal(assets.length, 0);
});

test("AURA image jobs resolve tenant variants and keep quality provenance", async () => {
  const result = await enqueueBasic(ctxA, {
    productId: 501,
    variantId: 701,
    format: "4:5",
    quality: "medium",
    preserveProduct: true,
    channels: ["instagram"],
  });

  assert.equal(result.job.input.variantId, 701);
  assert.equal(result.job.input.format, "4:5");
  assert.equal(result.job.input.size, "1024x1280");
  assert.equal(result.job.input.requestedAspectRatio, "4:5");
  assert.equal(result.job.input.quality, "medium");
  assert.deepEqual(result.job.input.channels, ["instagram"]);
  assert.equal(result.asset.metadata.quality, "medium");
});

test("AURA image jobs accept only source URLs recorded for the same tenant", async () => {
  const ownSource = products.find((item) => item.id === 501).image_url;
  const result = await enqueueBasic(ctxA, {
    productId: null,
    sourceImageUrl: ownSource,
  });

  assert.equal(result.job.input.productId, 501);
  assert.equal(result.job.input.sourceImageUrl, ownSource);

  const crossTenantSource = products.find((item) => item.id === 502).image_url;
  await assert.rejects(
    () => enqueueBasic(ctxA, {
      productId: null,
      sourceImageUrl: crossTenantSource,
      objective: "intento cross tenant",
    }),
    /no pertenece al catalogo/
  );
  assert.equal(jobs.length, 1);
});

test("AURA image jobs reject arbitrary non-Cloudinary URLs even when stored on product", async () => {
  await assert.rejects(
    () => enqueueBasic(ctxA, { productId: 503 }),
    /Solo se permiten URLs verificadas de Cloudinary/
  );
  assert.equal(jobs.length, 0);
});

test("AURA image job dedupe keeps four deterministic slots without publishing", async () => {
  for (let variationIndex = 0; variationIndex < 4; variationIndex += 1) {
    await enqueueBasic(ctxA, {
      campaignId: campaignA,
      productId: 501,
      format: "1:1",
      variationIndex,
    });
  }

  assert.equal(jobs.length, 4);
  assert.equal(new Set(jobs.map((job) => job.dedupe_key)).size, 4);
  assert.equal(assets.length, 4);
  assert.equal(calls.some((call) => call.sql.includes("notification_queue")), false);
  assert.equal(calls.some((call) => call.sql.includes("campaign_recipients")), false);
});

test("AURA image jobs dedupe identical active requests", async () => {
  const first = await enqueueBasic();
  const second = await enqueueBasic();

  assert.equal(first.job.id, second.job.id);
  assert.equal(second.deduped, true);
  assert.equal(jobs.length, 1);
  assert.equal(assets.length, 1);
});

test("AURA image jobs do not let completed jobs block new generations", async () => {
  const dedupeKey = imageDedupeKey({
    ownerAdminId: 101,
    campaignId: campaignA,
    productId: 501,
    objective: "promocionar producto",
    format: "instagram_square",
    style: "premium futurista",
    instructions: "conservar exactamente el producto",
  });
  assets.push(assetRow({
    id: "asset-completed",
    owner_admin_id: 101,
    campaign_id: campaignA,
    product_id: 501,
    status: "ready",
    generated_asset_url: "https://res.cloudinary.com/demo/image/upload/v1720000000/alesteb/campaigns/101/asset-completed.png",
    cloudinary_public_id: `alesteb/campaigns/101/${campaignA}/asset-completed`,
  }));
  jobs.push(jobRow({
    id: "job-completed",
    owner_admin_id: 101,
    user_id: 11,
    type: "aura_image_generate",
    status: "completed",
    priority: 100,
    input: {
      assetId: "asset-completed",
      campaignId: campaignA,
      productId: 501,
      objective: "promocionar producto",
      format: "instagram_square",
      style: "premium futurista",
      instructions: "conservar exactamente el producto",
    },
    output: { assetId: "asset-completed" },
    dedupe_key: dedupeKey,
    attempts: 1,
    max_attempts: 3,
    completed_at: now(),
  }));

  const result = await enqueueBasic();

  assert.equal(result.deduped, false);
  assert.equal(result.created, true);
  assert.equal(result.job.id !== "job-completed", true);
  assert.equal(jobs.length, 2);
  assert.equal(assets.length, 2);
});

test("AURA image jobs can reuse a valid completed job only when cache is explicit", async () => {
  const dedupeKey = imageDedupeKey({
    ownerAdminId: 101,
    campaignId: campaignA,
    productId: 501,
    objective: "promocionar producto",
    format: "instagram_square",
    style: "premium futurista",
    instructions: "conservar exactamente el producto",
  });
  assets.push(assetRow({
    id: "asset-cache",
    owner_admin_id: 101,
    campaign_id: campaignA,
    product_id: 501,
    status: "ready",
    generated_asset_url: "https://res.cloudinary.com/demo/image/upload/v1720000000/alesteb/campaigns/101/asset-cache.png",
    cloudinary_public_id: `alesteb/campaigns/101/${campaignA}/asset-cache`,
  }));
  jobs.push(jobRow({
    id: "job-cache",
    owner_admin_id: 101,
    user_id: 11,
    type: "aura_image_generate",
    status: "completed",
    priority: 100,
    input: {
      assetId: "asset-cache",
      campaignId: campaignA,
      productId: 501,
      objective: "promocionar producto",
      format: "instagram_square",
      style: "premium futurista",
      instructions: "conservar exactamente el producto",
    },
    output: { assetId: "asset-cache" },
    dedupe_key: dedupeKey,
    attempts: 1,
    max_attempts: 3,
    completed_at: now(),
  }));

  const result = await imageJobs.enqueueImageJob({
    ...ctxA,
    mode: "generate",
    payload: {
      campaignId: campaignA,
      productId: 501,
      objective: "promocionar producto",
      format: "instagram_square",
      style: "premium futurista",
      instructions: "conservar exactamente el producto",
      cache: true,
    },
  });

  assert.equal(result.deduped, true);
  assert.equal(result.cached, true);
  assert.equal(result.created, false);
  assert.equal(result.job.id, "job-cache");
  assert.equal(jobs.length, 1);
  assert.equal(assets.length, 1);
});

test("AURA image jobs enforce persistent daily tenant limit", async () => {
  process.env.AURA_IMAGE_MAX_JOBS_PER_DAY = "1";
  await enqueueBasic();

  await assert.rejects(
    () => enqueueBasic(ctxA, { objective: "otra pieza" }),
    /Limite diario de imagenes/
  );
  assert.equal(jobs.length, 1);
});

test("AURA image worker claims with SKIP LOCKED pattern and retries external errors", async () => {
  providerMode = "external_error";
  const result = await enqueueBasic();

  const processed = await imageWorker.processOneImageJob("worker-test");

  assert.equal(processed.processed, true);
  assert.equal(processed.jobId, result.job.id);
  assert.equal(jobs[0].status, "queued");
  assert.equal(jobs[0].error_code, "PROVIDER_DOWN");
  assert.equal(jobs[0].error_message_redacted.includes("raw provider"), false);
  assert.equal(assets[0].status, "failed");
  assert.ok(calls.some((call) => call.sql.includes("FOR UPDATE SKIP LOCKED")));
});

test("AURA image worker does not let two workers process the same job", async () => {
  await enqueueBasic();

  const first = await imageJobs.claimNextImageJob({ workerId: "worker-a" });
  const second = await imageJobs.claimNextImageJob({ workerId: "worker-b" });

  assert.equal(first.status, "running");
  assert.equal(first.lockedBy, "worker-a");
  assert.equal(second, null);
});

test("AURA image asset deletion only destroys tenant-aware generated Cloudinary assets", async () => {
  assets.push(assetRow({
    id: "asset-safe",
    owner_admin_id: 101,
    campaign_id: campaignA,
    status: "ready",
    generated_asset_url: "https://res.cloudinary.com/demo/image/upload/v1720000000/alesteb/campaigns/101/asset.png",
    cloudinary_public_id: `alesteb/campaigns/101/${campaignA}/asset-safe`,
  }));
  assets.push(assetRow({
    id: "asset-unsafe",
    owner_admin_id: 101,
    campaign_id: campaignA,
    status: "ready",
    cloudinary_public_id: "alesteb/campaigns/202/other/asset-unsafe",
  }));

  const deleted = await imageJobs.deleteCampaignAsset({ ...ctxA, assetId: "asset-safe" });
  assert.equal(deleted.status, "deleted");
  assert.deepEqual(destroyedPublicIds, [`alesteb/campaigns/101/${campaignA}/asset-safe`]);

  await assert.rejects(
    () => imageJobs.deleteCampaignAsset({ ...ctxA, assetId: "asset-unsafe" }),
    /carpeta segura/
  );
});
