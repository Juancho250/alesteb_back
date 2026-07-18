require("dotenv/config");
require("../config/env")();

const db = require("../config/db");
const { cleanupExpiredVoiceData } = require("../services/auraVoice.service");

async function main() {
  if (String(process.env.AURA_VOICE_CLEANUP_ENABLED || "false").toLowerCase() !== "true") {
    console.log(JSON.stringify({ level: "info", event: "aura_voice_cleanup_disabled" }));
    return;
  }
  const result = await cleanupExpiredVoiceData();
  console.log(JSON.stringify({ level: "info", event: "aura_voice_cleanup_completed", ...result }));
}

main()
  .catch((err) => {
    console.error(JSON.stringify({
      level: "error",
      event: "aura_voice_cleanup_failed",
      errorCode: String(err.code || "AURA_VOICE_CLEANUP_ERROR").slice(0, 80),
    }));
    process.exitCode = 1;
  })
  .finally(() => db.end().catch(() => {}));
