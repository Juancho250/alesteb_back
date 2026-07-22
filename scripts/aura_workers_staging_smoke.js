'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { Pool } = require('pg');

const FEATURE_VERSION = 'predictive_features_v1';
const SMOKE_LOCK_NAME = 'alesteb:aura:workers:staging-smoke:v1';
const MARKERS = Object.freeze({
  notification: 'AURA_NOTIFICATION_WORKER_SMOKE_PASS',
  image: 'AURA_IMAGE_WORKER_SMOKE_PASS',
  forecast: 'AURA_FORECAST_WORKER_SMOKE_PASS',
  cleaned: 'AURA_WORKERS_FIXTURES_CLEANED',
  complete: 'AURA_WORKERS_STAGING_SMOKE_PASS',
  providerBlocked: 'AURA_REAL_PROVIDER_ATTEMPT_BLOCKED',
});

function createSmokeError(message, code = 'AURA_WORKERS_SMOKE_ERROR') {
  const err = new Error(message);
  err.code = code;
  return err;
}

function envFlag(env, name) {
  return String(env[name] || '').trim().toLowerCase() === 'true';
}

function validateSmokeEnvironment(env = process.env) {
  const requiredTrue = [
    'AURA_STAGING_MODE',
    'AURA_IMAGE_MOCK_PROVIDER_ENABLED',
    'AURA_NOTIFICATION_MOCK_PROVIDER_ENABLED',
  ];
  for (const name of requiredTrue) {
    if (!envFlag(env, name)) {
      throw createSmokeError(`${name} debe estar habilitado`, 'AURA_SMOKE_MOCK_GUARD_FAILED');
    }
  }

  const requiredFalse = [
    'AURA_IMAGE_WORKER_ENABLED',
    'AURA_NOTIFICATION_WORKER_ENABLED',
    'AURA_PREDICTIVE_JOBS_ENABLED',
    'AURA_FORECAST_WORKER_ENABLED',
    'LEGACY_CREDIT_REMINDER_WORKER_ENABLED',
    'LEGACY_NOTIFICATION_SCHEDULER_ENABLED',
    'ENABLE_LEGACY_AGENT_CRON',
    'AURA_VOICE_ENABLED',
  ];
  for (const name of requiredFalse) {
    if (envFlag(env, name)) {
      throw createSmokeError(`${name} debe permanecer deshabilitado`, 'AURA_SMOKE_WORKER_FLAG_UNSAFE');
    }
  }
}

function validateDatabaseUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw createSmokeError('DATABASE_URL es requerida', 'AURA_SMOKE_DATABASE_URL_REQUIRED');
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw createSmokeError('DATABASE_URL no es una URL PostgreSQL valida', 'AURA_SMOKE_DATABASE_URL_INVALID');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw createSmokeError('DATABASE_URL no usa PostgreSQL', 'AURA_SMOKE_DATABASE_URL_INVALID');
  }

  const host = parsed.hostname.toLowerCase();
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, '')).toLowerCase();
  if (!host || !database || !(host === 'neon.tech' || host.endsWith('.neon.tech'))) {
    throw createSmokeError('El destino debe ser un host Neon valido', 'AURA_SMOKE_NON_NEON_TARGET');
  }
  if (host.includes('pooler')) {
    throw createSmokeError('El smoke requiere conexion Neon directa', 'AURA_SMOKE_POOLER_REJECTED');
  }
  if (/(^|[.-])(prod|production|main)([.-]|$)/i.test(host) || /(prod|production|main)/i.test(database)) {
    throw createSmokeError('El destino parece productivo', 'AURA_SMOKE_PRODUCTION_TARGET_REJECTED');
  }
  return { parsed, host, database };
}

function safeErrorCode(err) {
  return String(err?.code || 'AURA_WORKERS_SMOKE_ERROR')
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 100);
}

function safeDiagnosticIdentifier(value, maxLength = 128) {
  return String(value || '')
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .slice(0, maxLength);
}

function extractMissingColumn(err) {
  const direct = safeDiagnosticIdentifier(err?.column);
  if (direct) return direct;
  const match = String(err?.message || '').match(
    /\bcolumn\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?))\s+does not exist\b/i
  );
  return safeDiagnosticIdentifier(match?.[1] || match?.[2]);
}

function redactSqlStringLiterals(sql) {
  const source = String(sql || '');
  let redacted = '';
  let inString = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (!inString) {
      redacted += character;
      if (character === "'") inString = true;
      continue;
    }
    if (character === "'" && source[index + 1] === "'") {
      redacted += '??';
      index += 1;
    } else if (character === "'") {
      redacted += character;
      inString = false;
    } else {
      redacted += character === '\r' || character === '\n' ? ' ' : '?';
    }
  }
  return redacted;
}

function sqlContextAtPosition(sql, rawPosition, maxLength = 160) {
  const position = Number.parseInt(String(rawPosition || ''), 10);
  if (!Number.isSafeInteger(position) || position < 1 || !sql) return '';

  const redacted = redactSqlStringLiterals(sql);
  const index = Math.min(position - 1, Math.max(0, redacted.length - 1));
  let start = Math.max(0, index - Math.floor(maxLength / 2));
  let end = Math.min(redacted.length, start + maxLength);
  if (end - start < maxLength) start = Math.max(0, end - maxLength);

  return redacted
    .slice(start, end)
    .replace(/\s/g, ' ')
    .replace(/\?{2,}/g, '?')
    .trim()
    .slice(0, maxLength);
}

