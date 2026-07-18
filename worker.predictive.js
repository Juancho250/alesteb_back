require("dotenv/config");
require("./config/env")();

const db = require("./config/db");
const { startAuraPredictiveJobs } = require("./services/auraPredictive.jobs");

const worker = startAuraPredictiveJobs();
if (!worker.enabled) {
  db.end().finally(() => process.exit(0));
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ level: "info", event: "aura_predictive_worker_stopping", signal }));
  await worker.stop();
  await db.end().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
