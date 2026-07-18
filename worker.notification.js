require("dotenv/config");
require("./config/env")();

const db = require("./config/db");
const { startNotificationWorker } = require("./services/notification.worker");

const worker = startNotificationWorker();
if (!worker.enabled) {
  db.end().finally(() => process.exit(0));
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ level: "info", event: "notification_worker_stopping", signal }));
  await worker.stop();
  await db.end().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
