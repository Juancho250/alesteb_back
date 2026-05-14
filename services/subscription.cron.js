// services/subscription.cron.js
const cron = require('node-cron');
const subscriptionService = require('./subscription.service');
const db = require('../config/db');

// ─────────────────────────────────────────────────────────────────
// OPCIONAL: descomenta e importa tu módulo de email real
// const { sendEmail } = require('./email.service');
// const { sendPushToAdmin } = require('./notificationScheduler');
// ─────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────
// ARRANQUE DE TODOS LOS CRON JOBS DE SUSCRIPCIONES
// Llama a esta función una sola vez desde app.js / server.js
// ─────────────────────────────────────────────────────────────────
function startSubscriptionCron() {

  // ── 1. Procesar vencimientos: cada día a las 00:05 ──────────────
  cron.schedule('5 0 * * *', async () => {
    console.log('[SubscriptionCron] ▶ Procesando vencimientos...');
    try {
      const result = await subscriptionService.processExpiredSubscriptions();
      console.log('[SubscriptionCron] Resultado vencimientos:', result);
    } catch (err) {
      console.error('[SubscriptionCron] processExpiredSubscriptions error:', err.message);
    }
  });

  // ── 2. Notificaciones: cada día a las 09:00 ─────────────────────
  cron.schedule('0 9 * * *', async () => {
    console.log('[SubscriptionCron] ▶ Enviando notificaciones...');
    await runSafely('notifyTrialExpiring',  notifyTrialExpiring);
    await runSafely('notifyGraceExpiring',  notifyGraceExpiring);
    await runSafely('notifyPastDue',        notifyPastDue);
    await runSafely('notifyRenewalReminder', notifyRenewalReminder);
  });

  // ── 3. Sincronizar contadores de uso: cada hora en el minuto 30 ─
  cron.schedule('30 * * * *', async () => {
    try {
      const { rows } = await db.query(
        `SELECT DISTINCT admin_id
         FROM subscriptions
         WHERE status IN ('trial', 'active', 'past_due')`
      );

      // Procesar en lotes de 10 para no saturar la DB
      const BATCH_SIZE = 10;
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        await Promise.allSettled(
          batch.map(r => subscriptionService.syncUsage(r.admin_id))
        );
      }

      console.log(`[SubscriptionCron] ✔ Usage synced for ${rows.length} admins`);
    } catch (err) {
      console.error('[SubscriptionCron] syncUsage error:', err.message);
    }
  });

  console.log('[SubscriptionCron] ✔ Cron jobs de suscripciones iniciados');
}

// ─────────────────────────────────────────────────────────────────
// HELPER: ejecuta una función de notificación sin romper el flujo
// ─────────────────────────────────────────────────────────────────
async function runSafely(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`[SubscriptionCron] ${label} error:`, err.message);
  }
}

// ─────────────────────────────────────────────────────────────────
// NOTIFICACIÓN: trial por vencer en los próximos 3 días
// ─────────────────────────────────────────────────────────────────
async function notifyTrialExpiring() {
  const { rows } = await db.query(`
    SELECT
      s.admin_id,
      u.email,
      u.name,
      s.trial_end,
      EXTRACT(DAY FROM s.trial_end::timestamp - now())::int AS days_left,
      sp.name AS plan_name
    FROM subscriptions s
    JOIN users u  ON u.id  = s.admin_id
    JOIN subscription_plans sp ON sp.id = s.plan_id
    WHERE s.status = 'trial'
      AND s.trial_end::date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '3 days'
  `);

  for (const row of rows) {
    console.log(
      `[SubscriptionCron] ⚠ Trial por vencer: ${row.email} | Plan: ${row.plan_name} | ${row.days_left}d restantes`
    );

    // TODO: descomenta cuando tengas email configurado
    // await sendEmail({
    //   to: row.email,
    //   subject: `Tu prueba de ${row.plan_name} vence en ${row.days_left} día(s)`,
    //   template: 'trial_expiring',
    //   data: {
    //     name:      row.name,
    //     plan_name: row.plan_name,
    //     days_left: row.days_left,
    //     trial_end: row.trial_end,
    //   },
    // });
  }
}

