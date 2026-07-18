const crypto = require("crypto");
const db = require("../config/db");

const CAMPAIGN_CHANNELS = new Set(["email", "whatsapp", "push", "instagram", "tiktok"]);
const CONSENT_CHANNELS = new Set(["email", "whatsapp", "push"]);
const EXPORT_ONLY_CHANNELS = new Set(["instagram", "tiktok"]);
const CAMPAIGN_STATUSES = new Set([
  "draft",
  "pending_approval",
  "approved",
  "scheduled",
  "running",
  "paused",
  "completed",
  "cancelled",
  "failed",
]);
const DRAFT_EDITABLE_STATUSES = new Set(["draft", "pending_approval", "cancelled"]);
const SEGMENT_TYPES = new Set([
  "all_customers",
  "recent_buyers",
  "inactive_customers",
  "high_value",
  "product_viewers",
  "rfm_segment",
  "churn_level",
  "repurchase_level",
]);
const RFM_SEGMENTS = new Set([
  "campeones",
  "leales",
  "nuevos",
  "potencialmente_leales",
  "requieren_atencion",
  "en_riesgo",
  "dormidos",
]);
const CHURN_LEVELS = new Set(["bajo", "medio", "alto", "critico", "insuficiente"]);
const REPURCHASE_LEVELS = new Set(["baja", "media", "alta", "insuficiente"]);
const DELIVERY_READY_STATUSES = new Set(["approved", "scheduled"]);

const PAID_VALID_SALES_SQL = `
  s.payment_status = 'paid'
  AND LOWER(COALESCE(s.payment_status::text, '')) NOT IN ('cancelled', 'canceled', 'anulado', 'annulled', 'void')
  AND LOWER(COALESCE(s.status::text, '')) NOT IN ('cancelled', 'canceled', 'anulado', 'annulled', 'void')
  AND LOWER(COALESCE(s.delivery_status::text, '')) NOT IN ('cancelled', 'canceled')
`;

function createCampaignError(message, code = "AURA_CAMPAIGN_ERROR", status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function requireCtx(ctx) {
  if (!ctx?.ownerAdminId || !ctx?.userId) {
    throw createCampaignError("Contexto AURA incompleto", "AURA_CAMPAIGN_CONTEXT_REQUIRED", 500);
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

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value, field, { required = false, max = 160 } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw createCampaignError(`${field} es requerido`, "AURA_CAMPAIGN_INVALID_INPUT", 400);
    return null;
  }
  if (typeof value !== "string") {
    throw createCampaignError(`${field} debe ser texto`, "AURA_CAMPAIGN_INVALID_INPUT", 400);
  }
  const text = value.trim();
  if (!text && required) {
    throw createCampaignError(`${field} es requerido`, "AURA_CAMPAIGN_INVALID_INPUT", 400);
  }
  if (text.length > max) {
    throw createCampaignError(`${field} no puede superar ${max} caracteres`, "AURA_CAMPAIGN_INVALID_INPUT", 400);
  }
  return text || null;
}

function cleanChannel(value) {
  const channel = cleanText(value, "channel", { required: true, max: 30 });
  if (!CAMPAIGN_CHANNELS.has(channel)) {
    throw createCampaignError("channel invalido", "AURA_CAMPAIGN_INVALID_CHANNEL", 400);
  }
  return channel;
}

function cleanStatus(value, fallback = "draft") {
  if (value === undefined || value === null || value === "") return fallback;
  const status = cleanText(value, "status", { required: true, max: 30 });
  if (!CAMPAIGN_STATUSES.has(status)) {
    throw createCampaignError("status invalido", "AURA_CAMPAIGN_INVALID_STATUS", 400);
  }
  return status;
}

function cleanLimitedStatusForDraftUpdate(value) {
  const status = cleanStatus(value, undefined);
  if (!DRAFT_EDITABLE_STATUSES.has(status)) {
    throw createCampaignError(
      "En el MVP seguro solo se permite draft, pending_approval o cancelled",
      "AURA_CAMPAIGN_STATUS_NOT_ALLOWED",
      409
    );
  }
  return status;
}

function cleanCurrency(value) {
  const currency = cleanText(value || "COP", "currency", { required: true, max: 3 }).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw createCampaignError("currency debe ser ISO-4217 de 3 letras", "AURA_CAMPAIGN_INVALID_CURRENCY", 400);
  }
  return currency;
}

function cleanMoney(value, field) {
  if (value === undefined || value === null || value === "") return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw createCampaignError(`${field} debe ser un numero positivo`, "AURA_CAMPAIGN_INVALID_AMOUNT", 400);
  }
  return Math.round(amount * 100) / 100;
}

function cleanInteger(value, field, { fallback = null, min = 0, max = 10_000 } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw createCampaignError(`${field} debe ser un entero entre ${min} y ${max}`, "AURA_CAMPAIGN_INVALID_INTEGER", 400);
  }
  return parsed;
}

