'use strict';

const brevo = require('@getbrevo/brevo');
const db = require('../../platform/database');
const whatsappProvider = require('./providers/whatsapp.provider');
const { sendPushToOne } = require('./push.service');
const { prepareCampaignRecipients } = require('../aura/growth/campaigns.service');

const DIRECT_CHANNELS = new Set(['email', 'whatsapp', 'push']);

function createOutboxError(message, code = 'NOTIFICATION_OUTBOX_ERROR', status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function notificationMockEnabled() {
  const safeEnv = ['test', 'development'].includes(String(process.env.NODE_ENV || '').toLowerCase())
    || String(process.env.AURA_STAGING_MODE || 'false').toLowerCase() === 'true';
  return safeEnv && String(process.env.AURA_NOTIFICATION_MOCK_PROVIDER_ENABLED || 'false').toLowerCase() === 'true';
}

function _render(template, payload) {
  if (!template) return '';
  return String(template).replace(/\{\{(\w+)\}\}/g, (_, key) => String(payload?.[key] ?? ''));
}

async function getNotificationSettings(ownerAdminId) {
  const { rows } = await db.query(
    `SELECT *
     FROM notification_settings
     WHERE admin_id = $1`,
    [ownerAdminId]
  );
  return rows[0] || {
    admin_id: ownerAdminId,
    whatsapp_enabled: false,
    email_enabled: false,
    push_enabled: false,
    whatsapp_country_code: '+57',
    timezone: 'America/Bogota',
  };
}

function isQuietHours(settings) {
  if (!settings.quiet_hours_start || !settings.quiet_hours_end) return false;
  const tz = settings.timezone || 'America/Bogota';
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
  const [hh, mm] = timeStr.split(':').map(Number);
  const cur = hh * 60 + mm;
  const [sh, sm] = String(settings.quiet_hours_start).split(':').map(Number);
  const [eh, em] = String(settings.quiet_hours_end).split(':').map(Number);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  return start <= end ? (cur >= start && cur < end) : (cur >= start || cur < end);
}

function nextRunAfterQuiet(settings) {
  const tz = settings.timezone || 'America/Bogota';
  const [eh, em] = String(settings.quiet_hours_end || '08:00').split(':').map(Number);
  const localNow = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  const next = new Date(localNow);
  next.setHours(eh, em, 0, 0);
  if (next <= localNow) next.setDate(next.getDate() + 1);
  return next;
}

function backoffDate(attempts) {
  const minutes = Math.min(60, Math.max(1, 2 ** Math.max(Number(attempts || 1) - 1)));
  return new Date(Date.now() + minutes * 60_000);
}

function redactError(err) {
  return {
    code: String(err.code || 'NOTIFICATION_SEND_ERROR').slice(0, 80),
    message: String(err.status && err.status < 500 ? err.message : 'Error externo enviando notificacion').slice(0, 500),
  };
}

function brevoClient() {
  if (!process.env.BREVO_API_KEY) {
    throw createOutboxError('BREVO_API_KEY no configurada', 'BREVO_NOT_CONFIGURED', 503);
  }
  const apiInstance = new brevo.TransactionalEmailsApi();
  apiInstance.setApiKey(
    brevo.TransactionalEmailsApiApiKeys.apiKey,
    process.env.BREVO_API_KEY
  );
  return { apiInstance, SendSmtpEmail: brevo.SendSmtpEmail };
}

async function sendEmail({ email, name, subject, html }) {
  const { apiInstance, SendSmtpEmail } = brevoClient();
  const mail = new SendSmtpEmail();
  mail.subject = subject || 'ALESTEB';
  mail.to = [{ email, name: name || 'Cliente' }];
  mail.sender = {
    name: process.env.BREVO_SENDER_NAME || 'Alesteb',
    email: process.env.BREVO_SENDER_EMAIL || 'softturin@gmail.com',
  };
  mail.htmlContent = html || '';
  const data = await apiInstance.sendTransacEmail(mail);
  return { success: true, providerMessageId: data?.body?.messageId || data?.messageId || null };
}

async function resolveRecipient(job) {
  const ownerAdminId = Number(job.owner_admin_id);
  const recipientUserId = job.recipient_user_id ? Number(job.recipient_user_id) : null;

  if (!recipientUserId) {
    return {
      userId: null,
      email: job.recipient_email || null,
      phone: job.recipient_phone || null,
      name: null,
      legacyDirectRecipient: true,
    };
  }

  const { rows } = await db.query(
    `SELECT id, name, email, phone
     FROM users
     WHERE id = $1
       AND owner_admin_id = $2
       AND COALESCE(is_active, true) = true
     LIMIT 1`,
    [recipientUserId, ownerAdminId]
  );

  if (!rows.length) {
    throw createOutboxError('Destinatario no encontrado para este tenant', 'RECIPIENT_NOT_FOUND', 404);
  }
  return {
    userId: Number(rows[0].id),
    name: rows[0].name || null,
    email: rows[0].email || null,
    phone: rows[0].phone || null,
    legacyDirectRecipient: false,
  };
}

async function assertCampaignConsent(job, recipient) {
  if (!job.campaign_id || !recipient.userId) return true;
  const { rows } = await db.query(
    `SELECT status
     FROM customer_consents
     WHERE owner_admin_id = $1
       AND user_id = $2
       AND channel = $3
     LIMIT 1`,
    [job.owner_admin_id, recipient.userId, job.channel]
  );
  if (rows[0]?.status !== 'granted') {
    throw createOutboxError('Consentimiento no vigente u opt-out activo', 'CONSENT_NOT_GRANTED', 403);
  }
  return true;
}

async function sendPush(job, recipient, payload) {
  if (!recipient.userId) {
    throw createOutboxError('Push requiere destinatario autenticado', 'PUSH_RECIPIENT_REQUIRED', 422);
  }
  const { rows } = await db.query(
    `SELECT ps.endpoint, ps.p256dh, ps.auth
     FROM push_subscriptions ps
     JOIN users u ON u.id = ps.user_id
     WHERE ps.user_id = $1
       AND u.owner_admin_id = $2
       AND COALESCE(ps.is_active, true) = true`,
    [recipient.userId, job.owner_admin_id]
  );
  if (!rows.length) {
    throw createOutboxError('Sin suscripciones push activas', 'PUSH_SUBSCRIPTION_NOT_FOUND', 422);
  }

  const results = await Promise.allSettled(rows.map((row) => sendPushToOne({
    endpoint: row.endpoint,
    keys: { p256dh: row.p256dh, auth: row.auth },
  }, payload)));

  const expired = results
    .filter((r) => r.status === 'fulfilled' && r.value?.expired)
    .map((r) => r.value.endpoint);
  if (expired.length) {
    await db.query(
      `UPDATE push_subscriptions
       SET is_active = false
       WHERE endpoint = ANY($1::text[])`,
      [expired]
    );
  }

  const sent = results.filter((r) => r.status === 'fulfilled' && r.value?.ok).length;
  if (!sent) {
    throw createOutboxError('No se pudo enviar push', 'PUSH_SEND_FAILED', 502);
  }
  return { success: true, providerMessageId: null, sentCount: sent };
}

async function sendByChannel(job, recipient) {
  const payload = job.payload || {};
  const renderedMessage = job.rendered_message || payload.body || payload.message || '';
  const renderedSubject = job.rendered_subject || payload.headline || payload.subject || 'ALESTEB';

  if (notificationMockEnabled()) {
    return {
      success: true,
      providerMessageId: `mock:${job.channel}:${job.id}`,
      mock: true,
    };
  }

  if (job.channel === 'email') {
    if (!recipient.email) throw createOutboxError('Email de destinatario faltante', 'EMAIL_RECIPIENT_MISSING', 422);
    return sendEmail({
      email: recipient.email,
      name: recipient.name,
      subject: renderedSubject,
      html: renderedMessage,
    });
  }

  if (job.channel === 'whatsapp') {
    if (!recipient.phone) throw createOutboxError('Telefono WhatsApp faltante', 'WHATSAPP_RECIPIENT_MISSING', 422);
    const requireTemplate = String(process.env.WHATSAPP_REQUIRE_TEMPLATES || 'true').toLowerCase() !== 'false';
    if (payload.whatsappTemplateName) {
      return whatsappProvider.sendTemplate(
        recipient.phone,
        payload.whatsappTemplateName,
        payload.whatsappTemplateComponents || [],
        payload.whatsappLanguageCode || 'es_CO'
      );
    }
    if (job.campaign_id && requireTemplate) {
      throw createOutboxError('WhatsApp de campana requiere template aprobado', 'WHATSAPP_TEMPLATE_REQUIRED', 422);
    }
    return whatsappProvider.send(recipient.phone, renderedMessage, payload.countryCode || '57');
  }

  if (job.channel === 'push') {
    return sendPush(job, recipient, {
      title: renderedSubject,
      body: renderedMessage,
      icon: payload.icon || '/icon-192.png',
      badge: payload.badge || '/badge-72.png',
      url: payload.url || '/',
      tag: payload.tag || `campaign-${job.campaign_id || job.id}`,
      type: payload.type || 'campaign',
      severity: payload.severity || 'info',
    });
  }

  throw createOutboxError('Canal no soportado', 'NOTIFICATION_CHANNEL_NOT_SUPPORTED', 400);
}

function normalizeNotificationClaimScope(scope = {}) {
  const hasOwner = scope.ownerAdminId !== undefined && scope.ownerAdminId !== null;
  const hasNotification = scope.notificationId !== undefined && scope.notificationId !== null;
  if (!hasOwner && !hasNotification) return null;
  if (!hasOwner || !hasNotification) {
    throw createOutboxError(
      'Un claim acotado requiere ownerAdminId y notificationId',
      'NOTIFICATION_CLAIM_SCOPE_INCOMPLETE',
      500
    );
  }

  const ownerAdminId = Number(scope.ownerAdminId);
  const notificationId = String(scope.notificationId);
  if (!Number.isSafeInteger(ownerAdminId) || ownerAdminId <= 0 || !/^\d+$/.test(notificationId)) {
    throw createOutboxError(
      'Alcance de claim invalido',
      'NOTIFICATION_CLAIM_SCOPE_INVALID',
      500
    );
  }
  return { ownerAdminId, notificationId };
}

async function claimNotificationJobs(
  limit = 20,
  workerId = `notification-worker:${process.pid}`,
  claimScope = {}
) {
  const scope = normalizeNotificationClaimScope(claimScope);
  const params = [limit, workerId];
  let scopeSql = '';
  if (scope) {
    params.push(scope.ownerAdminId, scope.notificationId);
    scopeSql = `
         AND owner_admin_id = $3
         AND id = $4`;
  }

  const { rows } = await db.query(
    `WITH next_jobs AS (
       SELECT id
       FROM notification_queue
       WHERE status = 'pending'
         AND available_at <= NOW()
         AND scheduled_for <= NOW()
         AND attempts < max_attempts
         ${scopeSql}
       ORDER BY available_at ASC, scheduled_for ASC, created_at ASC, id ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE notification_queue nq
     SET status = 'sending',
         attempts = COALESCE(nq.attempts, 0) + 1,
         locked_at = NOW(),
         locked_by = $2,
         updated_at = NOW()
     FROM next_jobs
     WHERE nq.id = next_jobs.id
     RETURNING nq.*`,
    params
  );
  return rows;
}

async function rescheduleForQuietHours(job, settings) {
  const nextRun = nextRunAfterQuiet(settings);
  await db.query(
    `UPDATE notification_queue
     SET status = 'pending',
         attempts = GREATEST(COALESCE(attempts, 1) - 1, 0),
         available_at = $1,
         scheduled_for = $1,
         locked_at = NULL,
         locked_by = NULL,
         updated_at = NOW()
     WHERE id = $2`,
    [nextRun, job.id]
  );
}

async function markNotificationSent(job, result) {
  const { rows } = await db.query(
    `UPDATE notification_queue
     SET status = 'sent',
         provider_message_id = COALESCE($1, provider_message_id),
         sent_at = COALESCE(sent_at, NOW()),
         locked_at = NULL,
         locked_by = NULL,
         updated_at = NOW()
     WHERE id = $2
     RETURNING owner_admin_id, campaign_id, recipient_user_id`,
    [result.providerMessageId || null, job.id]
  );
  const sent = rows[0];
  if (sent?.campaign_id && sent.recipient_user_id) {
    await db.query(
      `WITH recipient AS (
       UPDATE campaign_recipients
         SET status = 'sent', updated_at = NOW()
         WHERE owner_admin_id = $1
           AND campaign_id = $2
           AND recipient_user_id = $3
           AND channel = $4
       )
       INSERT INTO campaign_events
         (campaign_id, owner_admin_id, recipient_user_id, event_type, external_event_id, occurred_at, metadata)
       VALUES ($2, $1, $3, 'sent', $5, NOW(), $6::jsonb)
       ON CONFLICT DO NOTHING`,
      [
        sent.owner_admin_id,
        sent.campaign_id,
        sent.recipient_user_id,
        job.channel,
        `queue:${job.id}:sent`,
        JSON.stringify({ queueId: job.id, provider: job.channel, mock: Boolean(result.mock) }),
      ]
    );
  }
}

async function markNotificationFailed(job, err) {
  const safe = redactError(err);
  const attempts = Number(job.attempts || 1);
  const maxAttempts = Number(job.max_attempts || 3);
  const terminal = err.status && err.status < 500 ? true : attempts >= maxAttempts;
  const { rows } = await db.query(
    `UPDATE notification_queue
     SET status = $1,
         error = $2,
         last_error = $2,
         failed_at = CASE WHEN $1 = 'failed' THEN NOW() ELSE failed_at END,
         available_at = CASE WHEN $1 = 'pending' THEN $3 ELSE available_at END,
         scheduled_for = CASE WHEN $1 = 'pending' THEN $3 ELSE scheduled_for END,
         locked_at = NULL,
         locked_by = NULL,
         updated_at = NOW()
     WHERE id = $4
     RETURNING owner_admin_id, campaign_id, recipient_user_id, status`,
    [terminal ? 'failed' : 'pending', safe.message, terminal ? null : backoffDate(attempts), job.id]
  );
  const failed = rows[0];
  if (failed?.status === 'failed' && failed.campaign_id && failed.recipient_user_id) {
    await db.query(
      `WITH recipient AS (
         UPDATE campaign_recipients
         SET status = 'failed', updated_at = NOW()
         WHERE owner_admin_id = $1
           AND campaign_id = $2
           AND recipient_user_id = $3
           AND channel = $4
           AND status != 'sent'
       )
       INSERT INTO campaign_events
         (campaign_id, owner_admin_id, recipient_user_id, event_type, external_event_id, occurred_at, metadata)
       VALUES ($2, $1, $3, 'failed', $5, NOW(), $6::jsonb)
       ON CONFLICT DO NOTHING`,
      [
        failed.owner_admin_id,
        failed.campaign_id,
        failed.recipient_user_id,
        job.channel,
        `queue:${job.id}:failed`,
        JSON.stringify({ queueId: job.id, errorCode: safe.code }),
      ]
    );
  }
  return safe;
}

async function recoverStaleNotificationJobs(staleMinutes = Number(process.env.AURA_NOTIFICATION_STALE_JOB_MINUTES || 15)) {
  const minutes = Number.isFinite(Number(staleMinutes))
    ? Math.min(Math.max(Number(staleMinutes), 5), 1440)
    : 15;
  const { rows } = await db.query(
    `UPDATE notification_queue
     SET status = 'failed',
         error = 'Claim abandonado; requiere revision antes de reintentar',
         last_error = 'Claim abandonado; requiere revision antes de reintentar',
         failed_at = COALESCE(failed_at, NOW()),
         locked_at = NULL,
         locked_by = NULL,
         updated_at = NOW()
     WHERE status = 'sending'
       AND locked_at < NOW() - ($1::int * INTERVAL '1 minute')
     RETURNING id`,
    [minutes]
  );
  return { recovered: rows.length, strategy: 'quarantine_for_manual_review' };
}

async function processNotificationOutboxBatch(
  limit = 20,
  workerId = `notification-worker:${process.pid}`,
  claimScope = {}
) {
  const jobs = await claimNotificationJobs(limit, workerId, claimScope);
  if (!jobs.length) return { processed: 0 };

  let processed = 0;
  for (const job of jobs) {
    try {
      const settings = await getNotificationSettings(job.owner_admin_id);
      if (isQuietHours(settings)) {
        await rescheduleForQuietHours(job, settings);
        continue;
      }

      if (job.channel === 'whatsapp' && !settings.whatsapp_enabled && job.campaign_id) {
        throw createOutboxError('WhatsApp no esta habilitado para el tenant', 'WHATSAPP_DISABLED', 403);
      }
      if (job.channel === 'email' && !settings.email_enabled && job.campaign_id) {
        throw createOutboxError('Email no esta habilitado para el tenant', 'EMAIL_DISABLED', 403);
      }
      if (job.channel === 'push' && !settings.push_enabled && job.campaign_id) {
        throw createOutboxError('Push no esta habilitado para el tenant', 'PUSH_DISABLED', 403);
      }

      const recipient = await resolveRecipient(job);
      await assertCampaignConsent(job, recipient);
      const result = await sendByChannel(job, recipient);
      if (!result?.success) {
        throw createOutboxError(result?.error || 'Proveedor no envio la notificacion', 'PROVIDER_SEND_FAILED', 502);
      }
      await markNotificationSent(job, result);
      processed++;
    } catch (err) {
      await markNotificationFailed(job, err);
      processed++;
    }
  }

  return { processed };
}

async function enqueueCampaignDelivery(client, { ownerAdminId, campaignId, actionId, payload = {}, approvedBy }) {
  const { rows: campaignRows } = await client.query(
    `SELECT mc.id, mc.channel, mc.status, mc.scheduled_at,
            cc.headline, cc.body, cc.call_to_action
     FROM marketing_campaigns mc
     LEFT JOIN LATERAL (
       SELECT headline, body, call_to_action
       FROM campaign_contents
       WHERE campaign_id = mc.id
         AND channel = mc.channel
       ORDER BY version DESC, created_at DESC
       LIMIT 1
     ) cc ON true
     WHERE mc.owner_admin_id = $1
       AND mc.id = $2
     LIMIT 1`,
    [ownerAdminId, campaignId]
  );
  const campaign = campaignRows[0];
  if (!campaign) throw createOutboxError('Campana no encontrada', 'CAMPAIGN_NOT_FOUND', 404);
  if (!['approved', 'scheduled'].includes(campaign.status)) {
    throw createOutboxError(
      'La campana requiere aprobacion humana antes de encolar',
      'CAMPAIGN_APPROVAL_REQUIRED',
      409
    );
  }
  if (!DIRECT_CHANNELS.has(campaign.channel)) {
    throw createOutboxError('Instagram y TikTok solo son exportables en esta version', 'EXPORT_ONLY_CHANNEL', 409);
  }
  if (campaign.channel === 'whatsapp' && !payload.whatsappTemplateName) {
    throw createOutboxError('WhatsApp de campana requiere template aprobado', 'WHATSAPP_TEMPLATE_REQUIRED', 422);
  }

  const renderedSubject = campaign.headline || payload.headline || 'ALESTEB';
  const renderedMessage = campaign.body || payload.body || '';
  if (!renderedMessage) {
    throw createOutboxError('La campana no tiene contenido para enviar', 'CAMPAIGN_CONTENT_REQUIRED', 422);
  }

  const preparation = await prepareCampaignRecipients({
    client,
    ownerAdminId,
    userId: approvedBy,
    roles: ['admin'],
    campaignId,
  });

  const queuePayload = {
    ...payload,
    actionId,
    callToAction: campaign.call_to_action || payload.callToAction || null,
    url: payload.url || '/shop',
    type: 'aura_campaign',
  };

  const { rows } = await client.query(
    `WITH eligible AS (
       SELECT DISTINCT cr.recipient_user_id
       FROM campaign_recipients cr
       JOIN users u
         ON u.id = cr.recipient_user_id
        AND u.owner_admin_id = $1
        AND COALESCE(u.is_active, true) = true
       JOIN customer_consents consent
         ON consent.owner_admin_id = $1
        AND consent.user_id = cr.recipient_user_id
        AND consent.channel = $3
        AND consent.status = 'granted'
       WHERE cr.owner_admin_id = $1
         AND cr.campaign_id = $2
         AND cr.channel = $3
         AND cr.status IN ('ready', 'eligible')
     )
     INSERT INTO notification_queue
       (owner_admin_id, campaign_id, recipient_user_id, recipient, channel, payload,
        dedupe_key, status, attempts, max_attempts, available_at, scheduled_for,
        event, template_key, rendered_subject, rendered_message,
        reference_type, reference_id, created_at, updated_at)
     SELECT
       $1, $2, e.recipient_user_id,
       jsonb_build_object('userId', e.recipient_user_id),
       $3, $4::jsonb,
       CONCAT('campaign:', $2::text, ':', $3, ':', e.recipient_user_id::text),
       'pending', 0, 3, COALESCE($5::timestamptz, NOW()), COALESCE($5::timestamptz, NOW()),
       'aura_campaign_delivery', 'aura_campaign', $6, $7,
       'marketing_campaigns', NULL, NOW(), NOW()
     FROM eligible e
     ON CONFLICT (owner_admin_id, dedupe_key) DO NOTHING
     RETURNING id, recipient_user_id`,
    [
      ownerAdminId,
      campaignId,
      campaign.channel,
      JSON.stringify(queuePayload),
      payload.availableAt || campaign.scheduled_at || null,
      renderedSubject,
      renderedMessage,
    ]
  );

  if (rows.length) {
    await client.query(
      `INSERT INTO campaign_events
         (campaign_id, owner_admin_id, recipient_user_id, event_type, external_event_id, occurred_at, metadata)
       SELECT
         $1, $2, nq.recipient_user_id, 'queued', CONCAT('queue:', nq.id::text, ':queued'), NOW(),
         jsonb_build_object('queueId', nq.id, 'actionId', $4::text)
       FROM notification_queue nq
       WHERE nq.owner_admin_id = $2
         AND nq.campaign_id = $1
         AND nq.id = ANY($3::bigint[])
       ON CONFLICT DO NOTHING`,
      [campaignId, ownerAdminId, rows.map((row) => row.id), actionId]
    );
  }

  return {
    enqueued: rows.length,
    channel: campaign.channel,
    approvedBy,
    preparation,
  };
}

async function updateProviderStatusByMessageId(providerMessageId, status, metadata = {}) {
  if (!providerMessageId) return { updated: 0 };
  const allowedStatuses = new Set(['sent', 'delivered', 'read', 'clicked', 'failed']);
  if (!allowedStatuses.has(status)) {
    throw createOutboxError('Estado de proveedor no permitido', 'PROVIDER_STATUS_NOT_ALLOWED', 400);
  }
  const timestampColumn = {
    sent: 'sent_at',
    delivered: 'delivered_at',
    read: 'read_at',
    clicked: 'clicked_at',
    failed: 'failed_at',
  }[status] || 'updated_at';

  const safeMetadata = {
    providerEventId: metadata.providerEventId || metadata.eventId || null,
    providerStatus: status,
    occurredAt: metadata.occurredAt || null,
    errorCode: metadata.errorCode || null,
  };
  const { rows } = await db.query(
    `WITH updated AS (
       UPDATE notification_queue
       SET status = $1,
           ${timestampColumn} = NOW(),
           payload = COALESCE(payload, '{}'::jsonb) || $2::jsonb,
           updated_at = NOW()
       WHERE provider_message_id = $3
         AND status != 'failed'
       RETURNING id, owner_admin_id, campaign_id, recipient_user_id
     ),
     events AS (
       INSERT INTO campaign_events
         (campaign_id, owner_admin_id, recipient_user_id, event_type, external_event_id, occurred_at, metadata)
       SELECT
         u.campaign_id, u.owner_admin_id, u.recipient_user_id, $1,
         COALESCE($4, CONCAT('provider:', $3, ':', $1)), NOW(), $2::jsonb
       FROM updated u
       WHERE u.campaign_id IS NOT NULL
         AND u.recipient_user_id IS NOT NULL
       ON CONFLICT DO NOTHING
     )
     SELECT id FROM updated`,
    [
      status,
      JSON.stringify({ providerStatus: safeMetadata }),
      providerMessageId,
      safeMetadata.providerEventId,
    ]
  );
  return { updated: rows.length };
}

module.exports = {
  DIRECT_CHANNELS,
  createOutboxError,
  getNotificationSettings,
  isQuietHours,
  nextRunAfterQuiet,
  notificationMockEnabled,
  normalizeNotificationClaimScope,
  claimNotificationJobs,
  recoverStaleNotificationJobs,
  processNotificationOutboxBatch,
  enqueueCampaignDelivery,
  updateProviderStatusByMessageId,
};
