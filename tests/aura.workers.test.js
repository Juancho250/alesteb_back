const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const workerSmoke = require("../scripts/aura_workers_staging_smoke");

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

test("workers staging smoke fails closed unless staging mocks are enabled", () => {
  const safeEnv = {
    AURA_STAGING_MODE: "true",
    AURA_IMAGE_MOCK_PROVIDER_ENABLED: "true",
    AURA_NOTIFICATION_MOCK_PROVIDER_ENABLED: "true",
    AURA_IMAGE_WORKER_ENABLED: "false",
    AURA_NOTIFICATION_WORKER_ENABLED: "false",
    AURA_PREDICTIVE_JOBS_ENABLED: "false",
    AURA_FORECAST_WORKER_ENABLED: "false",
    LEGACY_CREDIT_REMINDER_WORKER_ENABLED: "false",
    LEGACY_NOTIFICATION_SCHEDULER_ENABLED: "false",
    ENABLE_LEGACY_AGENT_CRON: "false",
    AURA_VOICE_ENABLED: "false",
  };

  assert.doesNotThrow(() => workerSmoke.validateSmokeEnvironment(safeEnv));
  assert.throws(
    () => workerSmoke.validateSmokeEnvironment({ ...safeEnv, AURA_STAGING_MODE: "false" }),
    (err) => err.code === "AURA_SMOKE_MOCK_GUARD_FAILED"
  );
  assert.throws(
    () => workerSmoke.validateSmokeEnvironment({
      ...safeEnv,
      AURA_NOTIFICATION_MOCK_PROVIDER_ENABLED: "false",
    }),
    (err) => err.code === "AURA_SMOKE_MOCK_GUARD_FAILED"
  );
  assert.throws(
    () => workerSmoke.validateSmokeEnvironment({
      ...safeEnv,
      AURA_FORECAST_WORKER_ENABLED: "true",
    }),
    (err) => err.code === "AURA_SMOKE_WORKER_FLAG_UNSAFE"
  );
});

test("workers staging smoke accepts only direct non-production Neon URLs", () => {
  const direct = workerSmoke.validateDatabaseUrl(
    "postgresql://user:secret@ep-aura.us-east-2.aws.neon.tech/neondb?sslmode=require"
  );
  assert.equal(direct.host, "ep-aura.us-east-2.aws.neon.tech");

  assert.throws(
    () => workerSmoke.validateDatabaseUrl(
      "postgresql://user:secret@ep-aura-pooler.us-east-2.aws.neon.tech/neondb"
    ),
    (err) => err.code === "AURA_SMOKE_POOLER_REJECTED"
  );
  assert.throws(
    () => workerSmoke.validateDatabaseUrl(
      "postgresql://user:secret@ep-prod.us-east-2.aws.neon.tech/neondb"
    ),
    (err) => err.code === "AURA_SMOKE_PRODUCTION_TARGET_REJECTED"
  );
});

test("one-shot claims are exact-ID and tenant-scoped while production defaults remain available", () => {
  const notification = source("services/notificationOutbox.service.js");
  const notificationWorker = source("services/notification.worker.js");
  const images = source("services/auraImageJobs.service.js");
  const imageWorker = source("services/auraImageWorker.service.js");
  const forecast = source("services/auraForecasting.service.js");
  const features = source("services/auraPredictiveFeatures.service.js");

  assert.match(notification, /owner_admin_id = \$3[\s\S]*id = \$4/);
  assert.match(notification, /normalizeNotificationClaimScope/);
  assert.match(notificationWorker, /skipRecovery[\s\S]*claimScope/);
  assert.match(images, /owner_admin_id = \$2[\s\S]*id = \$3/);
  assert.match(imageWorker, /ownerAdminId:\s*claimScope\.ownerAdminId/);
  assert.match(forecast, /owner_admin_id = \$3[\s\S]*id = \$4/);
  assert.match(forecast, /processForecastJobs\(limit = 5, workerId, claimScope = \{\}\)/);
  assert.match(features, /runDailyPredictiveFeatureJob\(\{[\s\S]*ownerAdminId = null/);
  assert.match(features, /listActiveTenantIds\(db, ownerAdminId\)/);

  assert.match(notification, /if \(!hasOwner && !hasNotification\) return null/);
  assert.match(images, /if \(!hasOwner && !hasJob\) return null/);
  assert.match(forecast, /if \(!hasOwner && !hasJob\) return null/);
});

test("foreign eligible work blocks a smoke queue without exposing or claiming rows", async () => {
  const calls = [];
  const blockedDb = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ foreign_count: 2 }] };
    },
  };

  await assert.rejects(
    () => workerSmoke.assertNoForeignEligible(blockedDb, "notification", "77"),
    (err) => err.code === "AURA_SMOKE_NOTIFICATION_FOREIGN_ELIGIBLE"
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, ["77"]);
  assert.match(calls[0].sql, /id <> \$1::bigint/);
  assert.doesNotMatch(calls[0].sql, /SELECT\s+id/i);

  const emptyDb = {
    async query() {
      return { rows: [{ foreign_count: 0 }] };
    },
  };
  await assert.doesNotReject(
    () => workerSmoke.assertNoForeignEligible(emptyDb, "forecast", "11111111-1111-4111-8111-111111111111")
  );
});

