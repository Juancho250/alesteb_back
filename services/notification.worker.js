// services/notification.worker.js
'use strict';

const cron                  = require('node-cron');
const notificationService   = require('./notification.service');
const db                    = require('../config/db');
const { sendCreditReminderEmail } = require('../config/emailConfig');

// ── Recordatorios de cuotas de crédito ───────────────────────────────────────

async function checkCreditInstallments() {
  const today  = new Date().toISOString().slice(0, 10);
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() + 2);
  const upcoming = cutoff.toISOString().slice(0, 10);

  // Fetch installments that need some notification action today
  const { rows } = await db.query(
    `SELECT
       cps.id, cps.sale_id, cps.owner_admin_id, cps.installment_num,
       cps.due_date, cps.expected_amount,
       cps.upcoming_notified_at, cps.due_notified_at, cps.overdue_notified_at,
       s.sale_number, s.customer_id,
       u.name AS customer_name, u.email AS customer_email,
       (SELECT COUNT(*) FROM credit_payment_schedule WHERE sale_id = cps.sale_id) AS total_installments
     FROM credit_payment_schedule cps
     JOIN sales s   ON s.id = cps.sale_id
     JOIN users u   ON u.id = s.customer_id
     WHERE cps.status = 'pending'
       AND (
         (cps.due_date <= $1 AND cps.overdue_notified_at IS NULL)      -- overdue
         OR (cps.due_date = $2 AND cps.due_notified_at IS NULL)         -- due today
         OR (cps.due_date BETWEEN $2 AND $3 AND cps.upcoming_notified_at IS NULL) -- upcoming 2 days
       )`,
    [today, today, upcoming]
  );

  if (!rows.length) return;

  console.log(`[CreditReminderWorker] Procesando ${rows.length} cuota(s)...`);

  for (const inst of rows) {
    const isOverdue  = inst.due_date < today;
    const isDue      = inst.due_date === today;
    const isUpcoming = !isOverdue && !isDue;

    const type = isOverdue ? 'overdue' : isDue ? 'due' : 'upcoming';
    const templateKey = `credit_${type}`;

    const daysOverdue = isOverdue
      ? Math.round((new Date(today) - new Date(inst.due_date)) / 86400000)
      : 0;

    const fmtAmt  = Number(inst.expected_amount).toLocaleString('es-CO', { maximumFractionDigits: 0 });
    const fmtDate = new Date(inst.due_date + 'T00:00:00').toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' });

    const payload = {
      customer_name:      inst.customer_name,
      amount:             fmtAmt,
      due_date:           fmtDate,
      installment_num:    inst.installment_num,
      total_installments: inst.total_installments,
      sale_number:        inst.sale_number,
      days_overdue:       daysOverdue,
    };

    // 1. Email al cliente (si tiene email) — llamada directa a Brevo
    if (inst.customer_email) {
      try {
        await sendCreditReminderEmail(
          inst.customer_email,
          inst.customer_name,
          {
            saleNumber:        inst.sale_number,
            installmentNum:    inst.installment_num,
            totalInstallments: Number(inst.total_installments),
            amount:            inst.expected_amount,
            dueDate:           inst.due_date,
            daysOverdue,
          },
          type
        );
      } catch (err) {
        console.error(`[CreditReminderWorker] Email falló para cuota ${inst.id}:`, err.message);
      }
    }

    // 2. WhatsApp al admin — a través de notification_queue
    try {
      await notificationService.enqueueNotification({
        ownerAdminId:  inst.owner_admin_id,
        recipientUserId: null,
        event:         'credit_reminder',
        channel:       'whatsapp',
        payload,
        templateKey,
        referenceType: 'credit_payment_schedule',
        referenceId:   inst.id,
      });
    } catch (err) {
      console.error(`[CreditReminderWorker] WhatsApp falló para cuota ${inst.id}:`, err.message);
    }

    // 3. Marcar notificación enviada en la cuota (evita re-envíos)
    const column = isOverdue ? 'overdue_notified_at'
                 : isDue     ? 'due_notified_at'
                 :             'upcoming_notified_at';
    await db.query(
      `UPDATE credit_payment_schedule SET ${column} = NOW() WHERE id = $1`,
      [inst.id]
    );
  }

  console.log(`[CreditReminderWorker] ✅ ${rows.length} cuota(s) procesada(s)`);
}

// ── Inicio del worker ─────────────────────────────────────────────────────────

function startNotificationWorker() {
  // Cola de notificaciones salientes — cada 30 segundos
  cron.schedule('*/30 * * * * *', async () => {
    try {
      const { processed } = await notificationService.processQueueBatch(20);
      if (processed > 0) {
        console.log(`[NotificationWorker] ${processed} notificación(es) procesada(s)`);
      }
    } catch (err) {
      console.error('[NotificationWorker] Error:', err.message);
    }
  });

  // Recordatorios diarios de cuotas de crédito — 8am hora Colombia
  cron.schedule('0 8 * * *', async () => {
    try {
      await checkCreditInstallments();
    } catch (err) {
      console.error('[CreditReminderWorker] Error:', err.message);
    }
  }, { timezone: 'America/Bogota' });

  console.log('[NotificationWorker] ✅ Worker de notificaciones registrado (cada 30s)');
  console.log('[CreditReminderWorker] ✅ Recordatorios de cuotas registrado (08:00 Bogotá)');
}

module.exports = { startNotificationWorker };
