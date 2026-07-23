process.env.ALESTEB_PROCESS_ROLE = "image-worker";

require("dotenv/config");
require("./config/env")();

const db = require("./src/platform/database");
const { startAuraImageWorker } = require("./src/modules/aura/images/image-worker.service");

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