function cleanDate(value, field) {
  if (value === undefined || value === null || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw createCampaignError(`${field} debe ser una fecha valida`, "AURA_CAMPAIGN_INVALID_DATE", 400);
  }
  return date.toISOString();
}

function cleanJsonObject(value, field, fallback = {}) {
  if (value === undefined || value === null) return fallback;
  if (!isPlainObject(value)) {
    throw createCampaignError(`${field} debe ser un objeto`, "AURA_CAMPAIGN_INVALID_JSON", 400);
  }
  return value;
}

function cleanSegmentDefinition(value) {
  const definition = cleanJsonObject(value, "definition", { type: "all_customers" });
  const type = cleanText(definition.type || "all_customers", "definition.type", { required: true, max: 40 });
  if (!SEGMENT_TYPES.has(type)) {
    throw createCampaignError("definition.type no permitido", "AURA_CAMPAIGN_INVALID_SEGMENT", 400);
  }

  if (type === "all_customers") {
    return { type };
  }

  if (type === "recent_buyers") {
    return {
      type,
      days: cleanInteger(definition.days, "definition.days", { fallback: 30, min: 1, max: 365 }),
    };
  }

  if (type === "inactive_customers") {
    return {
      type,
      days: cleanInteger(definition.days, "definition.days", { fallback: 60, min: 1, max: 730 }),
    };
  }

  if (type === "high_value") {
    return {
      type,
      minSpent: cleanMoney(definition.minSpent ?? 500000, "definition.minSpent"),
      periodDays: cleanInteger(definition.periodDays, "definition.periodDays", { fallback: 365, min: 1, max: 730 }),
    };
  }

  if (type === "rfm_segment") {
    const segment = cleanText(definition.segment, "definition.segment", { required: true, max: 60 });
    if (!RFM_SEGMENTS.has(segment)) {
      throw createCampaignError("definition.segment no permitido", "AURA_CAMPAIGN_INVALID_SEGMENT", 400);
    }
    return { type, segment };
  }

  if (type === "churn_level") {
    const level = cleanText(definition.level, "definition.level", { required: true, max: 30 });
    if (!CHURN_LEVELS.has(level)) {
      throw createCampaignError("definition.level no permitido", "AURA_CAMPAIGN_INVALID_SEGMENT", 400);
    }
    return { type, level };
  }

  if (type === "repurchase_level") {
    const level = cleanText(definition.level, "definition.level", { required: true, max: 30 });
    if (!REPURCHASE_LEVELS.has(level)) {
      throw createCampaignError("definition.level no permitido", "AURA_CAMPAIGN_INVALID_SEGMENT", 400);
    }
    return { type, level };
  }

  return {
    type,
    productId: cleanInteger(definition.productId, "definition.productId", { min: 1, max: 2_147_483_647 }),
    days: cleanInteger(definition.days, "definition.days", { fallback: 30, min: 1, max: 365 }),
  };
}

function cleanContent(value, channel) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) {
    throw createCampaignError("content debe ser un objeto", "AURA_CAMPAIGN_INVALID_CONTENT", 400);
  }
  const body = cleanText(value.body, "content.body", { required: true, max: 5000 });
  return {
    channel,
    headline: cleanText(value.headline, "content.headline", { max: 180 }),
    body,
    callToAction: cleanText(value.callToAction, "content.callToAction", { max: 140 }),
    metadata: cleanJsonObject(value.metadata, "content.metadata", {}),
    promptVersion: cleanText(value.promptVersion, "content.promptVersion", { max: 40 }),
    model: cleanText(value.model, "content.model", { max: 100 }),
  };
}

function mapCampaignRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerAdminId: Number(row.owner_admin_id),
    name: row.name,
    objective: row.objective,
    channel: row.channel,
    status: row.status,
    segmentId: row.segment_id || null,
    discountId: row.discount_id || null,
    createdBy: row.created_by,
    approvedBy: row.approved_by || null,
    scheduledAt: row.scheduled_at || null,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    budget: row.budget === null || row.budget === undefined ? null : Number(row.budget),
    currency: row.currency,
    sourceType: row.source_type,
    aiGenerated: Boolean(row.ai_generated),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    segment: row.segment_id
      ? {
          id: row.segment_id,
          name: row.segment_name || null,
          definition: row.segment_definition || null,
          estimatedSize: Number(row.segment_estimated_size || 0),
        }
      : null,
  };
}

function mapContentRow(row) {
  return {
    id: Number(row.id),
    campaignId: row.campaign_id,
    channel: row.channel,
    version: Number(row.version),
    headline: row.headline || null,
    body: row.body,
    callToAction: row.call_to_action || null,
    metadata: row.metadata || {},
    promptVersion: row.prompt_version || null,
    model: row.model || null,
    createdBy: row.created_by || null,
    createdAt: row.created_at,
  };
}

function mapAttributionRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    campaignId: row.campaign_id,
    ownerAdminId: Number(row.owner_admin_id),
    recipientUserId: Number(row.recipient_user_id),
    saleId: Number(row.sale_id),
    paymentReference: row.payment_reference || null,
    attributionModel: row.attribution_model,
    attributedRevenue: Number(row.attributed_revenue || 0),
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

async function withTransaction(fn) {
  if (typeof db.connect !== "function") {
    return fn(db);
  }

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
      console.error("[AURA Growth] rollback failed:", rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

async function assertDiscountBelongsToTenant(client, discountId, ownerAdminId) {
  if (!discountId) return null;
  const parsed = cleanInteger(discountId, "discountId", { min: 1, max: 2_147_483_647 });
  const { rows } = await client.query(
    `SELECT id
     FROM discounts
     WHERE id = $1
       AND owner_admin_id = $2
     LIMIT 1`,
    [parsed, ownerAdminId]
  );
  if (!rows.length) {
    throw createCampaignError("Descuento no encontrado para este tenant", "AURA_CAMPAIGN_DISCOUNT_NOT_FOUND", 404);
  }
  return parsed;
}

async function insertSegment(client, ctx, payload = {}) {
  const definition = cleanSegmentDefinition(payload.definition || payload.segmentDefinition || { type: "all_customers" });
  const name = cleanText(payload.name || payload.segmentName || "Audiencia AURA", "segmentName", { required: true, max: 160 });
  const segmentId = uuid();
  const { rows } = await client.query(
    `INSERT INTO marketing_segments
       (id, owner_admin_id, name, definition, estimated_size, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [segmentId, ctx.ownerAdminId, name, JSON.stringify(definition), 0, ctx.userId]
  );
  return rows[0];
}

async function insertContent(client, campaignId, ctx, content) {
  if (!content) return null;
  const { rows: versionRows } = await client.query(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
     FROM campaign_contents
     WHERE campaign_id = $1
       AND channel = $2`,
    [campaignId, content.channel]
  );
  const version = Number(versionRows[0]?.next_version || 1);
  const { rows } = await client.query(
    `INSERT INTO campaign_contents
       (campaign_id, channel, version, headline, body, call_to_action, metadata, prompt_version, model, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      campaignId,
      content.channel,
      version,
      content.headline,
      content.body,
      content.callToAction,
      JSON.stringify(content.metadata || {}),
      content.promptVersion,
      content.model,
      ctx.userId,
    ]
  );
  return rows[0];
}

async function getCampaignWithContents(client, ownerAdminId, campaignId) {
  const { rows } = await client.query(
    `SELECT
       mc.*,
       ms.name AS segment_name,
       ms.definition AS segment_definition,
       ms.estimated_size AS segment_estimated_size
     FROM marketing_campaigns mc
     LEFT JOIN marketing_segments ms
       ON ms.id = mc.segment_id
      AND ms.owner_admin_id = mc.owner_admin_id
     WHERE mc.owner_admin_id = $1
       AND mc.id = $2
     LIMIT 1`,
    [ownerAdminId, campaignId]
  );
  if (!rows.length) return null;

  const { rows: contentRows } = await client.query(
    `SELECT *
     FROM campaign_contents
     WHERE campaign_id = $1
     ORDER BY channel ASC, version DESC, created_at DESC`,
    [campaignId]
  );

  return {
    ...mapCampaignRow(rows[0]),
    contents: contentRows.map(mapContentRow),
    safety: {
      sendEnabled: false,
      automaticActionsEnabled: false,
      exportOnly: EXPORT_ONLY_CHANNELS.has(rows[0].channel),
    },
  };
}

async function createCampaignDraft(input) {
  const ctx = requireCtx(input);
  const payload = input.payload || {};
  const channel = cleanChannel(payload.channel);
  const status = cleanStatus(payload.status || "draft");
  if (!DRAFT_EDITABLE_STATUSES.has(status)) {
    throw createCampaignError("El endpoint de draft no permite estados ejecutables", "AURA_CAMPAIGN_STATUS_NOT_ALLOWED", 409);
  }

  const name = cleanText(payload.name, "name", { required: true, max: 160 });
  const objective = cleanText(payload.objective, "objective", { required: true, max: 120 });
  const content = cleanContent(payload.content, channel);

  return withTransaction(async (client) => {
    const discountId = await assertDiscountBelongsToTenant(client, payload.discountId, ctx.ownerAdminId);
    const segment = payload.segmentDefinition || payload.segmentName || payload.segment
      ? await insertSegment(client, ctx, {
          name: payload.segmentName,
          definition: payload.segmentDefinition || payload.segment?.definition,
        })
      : null;

    const campaignId = uuid();
    await client.query(
      `INSERT INTO marketing_campaigns
         (id, owner_admin_id, name, objective, channel, status, segment_id, discount_id,
          created_by, scheduled_at, budget, currency, source_type, ai_generated)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        campaignId,
        ctx.ownerAdminId,
        name,
        objective,
        channel,
        status,
        segment?.id || null,
        discountId,
        ctx.userId,
        cleanDate(payload.scheduledAt, "scheduledAt"),
        cleanMoney(payload.budget, "budget"),
        cleanCurrency(payload.currency),
        cleanText(payload.sourceType || "aura_growth", "sourceType", { required: true, max: 40 }),
        payload.aiGenerated === undefined ? true : Boolean(payload.aiGenerated),
      ]
    );

    await insertContent(client, campaignId, ctx, content);
    return getCampaignWithContents(client, ctx.ownerAdminId, campaignId);
  });
}