test("notification and image mock evidence is tenant-aware", () => {
  const ownerAdminId = 101;
  assert.doesNotThrow(() => workerSmoke.assertNotificationOutcome({
    id: "71",
    owner_admin_id: ownerAdminId,
    status: "sent",
    attempts: 1,
    provider_message_id: "mock:email:71",
    sent_at: "2026-07-19T12:00:00.000Z",
  }, ownerAdminId, "71"));

  assert.throws(
    () => workerSmoke.assertNotificationOutcome({
      id: "71",
      owner_admin_id: 202,
      status: "sent",
      attempts: 1,
      provider_message_id: "mock:email:71",
      sent_at: "2026-07-19T12:00:00.000Z",
    }, ownerAdminId, "71"),
    (err) => err.code === "AURA_SMOKE_TENANT_MISMATCH"
  );

  assert.doesNotThrow(() => workerSmoke.assertImageOutcome(
    {
      id: "11111111-1111-4111-8111-111111111111",
      owner_admin_id: ownerAdminId,
      status: "completed",
      output: { model: "aura-image-mock-v1" },
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      owner_admin_id: ownerAdminId,
      status: "ready",
      generated_asset_url: "https://res.cloudinary.com/demo/image/upload/mock.png",
      cloudinary_public_id: "alesteb/campaigns/101/mock-aura",
      metadata: { openaiEndpoint: "mock/images/generations" },
    },
    ownerAdminId,
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222"
  ));
});

test("forecast smoke evidence rejects cross-tenant results", () => {
  const input = {
    job: {
      id: "33333333-3333-4333-8333-333333333333",
      owner_admin_id: 101,
      status: "completed",
    },
    run: {
      id: "44444444-4444-4444-8444-444444444444",
      owner_admin_id: 101,
      status: "completed",
    },
    resultCount: 1,
    crossTenantCount: 0,
  };
  assert.doesNotThrow(() => workerSmoke.assertForecastOutcome(
    input,
    101,
    "33333333-3333-4333-8333-333333333333"
  ));
  assert.throws(
    () => workerSmoke.assertForecastOutcome(
      { ...input, crossTenantCount: 1 },
      101,
      "33333333-3333-4333-8333-333333333333"
    ),
    (err) => err.code === "AURA_SMOKE_FORECAST_FAILED"
  );
});

test("workers smoke exposes only sanitized PostgreSQL diagnostics and keeps failures fatal", () => {
  const sql = `
    WITH private_scope AS (
      SELECT 'customer@example.test'::text AS sensitive_literal
    )
    SELECT s.id
    FROM sales s
    WHERE s.owner_admin_id = $1
      AND poi.variant_id IS NOT NULL
  `;
  const position = sql.indexOf("poi.variant_id") + 1;
  const diagnostic = workerSmoke.sanitizePostgresError({
    code: "42703",
    table: "purchase_order_items",
    constraint: "predictive_schema_contract",
    routine: "errorMissingColumn",
    position: String(position),
    message: "column poi.variant_id does not exist",
    auraStatementName: "insertVariantFeatures",
    auraSql: sql,
    query: "SELECT * FROM private_customer_data",
    parameters: ["secret"],
    jwt: "secret.jwt.value",
  });

  assert.equal(diagnostic.code, "42703");
  assert.equal(diagnostic.table, "purchase_order_items");
  assert.equal(diagnostic.constraint, "predictive_schema_contract");
  assert.equal(diagnostic.routine, "errorMissingColumn");
  assert.equal(diagnostic.position, String(position));
  assert.equal(diagnostic.statementName, "insertVariantFeatures");
  assert.equal(diagnostic.missingColumn, "poi.variant_id");
  assert.match(diagnostic.sqlContext, /poi\.variant_id/);
  assert.ok(diagnostic.sqlContext.length <= 160);
  assert.doesNotMatch(diagnostic.sqlContext, /customer@example|private_customer_data|secret|[\r\n]/i);
  assert.equal(Object.hasOwn(diagnostic, "query"), false);
  assert.equal(Object.hasOwn(diagnostic, "parameters"), false);
  assert.equal(Object.hasOwn(diagnostic, "jwt"), false);

  const runner = source("scripts/aura_workers_staging_smoke.js");
  assert.match(runner, /throwOnError:\s*true/);
  assert.match(runner, /\.\.\.sanitizePostgresError\(err\)/);
  assert.match(runner, /process\.exitCode\s*=\s*1/);
});