// ─────────────────────────────────────────────────────────────────
// NOTIFICACIÓN: período de gracia por expirar (≤ 2 días)
// ─────────────────────────────────────────────────────────────────
async function notifyGraceExpiring() {
  const { rows } = await db.query(`
    SELECT
      s.admin_id,
      u.email,
      u.name,
      s.grace_expires_at,
      EXTRACT(DAY FROM s.grace_expires_at - now())::int AS days_left
    FROM subscriptions s
    JOIN users u ON u.id = s.admin_id
    WHERE s.status = 'past_due'
      AND s.grace_expires_at IS NOT NULL
      AND s.grace_expires_at > now()
      AND s.grace_expires_at <= now() + INTERVAL '2 days'
  `);

  for (const row of rows) {
    console.log(
      `[SubscriptionCron] 🔴 Gracia por expirar: ${row.email} | ${row.days_left}d restantes`
    );

    // TODO: descomenta cuando tengas email configurado
    // await sendEmail({
    //   to: row.email,
    //   subject: 'Tu período de gracia vence pronto — renueva ya',
    //   template: 'grace_expiring',
    //   data: { name: row.name, grace_expires_at: row.grace_expires_at, days_left: row.days_left },
    // });
  }
}

// ─────────────────────────────────────────────────────────────────
// NOTIFICACIÓN: cuentas en past_due (sin acción aún)
// ─────────────────────────────────────────────────────────────────
async function notifyPastDue() {
  // Solo notificar el primer día en past_due para no spamear
  const { rows } = await db.query(`
    SELECT
      s.admin_id,
      u.email,
      u.name,
      s.grace_expires_at,
      sp.name AS plan_name,
      sp.price_monthly
    FROM subscriptions s
    JOIN users u ON u.id = s.admin_id
    JOIN subscription_plans sp ON sp.id = s.plan_id
    WHERE s.status = 'past_due'
      AND s.updated_at::date = CURRENT_DATE
  `);

  for (const row of rows) {
    console.log(`[SubscriptionCron] 💸 Pago pendiente (primer día): ${row.email}`);

    // TODO: descomenta cuando tengas email configurado
    // await sendEmail({
    //   to: row.email,
    //   subject: 'Acción requerida: renueva tu suscripción',
    //   template: 'payment_past_due',
    //   data: {
    //     name:             row.name,
    //     plan_name:        row.plan_name,
    //     price_monthly:    row.price_monthly,
    //     grace_expires_at: row.grace_expires_at,
    //   },
    // });
  }
}

// ─────────────────────────────────────────────────────────────────
// NOTIFICACIÓN: recordatorio de renovación 7 días antes
// ─────────────────────────────────────────────────────────────────
async function notifyRenewalReminder() {
  const { rows } = await db.query(`
    SELECT
      s.admin_id,
      u.email,
      u.name,
      s.current_period_end,
      s.billing_cycle,
      s.amount_due,
      sp.name AS plan_name
    FROM subscriptions s
    JOIN users u ON u.id = s.admin_id
    JOIN subscription_plans sp ON sp.id = s.plan_id
    WHERE s.status = 'active'
      AND s.cancel_at_period_end = false
      AND s.current_period_end::date = CURRENT_DATE + INTERVAL '7 days'
  `);

  for (const row of rows) {
    console.log(
      `[SubscriptionCron] 🔔 Recordatorio renovación: ${row.email} | ${row.plan_name} | vence ${row.current_period_end}`
    );

    // TODO: descomenta cuando tengas email configurado
    // await sendEmail({
    //   to: row.email,
    //   subject: `Tu plan ${row.plan_name} se renueva en 7 días`,
    //   template: 'renewal_reminder',
    //   data: {
    //     name:               row.name,
    //     plan_name:          row.plan_name,
    //     amount_due:         row.amount_due,
    //     billing_cycle:      row.billing_cycle,
    //     current_period_end: row.current_period_end,
    //   },
    // });
  }
}

module.exports = { startSubscriptionCron };