function sanitizePostgresError(err) {
  const safe = {};
  const identifierFields = ['table', 'column', 'constraint', 'routine'];
  const code = safeErrorCode(err);
  if (code) safe.code = code;

  for (const field of identifierFields) {
    if (err?.[field] === null || err?.[field] === undefined) continue;
    const value = safeDiagnosticIdentifier(err[field]);
    if (value) safe[field] = value;
  }

  if (err?.position !== null && err?.position !== undefined) {
    const position = String(err.position).replace(/\D/g, '').slice(0, 12);
    if (position) safe.position = position;
  }
  const statementName = safeDiagnosticIdentifier(err?.auraStatementName, 80);
  if (statementName) safe.statementName = statementName;

  if (code === '42703') {
    const missingColumn = extractMissingColumn(err);
    if (missingColumn) safe.missingColumn = missingColumn;
  }

  const sqlContext = sqlContextAtPosition(err?.auraSql, safe.position);
  if (sqlContext) safe.sqlContext = sqlContext;
  return safe;
}

function createFixtureTracker(smokeRunId) {
  return {
    smokeRunId,
    ownerAdminId: null,
    notificationIds: [],
    imageJobIds: [],
    forecastJobIds: [],
    assetIds: [],
    featureRunIds: [],
    forecastRunIds: [],
    modelVersionIdsCreated: [],
    featureDate: null,
  };
}

function appendUnique(target, values) {
  for (const value of values || []) {
    if (value !== null && value !== undefined && !target.includes(String(value))) {
      target.push(String(value));
    }
  }
}

function deriveFeatureDate(smokeRunId) {
  const seed = Number.parseInt(String(smokeRunId).replace(/-/g, '').slice(0, 8), 16);
  const date = new Date(Date.UTC(2080, 0, 1));
  date.setUTCDate(date.getUTCDate() + (seed % 6000));
  return date.toISOString().slice(0, 10);
}

function parseClockMinutes(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

function isQuietHoursAt(settings, now = new Date()) {
  const start = parseClockMinutes(settings?.quiet_hours_start);
  const end = parseClockMinutes(settings?.quiet_hours_end);
  if (start === null || end === null) return false;

  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: settings.timezone || 'America/Bogota',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
  } catch {
    return true;
  }
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  const current = hour * 60 + minute;
  return start <= end
    ? current >= start && current < end
    : current >= start || current < end;
}

function cloudNameFromCatalogUrl(imageUrl) {
  let parsed;
  try {
    parsed = new URL(imageUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'res.cloudinary.com') {
    return null;
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 4 || parts[1] !== 'image' || parts[2] !== 'upload') return null;
  return parts[0];
}

async function selectFixtureContext(db) {
  const { rows } = await db.query(
    `SELECT
       p.owner_admin_id,
       p.id AS product_id,
       pi.url AS image_url,
       ns.quiet_hours_start,
       ns.quiet_hours_end,
       COALESCE(ns.timezone, 'America/Bogota') AS timezone
     FROM products p
     JOIN users owner_user
       ON owner_user.id = p.owner_admin_id
      AND owner_user.owner_admin_id IS NULL
      AND COALESCE(owner_user.is_active, true) = true
     JOIN LATERAL (
       SELECT url
       FROM product_images
       WHERE product_id = p.id
         AND url LIKE 'https://res.cloudinary.com/%/image/upload/%'
       ORDER BY is_main DESC, display_order ASC, id ASC
       LIMIT 1
     ) pi ON true
     LEFT JOIN notification_settings ns ON ns.admin_id = p.owner_admin_id
     WHERE p.owner_admin_id IS NOT NULL
       AND COALESCE(p.is_active, true) = true
       AND EXISTS (
         SELECT 1
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id = owner_user.id
           AND r.name = 'admin'
       )
     ORDER BY p.owner_admin_id, p.id
     LIMIT 50`
  );

  for (const row of rows) {
    const cloudName = cloudNameFromCatalogUrl(row.image_url);
    if (!cloudName || isQuietHoursAt(row)) continue;
    return {
      ownerAdminId: Number(row.owner_admin_id),
      userId: Number(row.owner_admin_id),
      productId: Number(row.product_id),
      cloudName,
    };
  }
  throw createSmokeError(
    'No hay un tenant elegible con producto Cloudinary fuera de quiet hours',
    'AURA_SMOKE_FIXTURE_CONTEXT_UNAVAILABLE'
  );
}

function installDatabaseModule(db) {
  const dbPath = require.resolve(path.join(__dirname, '..', 'config', 'db.js'));
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: db,
  };
}

