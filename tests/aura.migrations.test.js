const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const auraMigrationsDir = path.join(repoRoot, "migrations", "aura");
const scriptsDir = path.join(repoRoot, "scripts");

function sqlFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => path.join(directory, entry.name));
}

function indexStatements(sql) {
  return sql.match(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\b[\s\S]*?;/gi) || [];
}

function readRepoFile(...parts) {
  return fs.readFileSync(path.join(repoRoot, ...parts), "utf8");
}

function fingerprintBlock(sql) {
  const match = sql.match(
    /-- AURA_NOTIFICATION_FINGERPRINT_BEGIN([\s\S]*?)-- AURA_NOTIFICATION_FINGERPRINT_END/
  );
  assert.ok(match, "notification fingerprint block is missing");
  return match[1].replace(/'0[78]a_notification_queue_terminal_snapshot'/, "'snapshot'").trim();
}

test("AURA SQL indexes do not use temporal or non-immutable predicates", () => {
  const forbiddenTemporal = [
    /\bNOW\s*\(/i,
    /\bCURRENT_TIMESTAMP\b/i,
    /\bCURRENT_DATE\b/i,
    /\bclock_timestamp\s*\(/i,
    /\bstatement_timestamp\s*\(/i,
    /\btransaction_timestamp\s*\(/i,
    /\bdate_trunc\s*\(/i,
    /\btimezone\s*\(/i,
    /\bAT\s+TIME\s+ZONE\b/i,
  ];

  for (const file of [...sqlFiles(auraMigrationsDir), ...sqlFiles(scriptsDir)]) {
    const relative = path.relative(repoRoot, file);
    for (const statement of indexStatements(fs.readFileSync(file, "utf8"))) {
      for (const pattern of forbiddenTemporal) {
        assert.doesNotMatch(statement, pattern, `${relative} has a non-immutable time expression in an index`);
      }

      const whereOffset = statement.search(/\bWHERE\b/i);
      if (whereOffset >= 0) {
        const predicate = statement.slice(whereOffset);
        assert.doesNotMatch(
          predicate,
          /::\s*text\b/i,
          `${relative} casts a partial-index predicate to text; enum output is not immutable`
        );
      }
    }
  }
});

test("notification queue claim index and worker use the same immutable eligibility policy", () => {
  const migration = fs.readFileSync(
    path.join(auraMigrationsDir, "005_aura_actions_outbox_v2.sql"),
    "utf8"
  );
  const worker = fs.readFileSync(
    path.join(repoRoot, "src", "modules", "notifications", "notification-outbox.service.js"),
    "utf8"
  );
  const claimStart = worker.indexOf("async function claimNotificationJobs");
  const claimEnd = worker.indexOf("async function rescheduleForQuietHours", claimStart);
  const claim = worker.slice(claimStart, claimEnd);

  assert.match(
    migration,
    /CREATE INDEX IF NOT EXISTS idx_notification_queue_claim\s+ON public\.notification_queue\(available_at, scheduled_for, created_at, id\)\s+WHERE status = 'pending';/i
  );
  assert.doesNotMatch(migration, /WHERE\s+status::text/i);

  assert.match(claim, /WHERE status = 'pending'/);
  assert.match(claim, /available_at <= NOW\(\)/);
  assert.match(claim, /scheduled_for <= NOW\(\)/);
  assert.match(claim, /attempts < max_attempts/);
  assert.match(claim, /ORDER BY available_at ASC, scheduled_for ASC, created_at ASC, id ASC/);
  assert.match(claim, /FOR UPDATE SKIP LOCKED/);
  assert.match(claim, /UPDATE notification_queue nq[\s\S]*SET status = 'sending'/);
  assert.doesNotMatch(claim, /'queued'/);
});

test("notification queue migration preserves non-null historical delivery state", () => {
  const migration = fs.readFileSync(
    path.join(auraMigrationsDir, "005_aura_actions_outbox_v2.sql"),
    "utf8"
  );

  const backfills = migration.match(/UPDATE public\.notification_queue[\s\S]*?;/gi) || [];
  const allowedAssignments = new Set(["available_at", "scheduled_for", "recipient", "updated_at"]);

  assert.equal(backfills.length, 4);
  for (const statement of backfills) {
    const assignment = statement.match(/\bSET\s+([a-z_]+)/i);
    assert.ok(assignment);
    assert.ok(allowedAssignments.has(assignment[1].toLowerCase()));
    assert.match(statement, new RegExp(`WHERE ${assignment[1]} IS NULL`, "i"));
  }

  for (const critical of [
    "owner_admin_id", "recipient_user_id", "recipient_phone", "recipient_email",
    "channel", "event", "status", "attempts", "max_attempts", "sent_at", "provider",
    "provider_message_id", "last_error", "rendered_subject", "rendered_message", "payload",
    "reference_type", "reference_id", "created_at",
  ]) {
    assert.doesNotMatch(migration, new RegExp(`\\bSET\\s+${critical}\\b`, "i"));
  }
});

test("preflight and postflight use the exact same CORE and EXTENDED formulas", () => {
  const preflight = readRepoFile("scripts", "aura_preflight.sql");
  const postflight = readRepoFile("scripts", "aura_postflight.sql");

  assert.equal(fingerprintBlock(preflight), fingerprintBlock(postflight));
});

test("CORE fingerprint contains only historical fields and EXTENDED contains outbox fields", () => {
  const block = fingerprintBlock(readRepoFile("scripts", "aura_preflight.sql"));
  const formulas = [...block.matchAll(
    /MD5\(JSONB_BUILD_ARRAY\(([\s\S]*?)\)::text\) AS (core|extended)_row_fingerprint/gi
  )];
  const core = formulas.find((match) => match[2].toLowerCase() === "core")?.[1];
  const extended = formulas.find((match) => match[2].toLowerCase() === "extended")?.[1];

  assert.ok(core);
  assert.ok(extended);

  const coreFields = [
    "id", "owner_admin_id", "recipient_user_id", "recipient_phone", "recipient_email",
    "channel", "event", "status", "attempts", "max_attempts", "sent_at", "provider",
    "provider_message_id", "last_error", "rendered_subject", "rendered_message", "payload",
    "scheduled_for", "reference_type", "reference_id", "created_at",
  ];
  const extendedFields = [
    "campaign_id", "recipient", "dedupe_key", "available_at", "locked_at", "locked_by",
    "delivered_at", "read_at", "clicked_at", "failed_at", "error", "reference_key", "updated_at",
  ];

  for (const field of coreFields) assert.match(core, new RegExp(`row_data->'${field}'`));
  for (const field of extendedFields) {
    assert.doesNotMatch(core, new RegExp(`row_data->'${field}'`));
    assert.match(extended, new RegExp(`row_data->'${field}'`));
  }
});

test("notification history audit is read-only and includes legacy diagnostic hashes", () => {
  const audit = readRepoFile("scripts", "aura_notification_history_audit.sql");

  assert.match(audit, /BEGIN READ ONLY;/);
  assert.match(audit, /legacy_preflight_fingerprint/);
  assert.match(audit, /legacy_postflight_fingerprint/);
  assert.doesNotMatch(audit, /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i);
});

test("notification history audit separates legacy warnings from delivery blockers", () => {
  const audit = readRepoFile("scripts", "aura_notification_history_audit.sql");

  for (const warning of [
    "sent_with_zero_attempts",
    "failed_with_zero_attempts",
    "failed_before_provider_attempt",
  ]) {
    assert.match(
      audit,
      new RegExp(`SELECT '${warning}'[\\s\\S]*?'WARNING_LEGACY'`)
    );
  }

  for (const blocker of [
    "terminal_rows_claimable",
    "sent_without_provider_evidence",
    "rows_with_negative_attempts",
    "rows_over_max_attempts",
    "terminal_rows_with_duplicate_dedupe_key",
    "duplicate_provider_message_id_groups",
    "rows_with_invalid_owner_admin_id",
    "recipient_tenant_mismatches",
    "campaign_tenant_mismatches",
  ]) {
    assert.match(
      audit,
      new RegExp(`SELECT '${blocker}'[\\s\\S]*?'BLOCKER'`)
    );
  }

  assert.match(audit, /WHEN rows_count = 0 THEN 'PASS'/);
});

test("legacy notification producers populate both required scheduling columns", () => {
  const service = fs.readFileSync(
    path.join(repoRoot, "src", "modules", "notifications", "notification.service.js"),
    "utf8"
  );
  const inserts = service.match(/INSERT INTO notification_queue[\s\S]*?(?=`)/g) || [];

  assert.equal(inserts.length, 2);
  for (const insert of inserts) {
    assert.match(insert, /\bavailable_at\b/);
    assert.match(insert, /\bscheduled_for\b/);
  }
});
