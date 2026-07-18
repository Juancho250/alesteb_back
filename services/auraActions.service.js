const crypto = require("crypto");
const db = require("../config/db");
const { enqueueCampaignDelivery } = require("./notificationOutbox.service");

const ACTION_PERMISSIONS = {
  approve_campaign: "campaign:approve",
  schedule_campaign: "campaign:schedule",
  pause_campaign: "campaign:pause",
  create_discount_draft: "discount:create",
  approve_discount: "discount:approve",
  enqueue_campaign_delivery: "campaign:deliver",
};

const ADMIN_ONLY_PERMISSIONS = new Set(["discount:create", "discount:approve"]);

function createActionError(message, code = "AURA_ACTION_ERROR", status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function requireCtx(ctx) {
  if (!ctx?.ownerAdminId || !ctx?.userId) {
    throw createActionError("Contexto AURA incompleto", "AURA_ACTION_CONTEXT_REQUIRED", 500);
  }
  return {
    ownerAdminId: Number(ctx.ownerAdminId),
    userId: Number(ctx.userId),
    roles: Array.isArray(ctx.roles) ? ctx.roles : [],
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = canonicalize(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function hashPayload(payload) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(payload || {})))
    .digest("hex");
}

function uuid() {
  return crypto.randomUUID();
}

function cleanText(value, field, { required = false, max = 200 } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw createActionError(`${field} es requerido`, "AURA_ACTION_INVALID_INPUT", 400);
    return null;
  }
  if (typeof value !== "string") {
    throw createActionError(`${field} debe ser texto`, "AURA_ACTION_INVALID_INPUT", 400);
  }
  const text = value.trim();
  if (!text && required) throw createActionError(`${field} es requerido`, "AURA_ACTION_INVALID_INPUT", 400);
  if (text.length > max) {
    throw createActionError(`${field} no puede superar ${max} caracteres`, "AURA_ACTION_INVALID_INPUT", 400);
  }
  return text || null;
}

function cleanUuid(value, field, required = true) {
  const text = cleanText(value, field, { required, max: 80 });
  if (!text) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw createActionError(`${field} invalido`, "AURA_ACTION_INVALID_UUID", 400);
  }
  return text;
}

function cleanInteger(value, field, required = true) {
  if (value === undefined || value === null || value === "") {
    if (required) throw createActionError(`${field} es requerido`, "AURA_ACTION_INVALID_INPUT", 400);
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw createActionError(`${field} debe ser entero positivo`, "AURA_ACTION_INVALID_INPUT", 400);
  }
  return parsed;
}

function cleanMoney(value, field, required = true) {
  if (value === undefined || value === null || value === "") {
    if (required) throw createActionError(`${field} es requerido`, "AURA_ACTION_INVALID_INPUT", 400);
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw createActionError(`${field} debe ser numero positivo`, "AURA_ACTION_INVALID_INPUT", 400);
  }
  return Math.round(parsed * 100) / 100;
}

function cleanDate(value, field, required = true) {
  const text = cleanText(value, field, { required, max: 80 });
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw createActionError(`${field} debe ser fecha valida`, "AURA_ACTION_INVALID_DATE", 400);
  }
  return date.toISOString();
}

function validateActionPayload(actionType, payload = {}) {
  if (!ACTION_PERMISSIONS[actionType]) {
    throw createActionError("action_type no permitido", "AURA_ACTION_TYPE_NOT_ALLOWED", 400);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw createActionError("payload debe ser objeto", "AURA_ACTION_INVALID_PAYLOAD", 400);
  }

  if (actionType === "approve_campaign") {
    return { campaignId: cleanUuid(payload.campaignId, "campaignId") };
  }
  if (actionType === "schedule_campaign") {
    return {
      campaignId: cleanUuid(payload.campaignId, "campaignId"),
      scheduledAt: cleanDate(payload.scheduledAt, "scheduledAt"),
    };
  }
  if (actionType === "pause_campaign") {
    return { campaignId: cleanUuid(payload.campaignId, "campaignId") };
  }
  if (actionType === "create_discount_draft") {
    return {
      name: cleanText(payload.name, "name", { required: true, max: 160 }),
      type: cleanText(payload.type, "type", { required: true, max: 30 }),
      value: cleanMoney(payload.value, "value"),
      startsAt: cleanDate(payload.startsAt || payload.starts_at, "startsAt"),
      endsAt: cleanDate(payload.endsAt || payload.ends_at, "endsAt"),
      code: cleanText(payload.code, "code", { max: 80 }),
      description: cleanText(payload.description, "description", { max: 500 }),
      scope: cleanText(payload.scope || "all", "scope", { required: true, max: 20 }),
      targets: Array.isArray(payload.targets) ? payload.targets.slice(0, 50).map((target) => ({
        target_type: cleanText(target.target_type, "target_type", { required: true, max: 40 }),
        target_id: cleanInteger(target.target_id, "target_id"),
      })) : [],
    };
  }
  if (actionType === "approve_discount") {
    return { discountId: cleanInteger(payload.discountId || payload.discount_id, "discountId") };
  }
  return {
    campaignId: cleanUuid(payload.campaignId, "campaignId"),
    whatsappTemplateName: cleanText(payload.whatsappTemplateName, "whatsappTemplateName", { max: 120 }),
    whatsappLanguageCode: cleanText(payload.whatsappLanguageCode || "es_CO", "whatsappLanguageCode", { max: 20 }),
    whatsappTemplateComponents: Array.isArray(payload.whatsappTemplateComponents)
      ? payload.whatsappTemplateComponents.slice(0, 20)
      : [],
    availableAt: payload.availableAt ? cleanDate(payload.availableAt, "availableAt", false) : null,
  };
}