function installRealProviderGuard() {
  const attempts = [];
  const restorers = [];

  function block(provider) {
    attempts.push(provider);
    process.stderr.write(`${MARKERS.providerBlocked}\n`);
    throw createSmokeError('Intento de proveedor real bloqueado', 'AURA_SMOKE_REAL_PROVIDER_BLOCKED');
  }

  function patch(target, key, provider) {
    if (!target || typeof target[key] !== 'function') return;
    const original = target[key];
    target[key] = function blockedProviderCall() {
      return block(provider);
    };
    restorers.push(() => {
      target[key] = original;
    });
  }

  const axios = require('axios');
  patch(axios, 'post', 'http');

  const cloudinary = require('../config/cloudinary');
  patch(cloudinary.uploader, 'upload_stream', 'cloudinary_upload');
  patch(cloudinary.uploader, 'destroy', 'cloudinary_destroy');

  const whatsapp = require('../services/providers/whatsapp.provider');
  patch(whatsapp, 'send', 'whatsapp');
  patch(whatsapp, 'sendTemplate', 'whatsapp_template');

  const push = require('../src/modules/notifications').push;
  patch(push, 'sendPushToOne', 'web_push');

  const brevo = require('@getbrevo/brevo');
  patch(brevo.TransactionalEmailsApi?.prototype, 'sendTransacEmail', 'brevo_email');

  if (typeof global.fetch === 'function') {
    const originalFetch = global.fetch;
    global.fetch = function blockedFetch() {
      return block('fetch');
    };
    restorers.push(() => {
      global.fetch = originalFetch;
    });
  }

  return {
    attempts,
    assertUnused() {
      if (attempts.length) {
        throw createSmokeError('Se detecto un intento de proveedor real', 'AURA_SMOKE_REAL_PROVIDER_BLOCKED');
      }
    },
    restore() {
      while (restorers.length) restorers.pop()();
    },
  };
}

function loadOneShotServices() {
  return {
    notificationWorker: require('../src/modules/notifications').worker,
    imageJobs: require('../services/auraImageJobs.service'),
    imageWorker: require('../services/auraImageWorker.service'),
    predictiveFeatures: require('../services/auraPredictiveFeatures.service'),
    forecasting: require('../services/auraForecasting.service'),
  };
}

const FOREIGN_QUEUE_QUERIES = Object.freeze({
  notification: {
    sql: `SELECT COUNT(*)::int AS foreign_count
          FROM notification_queue
          WHERE status = 'pending'
            AND available_at <= NOW()
            AND scheduled_for <= NOW()
            AND attempts < max_attempts
            AND ($1::bigint IS NULL OR id <> $1::bigint)`,
    castId: (value) => (value === null || value === undefined ? null : String(value)),
  },
  image: {
    sql: `SELECT COUNT(*)::int AS foreign_count
          FROM ai_jobs
          WHERE status = 'queued'
            AND type IN ('aura_image_generate', 'aura_image_edit')
            AND available_at <= NOW()
            AND attempts < max_attempts
            AND ($1::uuid IS NULL OR id <> $1::uuid)`,
    castId: (value) => value || null,
  },
  forecast: {
    sql: `SELECT COUNT(*)::int AS foreign_count
          FROM ai_jobs
          WHERE type = 'aura_prediction_recalculate'
            AND status = 'queued'
            AND COALESCE(available_at, NOW()) <= NOW()
            AND COALESCE(attempts, 0) < COALESCE(max_attempts, 2)
            AND ($1::uuid IS NULL OR id <> $1::uuid)`,
    castId: (value) => value || null,
  },
});

async function assertNoForeignEligible(db, queueName, ownId = null) {
  const definition = FOREIGN_QUEUE_QUERIES[queueName];
  if (!definition) {
    throw createSmokeError('Cola de smoke no soportada', 'AURA_SMOKE_QUEUE_INVALID');
  }
  const { rows } = await db.query(definition.sql, [definition.castId(ownId)]);
  const count = Number(rows[0]?.foreign_count || 0);
  if (count > 0) {
    throw createSmokeError(
      `La cola ${queueName} contiene trabajo elegible ajeno al smoke`,
      `AURA_SMOKE_${queueName.toUpperCase()}_FOREIGN_ELIGIBLE`
    );
  }
  return true;
}

function assertTenantRow(row, ownerAdminId, expectedId, label) {
  if (
    !row
    || Number(row.owner_admin_id) !== Number(ownerAdminId)
    || String(row.id) !== String(expectedId)
  ) {
    throw createSmokeError(`${label} no pertenece al fixture esperado`, 'AURA_SMOKE_TENANT_MISMATCH');
  }
}

function assertNotificationOutcome(row, ownerAdminId, notificationId) {
  assertTenantRow(row, ownerAdminId, notificationId, 'notification_queue');
  if (row.status !== 'sent' || !String(row.provider_message_id || '').startsWith('mock:')) {
    throw createSmokeError('La notificacion mock no termino correctamente', 'AURA_SMOKE_NOTIFICATION_FAILED');
  }
  if (!row.sent_at || Number(row.attempts) !== 1) {
    throw createSmokeError('La evidencia de envio mock es incompleta', 'AURA_SMOKE_NOTIFICATION_EVIDENCE_MISSING');
  }
}