async function listCampaigns(input) {
  const ctx = requireCtx(input);
  const query = input.query || {};
  const limit = cleanInteger(query.limit, "limit", { fallback: 50, min: 1, max: 100 });
  const offset = cleanInteger(query.offset, "offset", { fallback: 0, min: 0, max: 10_000 });
  const filters = ["mc.owner_admin_id = $1"];
  const params = [ctx.ownerAdminId];

  if (query.status) {
    filters.push(`mc.status = $${params.length + 1}`);
    params.push(cleanStatus(query.status));
  }
  if (query.channel) {
    filters.push(`mc.channel = $${params.length + 1}`);
    params.push(cleanChannel(query.channel));
  }

  params.push(limit, offset);
  const { rows } = await db.query(
    `SELECT
       mc.*,
       ms.name AS segment_name,
       ms.definition AS segment_definition,
       ms.estimated_size AS segment_estimated_size
     FROM marketing_campaigns mc
     LEFT JOIN marketing_segments ms
       ON ms.id = mc.segment_id
      AND ms.owner_admin_id = mc.owner_admin_id
     WHERE ${filters.join(" AND ")}
     ORDER BY mc.created_at DESC
     LIMIT $${params.length - 1}
     OFFSET $${params.length}`,
    params
  );

  return {
    rows: rows.map(mapCampaignRow),
    pagination: { limit, offset, count: rows.length },
  };
}

async function getCampaign(input) {
  const ctx = requireCtx(input);
  const campaign = await getCampaignWithContents(db, ctx.ownerAdminId, input.campaignId);
  if (!campaign) {
    throw createCampaignError("Campana no encontrada", "AURA_CAMPAIGN_NOT_FOUND", 404);
  }
  return campaign;
}

async function updateCampaign(input) {
  const ctx = requireCtx(input);
  const payload = input.payload || {};
  const campaignId = input.campaignId;

  return withTransaction(async (client) => {
    const current = await getCampaignWithContents(client, ctx.ownerAdminId, campaignId);
    if (!current) {
      throw createCampaignError("Campana no encontrada", "AURA_CAMPAIGN_NOT_FOUND", 404);
    }
    if (!DRAFT_EDITABLE_STATUSES.has(current.status)) {
      throw createCampaignError("Solo campanas en borrador pueden editarse en el MVP", "AURA_CAMPAIGN_LOCKED", 409);
    }

    const updates = [];
    const params = [];
    function set(column, value) {
      params.push(value);
      updates.push(`${column} = $${params.length}`);
    }

    if (payload.name !== undefined) set("name", cleanText(payload.name, "name", { required: true, max: 160 }));
    if (payload.objective !== undefined) set("objective", cleanText(payload.objective, "objective", { required: true, max: 120 }));
    if (payload.status !== undefined) set("status", cleanLimitedStatusForDraftUpdate(payload.status));
    if (payload.scheduledAt !== undefined) set("scheduled_at", cleanDate(payload.scheduledAt, "scheduledAt"));
    if (payload.budget !== undefined) set("budget", cleanMoney(payload.budget, "budget"));
    if (payload.currency !== undefined) set("currency", cleanCurrency(payload.currency));
    if (payload.discountId !== undefined) {
      set("discount_id", await assertDiscountBelongsToTenant(client, payload.discountId, ctx.ownerAdminId));
    }
    if (payload.segmentDefinition !== undefined || payload.segmentName !== undefined) {
      const segment = await insertSegment(client, ctx, {
        name: payload.segmentName,
        definition: payload.segmentDefinition,
      });
      set("segment_id", segment.id);
    }

    if (updates.length) {
      params.push(ctx.ownerAdminId, campaignId);
      await client.query(
        `UPDATE marketing_campaigns
         SET ${updates.join(", ")}
         WHERE owner_admin_id = $${params.length - 1}
           AND id = $${params.length}`,
        params
      );
    }

    if (payload.content !== undefined) {
      await insertContent(client, campaignId, ctx, cleanContent(payload.content, current.channel));
    }

    return getCampaignWithContents(client, ctx.ownerAdminId, campaignId);
  });
}