function defaultExpiresAt() {
  const hours = Math.min(Math.max(Number.parseInt(process.env.AURA_ACTION_EXPIRY_HOURS || "24", 10) || 24, 1), 168);
  return new Date(Date.now() + hours * 60 * 60_000).toISOString();
}

function canApprove(ctx, requiredPermission) {
  if (ctx.roles.includes("superadmin")) return true;
  if (ctx.roles.includes("admin")) return true;
  if (ADMIN_ONLY_PERMISSIONS.has(requiredPermission)) return false;
  return ctx.roles.includes("gerente");
}

function mapActionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerAdminId: Number(row.owner_admin_id),
    userId: row.user_id || null,
    actionType: row.action_type,
    status: row.status,
    payload: row.payload || {},
    payloadHash: row.payload_hash,
    requiredPermission: row.required_permission,
    idempotencyKey: row.idempotency_key,
    expiresAt: row.expires_at,
    approvedBy: row.approved_by || null,
    approvedAt: row.approved_at || null,
    executedAt: row.executed_at || null,
    result: row.result || {},
    errorCode: row.error_code || null,
    errorMessageRedacted: row.error_message_redacted || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
    try { await client.query("ROLLBACK"); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

async function proposeAction(input) {
  const ctx = requireCtx(input);
  const actionType = cleanText(input.actionType || input.action_type, "actionType", { required: true, max: 80 });
  const payload = validateActionPayload(actionType, input.payload || {});
  const requiredPermission = ACTION_PERMISSIONS[actionType];
  const payloadHash = hashPayload(payload);
  const idempotencyKey = cleanText(input.idempotencyKey, "idempotencyKey", { max: 200 })
    || `aura:${actionType}:${payloadHash}`;
  const expiresAt = input.expiresAt ? cleanDate(input.expiresAt, "expiresAt") : defaultExpiresAt();
  const actionId = uuid();

  const { rows } = await db.query(
    `INSERT INTO aura_actions
       (id, owner_admin_id, user_id, action_type, status, payload, payload_hash,
        required_permission, idempotency_key, expires_at, result)
     VALUES ($1, $2, $3, $4, 'pending_approval', $5, $6, $7, $8, $9, '{}'::jsonb)
     ON CONFLICT (owner_admin_id, idempotency_key)
     DO UPDATE SET updated_at = aura_actions.updated_at
     RETURNING *`,
    [
      actionId,
      ctx.ownerAdminId,
      ctx.userId,
      actionType,
      JSON.stringify(payload),
      payloadHash,
      requiredPermission,
      idempotencyKey,
      expiresAt,
    ]
  );
  return mapActionRow(rows[0]);
}

async function listActions(input) {
  const ctx = requireCtx(input);
  const limit = Math.min(Math.max(Number.parseInt(input.query?.limit || "50", 10) || 50, 1), 100);
  const offset = Math.min(Math.max(Number.parseInt(input.query?.offset || "0", 10) || 0, 0), 10_000);
  const params = [ctx.ownerAdminId];
  const filters = ["owner_admin_id = $1"];
  if (input.query?.status) {
    params.push(input.query.status);
    filters.push(`status = $${params.length}`);
  }
  if (input.query?.actionType) {
    params.push(input.query.actionType);
    filters.push(`action_type = $${params.length}`);
  }
  params.push(limit, offset);
  const { rows } = await db.query(
    `SELECT *
     FROM aura_actions
     WHERE ${filters.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { rows: rows.map(mapActionRow), pagination: { limit, offset, count: rows.length } };
}

async function getAction(input) {
  const ctx = requireCtx(input);
  const { rows } = await db.query(
    `SELECT *
     FROM aura_actions
     WHERE owner_admin_id = $1
       AND id = $2
     LIMIT 1`,
    [ctx.ownerAdminId, input.actionId]
  );
  if (!rows.length) throw createActionError("Accion no encontrada", "AURA_ACTION_NOT_FOUND", 404);
  return mapActionRow(rows[0]);
}

async function executeApproveCampaign(client, ctx, payload) {
  const { rows } = await client.query(
    `UPDATE marketing_campaigns
     SET status = 'approved',
         approved_by = $3,
         updated_at = NOW()
     WHERE owner_admin_id = $1
       AND id = $2
       AND status IN ('draft', 'pending_approval', 'approved')
     RETURNING id, status, approved_by`,
    [ctx.ownerAdminId, payload.campaignId, ctx.userId]
  );
  if (!rows.length) throw createActionError("Campana no aprobable", "CAMPAIGN_NOT_APPROVABLE", 409);
  return { campaign: rows[0] };
}

async function executeScheduleCampaign(client, ctx, payload) {
  const { rows } = await client.query(
    `UPDATE marketing_campaigns
     SET status = 'scheduled',
         scheduled_at = $3,
         updated_at = NOW()
     WHERE owner_admin_id = $1
       AND id = $2
       AND status IN ('approved', 'scheduled')
     RETURNING id, status, scheduled_at`,
    [ctx.ownerAdminId, payload.campaignId, payload.scheduledAt]
  );
  if (!rows.length) throw createActionError("Campana no programable", "CAMPAIGN_NOT_SCHEDULABLE", 409);
  return { campaign: rows[0] };
}

async function executePauseCampaign(client, ctx, payload) {
  const { rows } = await client.query(
    `UPDATE marketing_campaigns
     SET status = 'paused',
         updated_at = NOW()
     WHERE owner_admin_id = $1
       AND id = $2
       AND status IN ('scheduled', 'running', 'approved')
     RETURNING id, status`,
    [ctx.ownerAdminId, payload.campaignId]
  );
  if (!rows.length) throw createActionError("Campana no pausable", "CAMPAIGN_NOT_PAUSABLE", 409);
  return { campaign: rows[0] };
}

async function executeCreateDiscountDraft(client, ctx, payload) {
  const { rows } = await client.query(
    `INSERT INTO discounts
       (name, type, value, starts_at, ends_at, code, description, created_by, owner_admin_id, scope, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false)
     RETURNING id, name, active`,
    [
      payload.name,
      payload.type,
      payload.value,
      payload.startsAt,
      payload.endsAt,
      payload.code ? payload.code.toUpperCase() : null,
      payload.description || null,
      ctx.userId,
      ctx.ownerAdminId,
      payload.scope,
    ]
  );
  const discount = rows[0];
  for (const target of payload.targets || []) {
    await client.query(
      `INSERT INTO discount_targets (discount_id, target_type, target_id)
       VALUES ($1, $2, $3)`,
      [discount.id, target.target_type, target.target_id]
    );
  }
  return { discount };
}

async function executeApproveDiscount(client, ctx, payload) {
  const { rows } = await client.query(
    `UPDATE discounts
     SET active = true,
         updated_at = NOW()
     WHERE owner_admin_id = $1
       AND id = $2
     RETURNING id, active`,
    [ctx.ownerAdminId, payload.discountId]
  );
  if (!rows.length) throw createActionError("Descuento no encontrado", "DISCOUNT_NOT_FOUND", 404);
  return { discount: rows[0] };
}

async function executeActionByType(client, ctx, action) {
  if (action.action_type === "approve_campaign") return executeApproveCampaign(client, ctx, action.payload);
  if (action.action_type === "schedule_campaign") return executeScheduleCampaign(client, ctx, action.payload);
  if (action.action_type === "pause_campaign") return executePauseCampaign(client, ctx, action.payload);
  if (action.action_type === "create_discount_draft") return executeCreateDiscountDraft(client, ctx, action.payload);
  if (action.action_type === "approve_discount") return executeApproveDiscount(client, ctx, action.payload);
  if (action.action_type === "enqueue_campaign_delivery") {
    return enqueueCampaignDelivery(client, {
      ownerAdminId: ctx.ownerAdminId,
      campaignId: action.payload.campaignId,
      actionId: action.id,
      payload: action.payload,
      approvedBy: ctx.userId,
    });
  }
  throw createActionError("Accion no soportada", "AURA_ACTION_TYPE_NOT_ALLOWED", 400);
}

async function approveAction(input) {
  const ctx = requireCtx(input);
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT *
       FROM aura_actions
       WHERE owner_admin_id = $1
         AND id = $2
       FOR UPDATE`,
      [ctx.ownerAdminId, input.actionId]
    );
    if (!rows.length) throw createActionError("Accion no encontrada", "AURA_ACTION_NOT_FOUND", 404);
    const action = rows[0];
    const expectedPermission = ACTION_PERMISSIONS[action.action_type];

    if (!expectedPermission || action.required_permission !== expectedPermission) {
      throw createActionError("Permiso requerido no coincide con el tipo de accion", "AURA_ACTION_PERMISSION_MISMATCH", 409);
    }
    if (!action.idempotency_key) {
      throw createActionError("idempotency_key requerido para aprobar", "AURA_ACTION_IDEMPOTENCY_REQUIRED", 409);
    }
    if (!canApprove(ctx, action.required_permission)) {
      throw createActionError("Permiso insuficiente para aprobar esta accion", "AURA_ACTION_PERMISSION_DENIED", 403);
    }
    if (!["draft", "pending_approval", "approved"].includes(action.status)) {
      throw createActionError("Estado actual no permite aprobacion", "AURA_ACTION_INVALID_STATE", 409);
    }
    if (new Date(action.expires_at).getTime() <= Date.now()) {
      await client.query(
        `UPDATE aura_actions
         SET status = 'expired', error_code = 'AURA_ACTION_EXPIRED', updated_at = NOW()
         WHERE id = $1`,
        [action.id]
      );
      throw createActionError("La accion expiro", "AURA_ACTION_EXPIRED", 410);
    }
    const normalizedPayload = validateActionPayload(action.action_type, action.payload);
    const actualHash = hashPayload(normalizedPayload);
    if (actualHash !== action.payload_hash) {
      throw createActionError("payload_hash no coincide", "AURA_ACTION_PAYLOAD_HASH_MISMATCH", 409);
    }

    await client.query(
      `UPDATE aura_actions
       SET status = 'executing',
           approved_by = $2,
           approved_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [action.id, ctx.userId]
    );

    try {
      const result = await executeActionByType(client, ctx, { ...action, payload: normalizedPayload });
      const { rows: completed } = await client.query(
        `UPDATE aura_actions
         SET status = 'completed',
             executed_at = NOW(),
             result = $2::jsonb,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [action.id, JSON.stringify({ ...result, after: result })]
      );
      return mapActionRow(completed[0]);
    } catch (err) {
      const { rows: failed } = await client.query(
        `UPDATE aura_actions
         SET status = 'failed',
             error_code = $2,
             error_message_redacted = $3,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          action.id,
          String(err.code || "AURA_ACTION_EXECUTION_FAILED").slice(0, 80),
          String(err.status && err.status < 500 ? err.message : "Error ejecutando accion").slice(0, 500),
        ]
      );
      const safe = createActionError("No fue posible ejecutar la accion", err.code || "AURA_ACTION_EXECUTION_FAILED", err.status || 500);
      safe.action = mapActionRow(failed[0]);
      throw safe;
    }
  });
}

async function rejectAction(input) {
  const ctx = requireCtx(input);
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE aura_actions
       SET status = 'rejected',
           result = COALESCE(result, '{}'::jsonb) || $3::jsonb,
           updated_at = NOW()
       WHERE owner_admin_id = $1
         AND id = $2
         AND status IN ('draft', 'pending_approval', 'approved')
       RETURNING *`,
      [
        ctx.ownerAdminId,
        input.actionId,
        JSON.stringify({ rejectedBy: ctx.userId, reason: cleanText(input.reason, "reason", { max: 300 }) }),
      ]
    );
    if (!rows.length) throw createActionError("Accion no rechazable", "AURA_ACTION_NOT_REJECTABLE", 409);
    return mapActionRow(rows[0]);
  });
}

module.exports = {
  ACTION_PERMISSIONS,
  hashPayload,
  validateActionPayload,
  proposeAction,
  listActions,
  getAction,
  approveAction,
  rejectAction,
};