function assertImageOutcome(job, asset, ownerAdminId, jobId, assetId) {
  assertTenantRow(job, ownerAdminId, jobId, 'ai_jobs:image');
  assertTenantRow(asset, ownerAdminId, assetId, 'campaign_assets');
  const mockEndpoint = String(asset.metadata?.openaiEndpoint || '').startsWith('mock/');
  const mockModel = String(job.output?.model || '').includes('mock');
  if (
    job.status !== 'completed'
    || asset.status !== 'ready'
    || !asset.generated_asset_url
    || !asset.cloudinary_public_id
    || !mockEndpoint
    || !mockModel
  ) {
    throw createSmokeError('El job de imagen mock no termino correctamente', 'AURA_SMOKE_IMAGE_FAILED');
  }
}

function assertForecastOutcome({ job, run, resultCount, crossTenantCount }, ownerAdminId, jobId) {
  assertTenantRow(job, ownerAdminId, jobId, 'ai_jobs:forecast');
  if (
    job.status !== 'completed'
    || !run
    || Number(run.owner_admin_id) !== Number(ownerAdminId)
    || run.status !== 'completed'
    || Number(resultCount) < 1
    || Number(crossTenantCount) !== 0
  ) {
    throw createSmokeError('El forecast tenant-aware no termino correctamente', 'AURA_SMOKE_FORECAST_FAILED');
  }
}

async function createNotificationFixture(db, tracker) {
  const dedupeKey = `aura-workers-smoke:${tracker.smokeRunId}:notification`;
  const { rows } = await db.query(
    `INSERT INTO notification_queue
       (owner_admin_id, recipient, recipient_user_id, channel, event, template_key,
        rendered_subject, rendered_message, payload, dedupe_key, status, attempts,
        max_attempts, available_at, scheduled_for, reference_type, reference_key,
        created_at, updated_at)
     VALUES
       ($1, '{}'::jsonb, NULL, 'email', 'aura_campaign_delivery', 'aura_worker_smoke',
        'AURA worker smoke', 'AURA worker smoke', $2::jsonb, $3, 'pending', 0,
        1, NOW(), NOW(), 'aura_worker_smoke', $4, NOW(), NOW())
     RETURNING id, owner_admin_id, status`,
    [
      tracker.ownerAdminId,
      JSON.stringify({ smokeRunId: tracker.smokeRunId, mockOnly: true }),
      dedupeKey,
      tracker.smokeRunId,
    ]
  );
  if (!rows.length) {
    throw createSmokeError('No se creo la notificacion de smoke', 'AURA_SMOKE_NOTIFICATION_INSERT_FAILED');
  }
  appendUnique(tracker.notificationIds, [rows[0].id]);
  return rows[0];
}

async function runNotificationSmoke(db, services, tracker, providerGuard) {
  await assertNoForeignEligible(db, 'notification');
  const fixture = await createNotificationFixture(db, tracker);
  await assertNoForeignEligible(db, 'notification', fixture.id);

  const tick = await services.notificationWorker.runNotificationWorkerTick({
    batchSize: 1,
    workerId: `aura-notification-smoke:${tracker.smokeRunId}`,
    skipRecovery: true,
    claimScope: {
      ownerAdminId: tracker.ownerAdminId,
      notificationId: fixture.id,
    },
  });
  if (Number(tick.processed) !== 1 || Number(tick.recovered) !== 0) {
    throw createSmokeError('El tick de notificacion no proceso un unico fixture', 'AURA_SMOKE_NOTIFICATION_TICK_INVALID');
  }

  const { rows } = await db.query(
    `SELECT id, owner_admin_id, status, attempts, provider_message_id, sent_at
     FROM notification_queue
     WHERE owner_admin_id = $1
       AND id = $2`,
    [tracker.ownerAdminId, fixture.id]
  );
  assertNotificationOutcome(rows[0], tracker.ownerAdminId, fixture.id);
  providerGuard.assertUnused();
  console.log(MARKERS.notification);
}

async function runImageSmoke(db, services, tracker, context, providerGuard) {
  await assertNoForeignEligible(db, 'image');
  const created = await services.imageJobs.enqueueImageJob({
    ownerAdminId: tracker.ownerAdminId,
    userId: context.userId,
    roles: ['admin'],
    mode: 'generate',
    payload: {
      productId: context.productId,
      objective: `aura-workers-smoke:${tracker.smokeRunId}`,
      format: 'instagram_square',
      style: 'premium futurista',
      instructions: 'conservar exactamente el producto',
      force: true,
    },
  });
  if (!created.created || !created.job?.id || !created.asset?.id) {
    throw createSmokeError('No se crearon fixtures nuevos de imagen', 'AURA_SMOKE_IMAGE_FIXTURE_NOT_CREATED');
  }
  appendUnique(tracker.imageJobIds, [created.job.id]);
  appendUnique(tracker.assetIds, [created.asset.id]);

  await db.query(
    `UPDATE ai_jobs
     SET input = input || jsonb_build_object('smokeRunId', $3::text)
     WHERE owner_admin_id = $1
       AND id = $2`,
    [tracker.ownerAdminId, created.job.id, tracker.smokeRunId]
  );
  await db.query(
    `UPDATE campaign_assets
     SET metadata = metadata || jsonb_build_object('smokeRunId', $3::text)
     WHERE owner_admin_id = $1
       AND id = $2`,
    [tracker.ownerAdminId, created.asset.id, tracker.smokeRunId]
  );

  await assertNoForeignEligible(db, 'image', created.job.id);
  const processed = await services.imageWorker.processOneImageJob(
    `aura-image-smoke:${tracker.smokeRunId}`,
    { ownerAdminId: tracker.ownerAdminId, jobId: created.job.id }
  );
  if (!processed.processed || String(processed.jobId) !== String(created.job.id) || processed.error) {
    throw createSmokeError('El one-shot de imagen no completo el fixture', 'AURA_SMOKE_IMAGE_PROCESS_FAILED');
  }

  const [jobResult, assetResult] = await Promise.all([
    db.query(
      `SELECT id, owner_admin_id, status, output
       FROM ai_jobs
       WHERE owner_admin_id = $1 AND id = $2`,
      [tracker.ownerAdminId, created.job.id]
    ),
    db.query(
      `SELECT id, owner_admin_id, status, generated_asset_url,
              cloudinary_public_id, metadata
       FROM campaign_assets
       WHERE owner_admin_id = $1 AND id = $2`,
      [tracker.ownerAdminId, created.asset.id]
    ),
  ]);
  assertImageOutcome(
    jobResult.rows[0],
    assetResult.rows[0],
    tracker.ownerAdminId,
    created.job.id,
    created.asset.id
  );
  providerGuard.assertUnused();
  console.log(MARKERS.image);
}