async function deleteCampaign(input) {
  const ctx = requireCtx(input);
  const campaignId = input.campaignId;

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT status
       FROM marketing_campaigns
       WHERE owner_admin_id = $1
         AND id = $2
       LIMIT 1`,
      [ctx.ownerAdminId, campaignId]
    );
    if (!rows.length) {
      throw createCampaignError("Campana no encontrada", "AURA_CAMPAIGN_NOT_FOUND", 404);
    }
    if (!DRAFT_EDITABLE_STATUSES.has(rows[0].status)) {
      throw createCampaignError("Solo campanas no ejecutadas pueden eliminarse en el MVP", "AURA_CAMPAIGN_DELETE_LOCKED", 409);
    }
    await client.query(
      `DELETE FROM marketing_campaigns
       WHERE owner_admin_id = $1
         AND id = $2`,
      [ctx.ownerAdminId, campaignId]
    );
    return true;
  });
}

function buildSegmentPredicate(definition, params) {
  const def = cleanSegmentDefinition(definition || { type: "all_customers" });
  if (def.type === "all_customers") return { definition: def, sql: "" };

  if (def.type === "recent_buyers") {
    params.push(def.days);
    const idx = params.length;
    return {
      definition: def,
      sql: `AND EXISTS (
        SELECT 1
        FROM sales s
        WHERE s.owner_admin_id = $1
          AND s.customer_id = u.id
          AND s.sale_date >= CURRENT_DATE - ($${idx}::int * INTERVAL '1 day')
          AND ${PAID_VALID_SALES_SQL}
      )`,
    };
  }

  if (def.type === "inactive_customers") {
    params.push(def.days);
    const idx = params.length;
    return {
      definition: def,
      sql: `AND EXISTS (
          SELECT 1
          FROM sales s
          WHERE s.owner_admin_id = $1
            AND s.customer_id = u.id
            AND ${PAID_VALID_SALES_SQL}
        )
        AND NOT EXISTS (
          SELECT 1
          FROM sales s
          WHERE s.owner_admin_id = $1
            AND s.customer_id = u.id
            AND s.sale_date >= CURRENT_DATE - ($${idx}::int * INTERVAL '1 day')
            AND ${PAID_VALID_SALES_SQL}
        )`,
    };
  }

  if (def.type === "high_value") {
    params.push(def.minSpent, def.periodDays);
    const minIdx = params.length - 1;
    const daysIdx = params.length;
    return {
      definition: def,
      sql: `AND COALESCE((
        SELECT SUM(s.total)
        FROM sales s
        WHERE s.owner_admin_id = $1
          AND s.customer_id = u.id
          AND s.sale_date >= CURRENT_DATE - ($${daysIdx}::int * INTERVAL '1 day')
          AND ${PAID_VALID_SALES_SQL}
      ), 0) >= $${minIdx}`,
    };
  }

  if (def.type === "rfm_segment") {
    params.push(def.segment);
    const idx = params.length;
    return {
      definition: def,
      sql: `AND EXISTS (
        SELECT 1
        FROM aura_customer_segment_snapshots acss
        JOIN aura_customer_segment_runs acsr
          ON acsr.id = acss.run_id
         AND acsr.owner_admin_id = acss.owner_admin_id
        WHERE acss.owner_admin_id = $1
          AND acss.customer_id = u.id
          AND acss.segment_key = $${idx}
          AND acsr.status = 'completed'
          AND acsr.id = (
            SELECT latest.id
            FROM aura_customer_segment_runs latest
            WHERE latest.owner_admin_id = $1
              AND latest.status = 'completed'
            ORDER BY latest.as_of_date DESC, latest.completed_at DESC, latest.created_at DESC
            LIMIT 1
          )
      )`,
    };
  }

  if (def.type === "churn_level") {
    params.push(def.level);
    const idx = params.length;
    return {
      definition: def,
      sql: `AND EXISTS (
        SELECT 1
        FROM aura_customer_segment_snapshots acss
        JOIN aura_customer_segment_runs acsr
          ON acsr.id = acss.run_id
         AND acsr.owner_admin_id = acss.owner_admin_id
        WHERE acss.owner_admin_id = $1
          AND acss.customer_id = u.id
          AND acss.churn_level = $${idx}
          AND acsr.status = 'completed'
          AND acsr.id = (
            SELECT latest.id
            FROM aura_customer_segment_runs latest
            WHERE latest.owner_admin_id = $1
              AND latest.status = 'completed'
            ORDER BY latest.as_of_date DESC, latest.completed_at DESC, latest.created_at DESC
            LIMIT 1
          )
      )`,
    };
  }

  if (def.type === "repurchase_level") {
    params.push(def.level);
    const idx = params.length;
    return {
      definition: def,
      sql: `AND EXISTS (
        SELECT 1
        FROM aura_customer_segment_snapshots acss
        JOIN aura_customer_segment_runs acsr
          ON acsr.id = acss.run_id
         AND acsr.owner_admin_id = acss.owner_admin_id
        WHERE acss.owner_admin_id = $1
          AND acss.customer_id = u.id
          AND acss.repurchase_level = $${idx}
          AND acsr.status = 'completed'
          AND acsr.id = (
            SELECT latest.id
            FROM aura_customer_segment_runs latest
            WHERE latest.owner_admin_id = $1
              AND latest.status = 'completed'
            ORDER BY latest.as_of_date DESC, latest.completed_at DESC, latest.created_at DESC
            LIMIT 1
          )
      )`,
    };
  }

  return {
    definition: def,
    sql: "AND FALSE /* product_viewers deshabilitado: AURA Growth no usa page_views en esta fase */",
  };
}

function campaignRecipientLimit() {
  const configured = Number(process.env.AURA_CAMPAIGN_MAX_RECIPIENTS || 5000);
  if (!Number.isInteger(configured) || configured < 1) return 5000;
  return Math.min(configured, 50_000);
}

function contactPredicate(channel, alias = "c") {
  if (channel === "email") return `NULLIF(BTRIM(${alias}.email), '') IS NOT NULL`;
  if (channel === "whatsapp") return `NULLIF(BTRIM(${alias}.phone), '') IS NOT NULL`;
  if (channel === "push") {
    return `EXISTS (
      SELECT 1
      FROM push_subscriptions ps
      WHERE ps.user_id = ${alias}.id
        AND COALESCE(ps.is_active, true) = true
    )`;
  }
  return "FALSE";
}

async function prepareCampaignRecipients(input) {
  const ctx = requireCtx(input);
  const client = input.client || db;
  const campaign = await getCampaignWithContents(client, ctx.ownerAdminId, input.campaignId);
  if (!campaign) {
    throw createCampaignError("Campana no encontrada", "AURA_CAMPAIGN_NOT_FOUND", 404);
  }
  if (EXPORT_ONLY_CHANNELS.has(campaign.channel)) {
    throw createCampaignError(
      "Instagram y TikTok solo generan contenido exportable",
      "AURA_CAMPAIGN_EXPORT_ONLY",
      409
    );
  }
  if (!DELIVERY_READY_STATUSES.has(campaign.status)) {
    throw createCampaignError(
      "La campana requiere aprobacion humana antes de preparar destinatarios",
      "AURA_CAMPAIGN_APPROVAL_REQUIRED",
      409
    );
  }

  const params = [ctx.ownerAdminId, campaign.channel];
  const { definition, sql: segmentSql } = buildSegmentPredicate(
    campaign.segment?.definition || { type: "all_customers" },
    params
  );
  params.push(campaign.id, campaignRecipientLimit());
  const campaignIdx = params.length - 1;
  const limitIdx = params.length;
  const hasContactSql = contactPredicate(campaign.channel, "c");

  const { rows } = await client.query(
    `WITH reset_previous AS (
       UPDATE campaign_recipients
       SET status = 'skipped',
           updated_at = NOW()
       WHERE owner_admin_id = $1
         AND campaign_id = $${campaignIdx}
         AND channel = $2
         AND status IN (
           'draft', 'eligible', 'ready', 'excluded_no_consent',
           'excluded_opt_out', 'excluded_missing_contact'
         )
     ),
     candidates AS (
       SELECT u.id, u.email, u.phone
       FROM users u
       WHERE u.owner_admin_id = $1
         AND COALESCE(u.is_active, true) = true
         AND EXISTS (
           SELECT 1
           FROM user_roles ur
           JOIN roles r ON r.id = ur.role_id
           WHERE ur.user_id = u.id
             AND r.name = 'user'
         )
         ${segmentSql}
       ORDER BY u.id
       LIMIT $${limitIdx}
     ),
     evaluated AS (
       SELECT
         c.id,
         consent.status AS consent_status,
         consent.source AS consent_source,
         consent.granted_at,
         consent.revoked_at,
         ${hasContactSql} AS has_contact
       FROM candidates c
       LEFT JOIN customer_consents consent
         ON consent.owner_admin_id = $1
        AND consent.user_id = c.id
        AND consent.channel = $2
     ),
     prepared AS (
       INSERT INTO campaign_recipients
         (campaign_id, owner_admin_id, recipient_user_id, channel, consent_snapshot,
          status, dedupe_key, created_at, updated_at)
       SELECT
         $${campaignIdx},
         $1,
         e.id,
         $2,
         jsonb_build_object(
           'status', COALESCE(e.consent_status, 'unknown'),
           'source', e.consent_source,
           'grantedAt', e.granted_at,
           'revokedAt', e.revoked_at,
           'capturedAt', NOW()
         ),
         CASE
           WHEN e.consent_status = 'revoked' THEN 'excluded_opt_out'
           WHEN e.consent_status IS NULL OR e.consent_status = 'unknown' THEN 'excluded_no_consent'
           WHEN e.consent_status = 'granted' AND NOT e.has_contact THEN 'excluded_missing_contact'
           WHEN e.consent_status = 'granted' AND e.has_contact THEN 'ready'
           ELSE 'excluded_no_consent'
         END,
         CONCAT('campaign:', $${campaignIdx}::text, ':', $2, ':', e.id::text),
         NOW(),
         NOW()
       FROM evaluated e
       ON CONFLICT (campaign_id, recipient_user_id, channel)
       DO UPDATE SET
         consent_snapshot = EXCLUDED.consent_snapshot,
         status = CASE
           WHEN campaign_recipients.status IN ('sent', 'failed')
             THEN campaign_recipients.status
           ELSE EXCLUDED.status
         END,
         updated_at = NOW()
       RETURNING status
     )
     SELECT
       COUNT(*)::int AS prepared,
       COUNT(*) FILTER (WHERE status = 'ready')::int AS ready,
       COUNT(*) FILTER (WHERE status = 'excluded_no_consent')::int AS missing_consent,
       COUNT(*) FILTER (WHERE status = 'excluded_opt_out')::int AS opt_out,
       COUNT(*) FILTER (WHERE status = 'excluded_missing_contact')::int AS missing_contact
     FROM prepared`,
    params
  );

  const row = rows[0] || {};
  return {
    campaignId: campaign.id,
    channel: campaign.channel,
    definition,
    limit: campaignRecipientLimit(),
    totals: {
      prepared: Number(row.prepared || 0),
      ready: Number(row.ready || 0),
      missingConsent: Number(row.missing_consent || 0),
      optOut: Number(row.opt_out || 0),
      missingContact: Number(row.missing_contact || 0),
    },
  };
}

async function estimateCampaignAudience(input) {
  const ctx = requireCtx(input);
  const campaign = await getCampaignWithContents(db, ctx.ownerAdminId, input.campaignId);
  if (!campaign) {
    throw createCampaignError("Campana no encontrada", "AURA_CAMPAIGN_NOT_FOUND", 404);
  }

  if (EXPORT_ONLY_CHANNELS.has(campaign.channel)) {
    return {
      campaignId: campaign.id,
      channel: campaign.channel,
      exportOnly: true,
      sendReady: false,
      definition: input.definition ? cleanSegmentDefinition(input.definition) : campaign.segment?.definition || { type: "all_customers" },
      totals: {
        candidates: 0,
        eligible: 0,
        missingConsent: 0,
        optOut: 0,
        missingContact: 0,
      },
      note: "Instagram y TikTok quedan como contenido exportable; AURA no prepara envios automaticos.",
    };
  }

  if (!CONSENT_CHANNELS.has(campaign.channel)) {
    throw createCampaignError("Canal no soportado para consentimiento", "AURA_CAMPAIGN_INVALID_CHANNEL", 400);
  }

  const params = [ctx.ownerAdminId, campaign.channel];
  const { definition, sql: segmentSql } = buildSegmentPredicate(
    input.definition || campaign.segment?.definition || { type: "all_customers" },
    params
  );

  const contactSql = contactPredicate(campaign.channel, "c");

  const { rows } = await db.query(
    `WITH candidates AS (
       SELECT u.id, u.email, u.phone
       FROM users u
       WHERE u.owner_admin_id = $1
         AND COALESCE(u.is_active, true) = true
         AND EXISTS (
           SELECT 1
           FROM user_roles ur
           JOIN roles r ON r.id = ur.role_id
           WHERE ur.user_id = u.id
             AND r.name = 'user'
         )
         ${segmentSql}
     ),
     evaluated AS (
       SELECT
         c.id,
         cc.status AS consent_status,
         ${contactSql} AS has_contact
       FROM candidates c
       LEFT JOIN customer_consents cc
         ON cc.owner_admin_id = $1
        AND cc.user_id = c.id
        AND cc.channel = $2
     )
     SELECT
       COUNT(*)::int AS candidates,
       COUNT(*) FILTER (WHERE consent_status = 'granted' AND has_contact)::int AS eligible,
       COUNT(*) FILTER (WHERE consent_status = 'revoked')::int AS opt_out,
       COUNT(*) FILTER (WHERE consent_status IS NULL OR consent_status = 'unknown')::int AS missing_consent,
       COUNT(*) FILTER (WHERE consent_status = 'granted' AND NOT has_contact)::int AS missing_contact
     FROM evaluated`,
    params
  );

  const row = rows[0] || {};
  return {
    campaignId: campaign.id,
    channel: campaign.channel,
    exportOnly: false,
    sendReady: false,
    definition,
    totals: {
      candidates: Number(row.candidates || 0),
      eligible: Number(row.eligible || 0),
      missingConsent: Number(row.missing_consent || 0),
      optOut: Number(row.opt_out || 0),
      missingContact: Number(row.missing_contact || 0),
    },
    note: "Estimacion read-only. No se crean destinatarios ni se encola ningun envio.",
  };
}

async function previewCampaignDelivery(input) {
  const ctx = requireCtx(input);
  const campaign = await getCampaignWithContents(db, ctx.ownerAdminId, input.campaignId);
  if (!campaign) {
    throw createCampaignError("Campana no encontrada", "AURA_CAMPAIGN_NOT_FOUND", 404);
  }

  const estimate = await estimateCampaignAudience({
    ...ctx,
    campaignId: campaign.id,
  });
  const { rows } = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE cr.status = 'ready')::int AS prepared_ready,
       COUNT(*) FILTER (WHERE cr.status LIKE 'excluded_%')::int AS prepared_excluded,
       COUNT(DISTINCT nq.id) FILTER (WHERE nq.status IN ('pending', 'sending'))::int AS queued_active,
       COUNT(DISTINCT nq.id) FILTER (WHERE nq.status = 'sent')::int AS sent,
       COUNT(DISTINCT nq.id) FILTER (WHERE nq.status = 'failed')::int AS failed
     FROM marketing_campaigns mc
     LEFT JOIN campaign_recipients cr
       ON cr.owner_admin_id = mc.owner_admin_id
      AND cr.campaign_id = mc.id
     LEFT JOIN notification_queue nq
       ON nq.owner_admin_id = mc.owner_admin_id
      AND nq.campaign_id = mc.id
      AND nq.recipient_user_id = cr.recipient_user_id
     WHERE mc.owner_admin_id = $1
       AND mc.id = $2`,
    [ctx.ownerAdminId, campaign.id]
  );
  const row = rows[0] || {};
  const blockers = [];
  if (!DELIVERY_READY_STATUSES.has(campaign.status)) blockers.push("approval_required");
  if (estimate.exportOnly) blockers.push("export_only_channel");
  if (!estimate.exportOnly && estimate.totals.eligible === 0) blockers.push("no_eligible_recipients");
  if (!campaign.contents?.some((content) => content.channel === campaign.channel && content.body)) {
    blockers.push("content_required");
  }

  return {
    dryRun: true,
    campaignId: campaign.id,
    status: campaign.status,
    channel: campaign.channel,
    approved: DELIVERY_READY_STATUSES.has(campaign.status),
    canEnqueue: blockers.length === 0,
    blockers,
    audience: estimate.totals,
    prepared: {
      ready: Number(row.prepared_ready || 0),
      excluded: Number(row.prepared_excluded || 0),
    },
    queue: {
      active: Number(row.queued_active || 0),
      sent: Number(row.sent || 0),
      failed: Number(row.failed || 0),
    },
    note: "Preview read-only. No prepara destinatarios, no encola y no envia notificaciones.",
  };
}

