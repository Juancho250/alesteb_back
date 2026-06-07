// services/notification.worker.js
'use strict';

const cron                = require('node-cron');
const notificationService = require('./notification.service');

function startNotificationWorker() {
  // Process outbound notification queue every 30 seconds (6-field cron: second-level)
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

  console.log('[NotificationWorker] ✅ Worker de notificaciones registrado (cada 30s)');
}

module.exports = { startNotificationWorker };