async function assertFeatureSlotEmpty(db, ownerAdminId, featureDate) {
  const { rows } = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM daily_product_features
        WHERE owner_admin_id = $1 AND feature_date = $2 AND feature_version = $3) AS products,
       (SELECT COUNT(*) FROM daily_variant_features
        WHERE owner_admin_id = $1 AND feature_date = $2 AND feature_version = $3) AS variants,
       (SELECT COUNT(*) FROM daily_store_features
        WHERE owner_admin_id = $1 AND feature_date = $2 AND feature_version = $3) AS store`,
    [ownerAdminId, featureDate, FEATURE_VERSION]
  );
  const occupied = Number(rows[0]?.products || 0)
    + Number(rows[0]?.variants || 0)
    + Number(rows[0]?.store || 0);
  if (occupied !== 0) {
    throw createSmokeError('La fecha determinista de features ya esta ocupada', 'AURA_SMOKE_FEATURE_SLOT_OCCUPIED');
  }
}

async function runTenantFeatureSmoke(db, services, tracker, context) {
  const featureDate = deriveFeatureDate(tracker.smokeRunId);
  tracker.featureDate = featureDate;
  await assertFeatureSlotEmpty(db, tracker.ownerAdminId, featureDate);

  const daily = await services.predictiveFeatures.runDailyPredictiveFeatureJob({
    targetDate: featureDate,
    ownerAdminId: tracker.ownerAdminId,
    throwOnError: true,
  });
  if (
    Number(daily.tenants) !== 1
    || daily.results.length !== 1
    || !daily.results[0].success
    || Number(daily.results[0].ownerAdminId) !== tracker.ownerAdminId
    || !daily.results[0].runId
  ) {
    throw createSmokeError('El feature job no quedo limitado a un tenant', 'AURA_SMOKE_FEATURE_TENANT_FAILED');
  }

  const featureRunId = daily.results[0].runId;
  appendUnique(tracker.featureRunIds, [featureRunId]);
  await db.query(
    `UPDATE prediction_runs
     SET metadata = metadata || jsonb_build_object('smokeRunId', $3::text)
     WHERE owner_admin_id = $1
       AND id = $2`,
    [tracker.ownerAdminId, featureRunId, tracker.smokeRunId]
  );

  const { rows } = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM daily_product_features
        WHERE calculation_run_id = $1 AND owner_admin_id = $2) AS tenant_product_rows,
       (SELECT COUNT(*) FROM daily_product_features
        WHERE calculation_run_id = $1 AND owner_admin_id = $2 AND product_id = $3) AS selected_product_rows,
       (
         (SELECT COUNT(*) FROM daily_product_features
          WHERE calculation_run_id = $1 AND owner_admin_id <> $2)
         + (SELECT COUNT(*) FROM daily_variant_features
            WHERE calculation_run_id = $1 AND owner_admin_id <> $2)
         + (SELECT COUNT(*) FROM daily_store_features
            WHERE calculation_run_id = $1 AND owner_admin_id <> $2)
       ) AS cross_tenant_rows`,
    [featureRunId, tracker.ownerAdminId, context.productId]
  );
  if (
    Number(rows[0]?.tenant_product_rows || 0) < 1
    || Number(rows[0]?.selected_product_rows || 0) !== 1
    || Number(rows[0]?.cross_tenant_rows || 0) !== 0
  ) {
    throw createSmokeError('Las features no superaron el postcheck tenant-aware', 'AURA_SMOKE_FEATURE_POSTCHECK_FAILED');
  }
}

