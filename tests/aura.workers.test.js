const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("all resident AURA workers remain disabled in the example environment", () => {
  const env = source(".env.example");
  for (const flag of [
    "ENABLE_LEGACY_AGENT_CRON",
    "AURA_NOTIFICATION_WORKER_ENABLED",
    "AURA_IMAGE_WORKER_ENABLED",
    "AURA_PREDICTIVE_JOBS_ENABLED",
    "AURA_FORECAST_WORKER_ENABLED",
    "AURA_VOICE_ENABLED",
  ]) {
    assert.match(env, new RegExp(`^${flag}=false$`, "m"));
  }
});

test("notification worker is flag-gated, non-overlapping and recovers stale claims conservatively", () => {
  const worker = source("services/notification.worker.js");
  const outbox = source("services/notificationOutbox.service.js");
  assert.match(worker, /AURA_NOTIFICATION_WORKER_ENABLED/);
  assert.match(worker, /noOverlap:\s*true/);
  assert.match(worker, /recoverStaleNotificationJobs/);
  assert.match(outbox, /status = 'sending'/);
  assert.match(outbox, /Claim abandonado; requiere revision/);
  assert.doesNotMatch(outbox, /WHERE status = 'sending'[\s\S]{0,300}SET status = 'pending'/);
});

test("forecast claim respects max attempts and quarantines abandoned jobs", () => {
  const forecast = source("services/auraForecasting.service.js");
  assert.match(forecast, /FOR UPDATE SKIP LOCKED/);
  assert.match(forecast, /COALESCE\(attempts, 0\) < COALESCE\(max_attempts, 2\)/);
  assert.match(forecast, /AURA_FORECAST_STALE_CLAIM/);
  assert.match(forecast, /2 \*\* Math\.max/);
});

test("worker entrypoints expose independent graceful shutdown", () => {
  for (const file of ["worker.ai.js", "worker.notification.js", "worker.predictive.js"]) {
    const content = source(file);
    assert.match(content, /SIGTERM/);
    assert.match(content, /SIGINT/);
    assert.match(content, /db\.end/);
  }
});

test("Socket direct messages validate same-tenant recipient before insert", () => {
  const socket = source("config/socket.js");
  const ownershipCheck = socket.indexOf("COALESCE(owner_admin_id, id) = $2");
  const messageInsert = socket.indexOf("INSERT INTO chat_messages");
  assert.ok(ownershipCheck >= 0 && ownershipCheck < messageInsert);
  assert.match(socket, /cleanMessage\.length > 2000/);
  assert.match(socket, /\[parsedRecipientId, adminId\]/);
});
