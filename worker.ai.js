require("dotenv/config");
require("./config/env")();

const db = require("./config/db");
const { startAuraImageWorker } = require("./services/auraImageWorker.service");

const worker = startAuraImageWorker();

if (!worker.enabled) {
  db.end().finally(() => process.exit(0));
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ level: "info", event: "aura_image_worker_stopping", signal }));
  worker.stop();
  await db.end().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
