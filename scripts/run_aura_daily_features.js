require("dotenv/config");
require("../config/env")();

const db = require("../config/db");
const { runDailyPredictiveFeatureJob } = require("../services/auraPredictiveFeatures.service");

async function main() {
  if (String(process.env.AURA_PREDICTIVE_JOBS_ENABLED || "false").toLowerCase() !== "true") {
    console.log(JSON.stringify({ level: "info", event: "aura_daily_features_disabled" }));
    return;
  }
  const started = Date.now();
  const result = await runDailyPredictiveFeatureJob();
  console.log(JSON.stringify({
    level: "info",
    event: "aura_daily_features_completed",
    featureDate: result.featureDate,
    tenants: result.tenants,
    durationMs: Date.now() - started,
  }));
}

main()
  .catch((err) => {
    console.error(JSON.stringify({
      level: "error",
      event: "aura_daily_features_failed",
      errorCode: String(err.code || "AURA_DAILY_FEATURES_ERROR").slice(0, 80),
    }));
    process.exitCode = 1;
  })
  .finally(() => db.end().catch(() => {}));