test("forecast smoke runs daily tenant features before enqueueing forecast work", () => {
  const runner = source("scripts/aura_workers_staging_smoke.js");
  const featureStep = runner.indexOf("await runTenantFeatureSmoke");
  const enqueueStep = runner.indexOf("await services.forecasting.enqueueForecastRecalculation", featureStep);
  const processStep = runner.indexOf("await services.forecasting.processForecastJobs", enqueueStep);

  assert.ok(featureStep >= 0);
  assert.ok(enqueueStep > featureStep);
  assert.ok(processStep > enqueueStep);
});

test("fixture cleanup after a partial failure uses only tracked exact IDs", async () => {
  const calls = [];
  let released = false;
  const zeroCounts = {
    notifications: 0,
    jobs: 0,
    assets: 0,
    runs: 0,
    product_features: 0,
    variant_features: 0,
    store_features: 0,
    model_versions: 0,
  };
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes("SELECT id, type")) {
        return { rows: [] };
      }
      if (sql.includes("SELECT id, run_type")) {
        return {
          rows: [{
            id: "55555555-5555-4555-8555-555555555555",
            run_type: "prediction",
            model_version_id: "66666666-6666-4666-8666-666666666666",
            metadata: { modelVersionCreated: true },
          }],
        };
      }
      if (sql.includes("SELECT id") && !sql.includes("COUNT(*)")) {
        return { rows: [] };
      }
      if (sql.includes("AS notifications")) {
        return { rows: [zeroCounts] };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {
      released = true;
    },
  };
  const db = {
    async connect() {
      return client;
    },
  };
  const tracker = workerSmoke.createFixtureTracker("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  tracker.ownerAdminId = 101;
  tracker.notificationIds.push("51");
  tracker.imageJobIds.push("11111111-1111-4111-8111-111111111111");
  tracker.forecastJobIds.push("22222222-2222-4222-8222-222222222222");
  tracker.assetIds.push("33333333-3333-4333-8333-333333333333");
  tracker.featureRunIds.push("44444444-4444-4444-8444-444444444444");
  tracker.forecastRunIds.push("55555555-5555-4555-8555-555555555555");

  let partialFailure;
  try {
    throw new Error("simulated partial failure");
  } catch (err) {
    partialFailure = err;
  } finally {
    assert.equal(await workerSmoke.cleanupSmokeFixtures(db, tracker), true);
  }
  assert.match(partialFailure.message, /partial failure/);
  assert.equal(released, true);

  const deletes = calls.filter((call) => call.sql.trim().startsWith("DELETE FROM"));
  assert.ok(deletes.length >= 7);
  assert.ok(deletes.every((call) => (
    call.sql.includes("ANY($2::")
    || (call.sql.includes("model_versions") && call.sql.includes("mv.id = $1"))
  )));
  assert.ok(deletes.every((call) => !/WHERE\s+status\s*=/i.test(call.sql)));
  assert.ok(deletes.every((call) => (
    !/WHERE\s+owner_admin_id\s*=\s*\$1\s*;?\s*$/i.test(call.sql.trim())
  )));
  assert.ok(deletes.some((call) => (
    call.sql.includes("DELETE FROM model_versions")
    && call.params[0] === "66666666-6666-4666-8666-666666666666"
  )));
  assert.ok(workerSmoke.exactCleanupIdsMatch(["id-a", "id-b"], ["id-b", "id-a"]));
  assert.equal(workerSmoke.exactCleanupIdsMatch(["id-a"], ["id-a", "id-b"]), false);
});

test("workers smoke imports no resident entrypoint and starts no cron or interval", () => {
  const runner = source("scripts/aura_workers_staging_smoke.js");
  assert.doesNotMatch(runner, /require\(['"]\.\.\/worker\.(ai|notification|predictive)\.js['"]\)/);
  assert.doesNotMatch(runner, /\bsetInterval\s*\(/);
  assert.doesNotMatch(runner, /\bcron\.schedule\s*\(/);
  assert.match(runner, /processOneImageJob/);
  assert.match(runner, /runNotificationWorkerTick/);
  assert.match(runner, /processForecastJobs/);
  assert.match(runner, /AURA_REAL_PROVIDER_ATTEMPT_BLOCKED/);
});