async function runForecastSmoke(db, services, tracker, context, providerGuard) {
  await runTenantFeatureSmoke(db, services, tracker, context);
  await assertNoForeignEligible(db, 'forecast');

  const created = await services.forecasting.enqueueForecastRecalculation({
    ownerAdminId: tracker.ownerAdminId,
    userId: context.userId,
    payload: {
      productId: context.productId,
      horizons: [7],
      force: true,
    },
  });
  if (!created.created || !created.id) {
    throw createSmokeError('No se creo un forecast job nuevo', 'AURA_SMOKE_FORECAST_FIXTURE_NOT_CREATED');
  }
  appendUnique(tracker.forecastJobIds, [created.id]);
  await db.query(
    `UPDATE ai_jobs
     SET input = input
       || jsonb_build_object('smokeRunId', $3::text)
       || jsonb_build_object('auditTag', $3::text)
     WHERE owner_admin_id = $1
       AND id = $2`,
    [tracker.ownerAdminId, created.id, tracker.smokeRunId]
  );

  await assertNoForeignEligible(db, 'forecast', created.id);
  const processed = await services.forecasting.processForecastJobs(
    1,
    `aura-forecast-smoke:${tracker.smokeRunId}`,
    { ownerAdminId: tracker.ownerAdminId, jobId: created.id }
  );
  if (
    Number(processed.processed) !== 1
    || processed.results.length !== 1
    || !processed.results[0].success
    || String(processed.results[0].jobId) !== String(created.id)
  ) {
    throw createSmokeError('El forecast one-shot no completo el fixture', 'AURA_SMOKE_FORECAST_PROCESS_FAILED');
  }

  const jobResult = await db.query(
    `SELECT id, owner_admin_id, status, output
     FROM ai_jobs
     WHERE owner_admin_id = $1 AND id = $2`,
    [tracker.ownerAdminId, created.id]
  );
  const job = jobResult.rows[0];
  const forecastRunId = job?.output?.runId;
  if (!forecastRunId) {
    throw createSmokeError('El forecast job no registro runId', 'AURA_SMOKE_FORECAST_RUN_MISSING');
  }
  appendUnique(tracker.forecastRunIds, [forecastRunId]);

  await db.query(
    `UPDATE prediction_runs
     SET metadata = metadata || jsonb_build_object('smokeRunId', $3::text)
     WHERE owner_admin_id = $1
       AND id = $2`,
    [tracker.ownerAdminId, forecastRunId, tracker.smokeRunId]
  );
  const runResult = await db.query(
    `SELECT id, owner_admin_id, status, model_version_id, metadata
     FROM prediction_runs
     WHERE id = $1`,
    [forecastRunId]
  );
  const predictionCounts = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE owner_admin_id = $2)::int AS tenant_count,
       COUNT(*) FILTER (WHERE owner_admin_id <> $2)::int AS cross_tenant_count
     FROM prediction_results
     WHERE run_id = $1`,
    [forecastRunId, tracker.ownerAdminId]
  );
  assertForecastOutcome({
    job,
    run: runResult.rows[0],
    resultCount: predictionCounts.rows[0]?.tenant_count,
    crossTenantCount: predictionCounts.rows[0]?.cross_tenant_count,
  }, tracker.ownerAdminId, created.id);

  if (
    runResult.rows[0]?.metadata?.modelVersionCreated === true
    && runResult.rows[0]?.model_version_id
  ) {
    appendUnique(tracker.modelVersionIdsCreated, [runResult.rows[0].model_version_id]);
  }
  providerGuard.assertUnused();
  console.log(MARKERS.forecast);
}

async function discoverSmokeFixtures(client, tracker) {
  if (!tracker.ownerAdminId) return;
  const ownerAdminId = tracker.ownerAdminId;
  const smokeRunId = tracker.smokeRunId;

  const [notifications, jobs, assets, runs] = await Promise.all([
    client.query(
      `SELECT id
       FROM notification_queue
       WHERE owner_admin_id = $1
         AND (
           reference_key = $2
           OR dedupe_key = $3
           OR payload ->> 'smokeRunId' = $2
         )`,
      [ownerAdminId, smokeRunId, `aura-workers-smoke:${smokeRunId}:notification`]
    ),
    client.query(
      `SELECT id, type
       FROM ai_jobs
       WHERE owner_admin_id = $1
         AND (
           input ->> 'smokeRunId' = $2
           OR input ->> 'auditTag' = $2
           OR input ->> 'objective' = $3
         )`,
      [ownerAdminId, smokeRunId, `aura-workers-smoke:${smokeRunId}`]
    ),
    client.query(
      `SELECT id
       FROM campaign_assets
       WHERE owner_admin_id = $1
         AND (
           metadata ->> 'smokeRunId' = $2
           OR POSITION($2 IN COALESCE(prompt, '')) > 0
         )`,
      [ownerAdminId, smokeRunId]
    ),
    client.query(
      `SELECT id, run_type, model_version_id, metadata
       FROM prediction_runs
       WHERE owner_admin_id = $1
         AND (
           metadata ->> 'smokeRunId' = $2
           OR metadata ->> 'auditTag' = $2
         )`,
      [ownerAdminId, smokeRunId]
    ),
  ]);

  appendUnique(tracker.notificationIds, notifications.rows.map((row) => row.id));
  appendUnique(
    tracker.imageJobIds,
    jobs.rows.filter((row) => String(row.type).startsWith('aura_image_')).map((row) => row.id)
  );
  appendUnique(
    tracker.forecastJobIds,
    jobs.rows.filter((row) => row.type === 'aura_prediction_recalculate').map((row) => row.id)
  );
  appendUnique(tracker.assetIds, assets.rows.map((row) => row.id));
  appendUnique(
    tracker.featureRunIds,
    runs.rows.filter((row) => row.run_type === 'feature_daily').map((row) => row.id)
  );
  appendUnique(
    tracker.forecastRunIds,
    runs.rows.filter((row) => row.run_type === 'prediction').map((row) => row.id)
  );
  appendUnique(
    tracker.modelVersionIdsCreated,
    runs.rows
      .filter((row) => row.metadata?.modelVersionCreated === true)
      .map((row) => row.model_version_id)
  );
}

async function verifyCleanup(client, tracker) {
  const ownerAdminId = tracker.ownerAdminId;
  const { rows } = await client.query(
    `SELECT
       (SELECT COUNT(*) FROM notification_queue
        WHERE owner_admin_id = $1
          AND (id = ANY($3::bigint[]) OR payload ->> 'smokeRunId' = $2 OR reference_key = $2)) AS notifications,
       (SELECT COUNT(*) FROM ai_jobs
        WHERE owner_admin_id = $1
          AND (
            id = ANY($4::uuid[])
            OR id = ANY($5::uuid[])
            OR input ->> 'smokeRunId' = $2
            OR input ->> 'auditTag' = $2
          )) AS jobs,
       (SELECT COUNT(*) FROM campaign_assets
        WHERE owner_admin_id = $1
          AND (id = ANY($6::uuid[]) OR metadata ->> 'smokeRunId' = $2)) AS assets,
       (SELECT COUNT(*) FROM prediction_runs
        WHERE owner_admin_id = $1
          AND (
            id = ANY($7::uuid[])
            OR id = ANY($8::uuid[])
            OR metadata ->> 'smokeRunId' = $2
            OR metadata ->> 'auditTag' = $2
          )) AS runs,
       (SELECT COUNT(*) FROM daily_product_features
        WHERE owner_admin_id = $1 AND calculation_run_id = ANY($7::uuid[])) AS product_features,
       (SELECT COUNT(*) FROM daily_variant_features
        WHERE owner_admin_id = $1 AND calculation_run_id = ANY($7::uuid[])) AS variant_features,
       (SELECT COUNT(*) FROM daily_store_features
        WHERE owner_admin_id = $1 AND calculation_run_id = ANY($7::uuid[])) AS store_features,
       (SELECT COUNT(*) FROM model_versions
        WHERE id = ANY($9::uuid[])) AS model_versions`,
    [
      ownerAdminId,
      tracker.smokeRunId,
      tracker.notificationIds,
      tracker.imageJobIds,
      tracker.forecastJobIds,
      tracker.assetIds,
      tracker.featureRunIds,
      tracker.forecastRunIds,
      tracker.modelVersionIdsCreated,
    ]
  );
  return Object.values(rows[0] || {}).reduce((sum, value) => sum + Number(value || 0), 0) === 0;
}

async function cleanupSmokeFixtures(db, tracker) {
  if (!tracker.ownerAdminId) return true;
  const client = await db.connect();
  try {
    await discoverSmokeFixtures(client, tracker);
    await client.query('BEGIN');

    if (tracker.forecastRunIds.length) {
      await client.query(
        `DELETE FROM prediction_results
         WHERE owner_admin_id = $1
           AND run_id = ANY($2::uuid[])`,
        [tracker.ownerAdminId, tracker.forecastRunIds]
      );
    }
    if (tracker.featureRunIds.length) {
      for (const table of [
        'daily_variant_features',
        'daily_product_features',
        'daily_store_features',
      ]) {
        await client.query(
          `DELETE FROM ${table}
           WHERE owner_admin_id = $1
             AND calculation_run_id = ANY($2::uuid[])`,
          [tracker.ownerAdminId, tracker.featureRunIds]
        );
      }
    }

    const predictionRunIds = [...tracker.forecastRunIds, ...tracker.featureRunIds];
    if (predictionRunIds.length) {
      await client.query(
        `DELETE FROM prediction_runs
         WHERE owner_admin_id = $1
           AND id = ANY($2::uuid[])`,
        [tracker.ownerAdminId, predictionRunIds]
      );
    }
    const aiJobIds = [...tracker.imageJobIds, ...tracker.forecastJobIds];
    if (aiJobIds.length) {
      await client.query(
        `DELETE FROM ai_jobs
         WHERE owner_admin_id = $1
           AND id = ANY($2::uuid[])`,
        [tracker.ownerAdminId, aiJobIds]
      );
    }
    if (tracker.assetIds.length) {
      await client.query(
        `DELETE FROM campaign_assets
         WHERE owner_admin_id = $1
           AND id = ANY($2::uuid[])`,
        [tracker.ownerAdminId, tracker.assetIds]
      );
    }
    if (tracker.notificationIds.length) {
      await client.query(
        `DELETE FROM notification_queue
         WHERE owner_admin_id = $1
           AND id = ANY($2::bigint[])`,
        [tracker.ownerAdminId, tracker.notificationIds]
      );
    }
    for (const modelVersionId of tracker.modelVersionIdsCreated) {
      await client.query(
        `DELETE FROM model_versions mv
         WHERE mv.id = $1
           AND NOT EXISTS (
             SELECT 1 FROM prediction_runs pr WHERE pr.model_version_id = mv.id
           )`,
        [modelVersionId]
      );
    }

    await client.query('COMMIT');
    return verifyCleanup(client, tracker);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function exactCleanupIdsMatch(createdIds, deletedIds) {
  const created = [...new Set((createdIds || []).map(String))].sort();
  const deleted = [...new Set((deletedIds || []).map(String))].sort();
  return created.length === deleted.length
    && created.every((value, index) => value === deleted[index]);
}

async function runSmoke() {
  validateSmokeEnvironment(process.env);
  const target = validateDatabaseUrl(process.env.DATABASE_URL);
  const smokeRunId = crypto.randomUUID();
  const tracker = createFixtureTracker(smokeRunId);
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 3,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: true,
    application_name: 'aura_workers_staging_smoke',
  });

  let idlePoolError = null;
  pool.on('error', (err) => {
    idlePoolError = err;
    console.error(JSON.stringify({
      level: 'error',
      event: 'aura_workers_staging_smoke_pool_error',
      code: safeErrorCode(err),
    }));
  });

  let lockClient = null;
  let lockAcquired = false;
  let providerGuard = null;
  let primaryError = null;
  let cleanupError = null;
  let cleanupVerified = false;
  let allWorkerChecksPassed = false;

  try {
    lockClient = await pool.connect();
    const lock = await lockClient.query(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
      [SMOKE_LOCK_NAME]
    );
    lockAcquired = Boolean(lock.rows[0]?.locked);
    if (!lockAcquired) {
      throw createSmokeError('Ya existe otro smoke de workers en ejecucion', 'AURA_SMOKE_ALREADY_RUNNING');
    }

    const identity = await pool.query(
      `SELECT current_database() AS database_name,
              current_setting('transaction_read_only') AS transaction_read_only`
    );
    if (String(identity.rows[0]?.database_name || '').toLowerCase() !== target.database) {
      throw createSmokeError('La base conectada no coincide con DATABASE_URL', 'AURA_SMOKE_DATABASE_MISMATCH');
    }
    if (String(identity.rows[0]?.transaction_read_only) === 'on') {
      throw createSmokeError('La rama staging esta en modo read-only', 'AURA_SMOKE_DATABASE_READ_ONLY');
    }

    const context = await selectFixtureContext(pool);
    tracker.ownerAdminId = context.ownerAdminId;
    process.env.CLOUDINARY_CLOUD_NAME = context.cloudName;
    process.env.AURA_IMAGE_MAX_JOBS_PER_DAY = '500';

    installDatabaseModule(pool);
    providerGuard = installRealProviderGuard();
    const services = loadOneShotServices();
    if (
      !services.imageJobs.imageJobDedupeKey
      || !services.forecasting.forecastJobDedupeKey
    ) {
      throw createSmokeError('Servicios one-shot incompletos', 'AURA_SMOKE_SERVICE_CONTRACT_INVALID');
    }

    await runNotificationSmoke(pool, services, tracker, providerGuard);
    await runImageSmoke(pool, services, tracker, context, providerGuard);
    await runForecastSmoke(pool, services, tracker, context, providerGuard);
    if (idlePoolError) throw idlePoolError;
    providerGuard.assertUnused();
    allWorkerChecksPassed = true;
  } catch (err) {
    primaryError = err;
  } finally {
    if (tracker.ownerAdminId) {
      try {
        cleanupVerified = await cleanupSmokeFixtures(pool, tracker);
        if (!cleanupVerified) {
          throw createSmokeError('Persisten fixtures del smoke', 'AURA_SMOKE_CLEANUP_INCOMPLETE');
        }
        console.log(MARKERS.cleaned);
      } catch (err) {
        cleanupError = err;
      }
    }

    if (providerGuard) providerGuard.restore();
    if (lockClient) {
      if (lockAcquired) {
        await lockClient.query(
          'SELECT pg_advisory_unlock(hashtext($1))',
          [SMOKE_LOCK_NAME]
        ).catch(() => {});
      }
      lockClient.release();
    }
    await pool.end().catch(() => {});
  }

  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  if (!allWorkerChecksPassed || !cleanupVerified) {
    throw createSmokeError('El smoke no completo todos los postchecks', 'AURA_SMOKE_INCOMPLETE');
  }
  console.log(MARKERS.complete);
}

module.exports = {
  MARKERS,
  validateSmokeEnvironment,
  validateDatabaseUrl,
  createFixtureTracker,
  deriveFeatureDate,
  isQuietHoursAt,
  assertNoForeignEligible,
  assertNotificationOutcome,
  assertImageOutcome,
  assertForecastOutcome,
  cleanupSmokeFixtures,
  exactCleanupIdsMatch,
  sanitizePostgresError,
  runSmoke,
};

if (require.main === module) {
  runSmoke().catch((err) => {
    console.error(JSON.stringify({
      level: 'error',
      event: 'aura_workers_staging_smoke_failed',
      ...sanitizePostgresError(err),
    }));
    process.exitCode = 1;
  });
}
