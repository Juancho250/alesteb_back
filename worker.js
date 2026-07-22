require("dotenv/config");
require("./config/env")();

const db = require("./src/platform/database");
const { startSubscriptionCron } = require("./src/modules/subscriptions/subscription.cron");
const { startInventoryJobs } = require("./src/modules/inventory").jobs;
const { startNotificationWorker } = require("./src/modules/notifications").worker;
const { startAuraPredictiveJobs } = require("./services/auraPredictive.jobs");

// notificationScheduler registra sus tareas al cargar el módulo.
const workerHandles = [];
if (String(process.env.LEGACY_NOTIFICATION_SCHEDULER_ENABLED || "false").toLowerCase() === "true") {
  // Deprecated side-effect scheduler. Keep disabled until it has lifecycle controls.
  require("./src/modules/notifications/legacy-scheduler");
}
for (const handle of [
  startSubscriptionCron(),
  startInventoryJobs(),
  startNotificationWorker(),
  startAuraPredictiveJobs(),
]) {
  if (handle && typeof handle.stop === "function") workerHandles.push(handle);
}

console.log(JSON.stringify({
  level: "info",
  event: "background_worker_started",
  services: [
    "notification_scheduler",
    "subscription_cron",
    "inventory_jobs",
    "notification_worker",
    "aura_predictive_jobs",
  ],
}));

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ level: "info", event: "background_worker_stopping", signal }));
  for (const handle of workerHandles) {
    try {
      await handle.stop();
    } catch (err) {
      console.error(JSON.stringify({
        level: "error",
        event: "background_worker_stop_failed",
        errorCode: String(err.code || "WORKER_STOP_ERROR").slice(0, 80),
      }));
    }
  }
  await db.end().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
