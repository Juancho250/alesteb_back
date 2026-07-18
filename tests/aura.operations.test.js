const test = require("node:test");
const assert = require("node:assert/strict");

const dbPath = require.resolve("../config/db");
const calls = [];
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("FROM notification_queue")) {
        return { rows: [{ status: "pending", count: 2, stale_count: 0, oldest_active_at: "2026-07-15T10:00:00Z" }] };
      }
      if (sql.includes("FROM ai_jobs")) {
        return { rows: [{ type: "aura_image_generate", status: "queued", count: 1, stale_count: 0 }] };
      }
      if (sql.includes("FROM aura_runs")) {
        return { rows: [{ runs_24h: 3, failures_24h: 0, tokens_24h: 120, cost_24h: 0.01 }] };
      }
      if (sql.includes("FROM prediction_results")) {
        return { rows: [{ latest_prediction_at: "2026-07-15T09:00:00Z", fresh_results: 4 }] };
      }
      if (sql.includes("FROM aura_voice_sessions")) {
        return { rows: [{ active_sessions: 0, expired_not_closed: 0 }] };
      }
      throw new Error("Unexpected operations query");
    },
  },
};

const operations = require("../services/auraOperations.service");

test.beforeEach(() => calls.splice(0));

test("AURA operational health exposes only tenant-scoped aggregate metrics", async () => {
  const result = await operations.getAuraOperationalHealth({ ownerAdminId: 101, userId: 11 });

  assert.equal(result.status, "ok");
  assert.equal(result.tenantScoped, true);
  assert.equal(result.notificationQueue.byStatus.pending, 2);
  assert.equal(result.aiJobs.byTypeAndStatus["aura_image_generate:queued"], 1);
  assert.equal(result.auraRuns.tokensLast24Hours, 120);
  assert.ok(calls.every((call) => call.params.length === 1 && call.params[0] === 101));
  assert.doesNotMatch(JSON.stringify(result), /email|phone|prompt|payload/i);
});

test("AURA operational health rejects missing tenant context", async () => {
  await assert.rejects(
    () => operations.getAuraOperationalHealth({ ownerAdminId: null }),
    { code: "AURA_OPERATIONS_TENANT_REQUIRED" }
  );
  assert.equal(calls.length, 0);
});