async function recordPaidSaleAttribution(input) {
  const ctx = requireCtx(input);
  const saleId = cleanInteger(input.saleId, "saleId", { min: 1, max: 2_147_483_647 });
  const recipientUserId = cleanInteger(input.recipientUserId, "recipientUserId", { min: 1, max: 2_147_483_647 });
  const attributionModel = cleanText(input.attributionModel || "last_touch", "attributionModel", { required: true, max: 40 });
  const paymentReference = cleanText(input.paymentReference, "paymentReference", { max: 180 });

  const { rows } = await db.query(
    `INSERT INTO campaign_attributions
       (campaign_id, owner_admin_id, recipient_user_id, sale_id, payment_reference, attribution_model, attributed_revenue, occurred_at)
     SELECT
       mc.id,
       $2,
       s.customer_id,
       s.id,
       $5,
       $6,
       COALESCE(s.total, 0),
       NOW()
     FROM marketing_campaigns mc
     JOIN sales s
       ON s.id = $3
      AND s.owner_admin_id = $2
      AND s.customer_id = $4
      AND ${PAID_VALID_SALES_SQL}
     WHERE mc.id = $1
       AND mc.owner_admin_id = $2
     ON CONFLICT (campaign_id, sale_id, attribution_model)
     DO NOTHING
     RETURNING *`,
    [input.campaignId, ctx.ownerAdminId, saleId, recipientUserId, paymentReference, attributionModel]
  );

  return rows.length ? mapAttributionRow(rows[0]) : null;
}

module.exports = {
  CAMPAIGN_CHANNELS,
  CONSENT_CHANNELS,
  EXPORT_ONLY_CHANNELS,
  createCampaignError,
  cleanSegmentDefinition,
  createCampaignDraft,
  listCampaigns,
  getCampaign,
  updateCampaign,
  deleteCampaign,
  estimateCampaignAudience,
  prepareCampaignRecipients,
  previewCampaignDelivery,
  recordPaidSaleAttribution,
};
