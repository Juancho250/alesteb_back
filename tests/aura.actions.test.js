const test = require("node:test");
const assert = require("node:assert/strict");

process.env.AURA_ACTION_EXPIRY_HOURS = "24";
process.env.WHATSAPP_REQUIRE_TEMPLATES = "true";

const dbPath = require.resolve("../src/platform/database");
const calls = [];
const actionsTable = [];
const campaignsTable = [];
const contentsTable = [];
const recipientsTable = [];
const consentsTable = [];
const usersTable = [];
const notificationQueue = [];
const discountsTable = [];
const discountTargetsTable = [];

function now() {
  return new Date("2026-07-14T12:00:00Z");
}

function resetData() {
  calls.length = 0;
  actionsTable.length = 0;
  campaignsTable.length = 0;
  contentsTable.length = 0;
  recipientsTable.length = 0;
  consentsTable.length = 0;
  usersTable.length = 0;
  notificationQueue.length = 0;
  discountsTable.length = 0;
  discountTargetsTable.length = 0;

  usersTable.push(
    { id: 41, owner_admin_id: 101, name: "Cliente A", email: "a@example.test", phone: "+573001111111", is_active: true },
    { id: 42, owner_admin_id: 101, name: "Cliente B", email: "b@example.test", phone: "+573002222222", is_active: true },
    { id: 51, owner_admin_id: 202, name: "Cliente X", email: "x@example.test", phone: "+573009999999", is_active: true }
  );
  consentsTable.push(
    { owner_admin_id: 101, user_id: 41, channel: "email", status: "granted" },
    { owner_admin_id: 101, user_id: 42, channel: "email", status: "revoked" },
    { owner_admin_id: 202, user_id: 51, channel: "email", status: "granted" }
  );
  campaignsTable.push(
    {
      id: "11111111-1111-4111-8111-111111111111",
      owner_admin_id: 101,
      channel: "email",
      status: "draft",
      approved_by: null,
      scheduled_at: null,
      updated_at: now(),
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      owner_admin_id: 202,
      channel: "email",
      status: "draft",
      approved_by: null,
      scheduled_at: null,
      updated_at: now(),
    }
  );
  contentsTable.push({
    campaign_id: "11111111-1111-4111-8111-111111111111",
    channel: "email",
    version: 1,
    headline: "Oferta privada",
    body: "<p>Hola</p>",
    call_to_action: "Comprar",
    created_at: now(),
  });
  recipientsTable.push(
    {
      owner_admin_id: 101,
      campaign_id: "11111111-1111-4111-8111-111111111111",
      recipient_user_id: 41,
      channel: "email",
      status: "ready",
    },
    {
      owner_admin_id: 101,
      campaign_id: "11111111-1111-4111-8111-111111111111",
      recipient_user_id: 42,
      channel: "email",
      status: "ready",
    },
    {
      owner_admin_id: 202,
      campaign_id: "22222222-2222-4222-8222-222222222222",
      recipient_user_id: 51,
      channel: "email",
      status: "ready",
    }
  );
}

function cloneRow(row) {
  return row ? { ...row } : row;
}

function insertActionFromParams(params) {
  const existing = actionsTable.find((row) =>
    Number(row.owner_admin_id) === Number(params[1]) && row.idempotency_key === params[7]
  );
  if (existing) return existing;
  const row = {
    id: params[0],
    owner_admin_id: params[1],
    user_id: params[2],
    action_type: params[3],
    status: "pending_approval",
    payload: JSON.parse(params[4]),
    payload_hash: params[5],
    required_permission: params[6],
    idempotency_key: params[7],
    expires_at: params[8],
    approved_by: null,
    approved_at: null,
    executed_at: null,
    result: {},
    error_code: null,
    error_message_redacted: null,
    created_at: now(),
    updated_at: now(),
  };
  actionsTable.push(row);
  return row;
}

function findAction(ownerAdminId, actionId) {
  return actionsTable.find((row) => Number(row.owner_admin_id) === Number(ownerAdminId) && row.id === actionId);
}

async function handleQuery(sql, params = []) {
  calls.push({ sql, params });

  if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
    return { rows: [], rowCount: 0 };
  }

  if (sql.includes("INSERT INTO aura_actions")) {
    const row = insertActionFromParams(params);
    return { rows: [cloneRow(row)], rowCount: 1 };
  }

  if (sql.includes("FROM aura_actions") && sql.includes("FOR UPDATE")) {
    const row = findAction(params[0], params[1]);
    return { rows: row ? [cloneRow(row)] : [], rowCount: row ? 1 : 0 };
  }

  if (sql.includes("FROM aura_actions") && sql.includes("LIMIT 1")) {
    const row = findAction(params[0], params[1]);
    return { rows: row ? [cloneRow(row)] : [], rowCount: row ? 1 : 0 };
  }

  if (sql.includes("FROM aura_actions") && sql.includes("ORDER BY created_at DESC")) {
    const rows = actionsTable
      .filter((row) => Number(row.owner_admin_id) === Number(params[0]))
      .slice(params[params.length - 1], params[params.length - 1] + params[params.length - 2]);
    return { rows: rows.map(cloneRow), rowCount: rows.length };
  }

  if (sql.includes("UPDATE aura_actions") && sql.includes("status = 'executing'")) {
    const row = actionsTable.find((item) => item.id === params[0]);
    if (row) {
      row.status = "executing";
      row.approved_by = params[1];
      row.approved_at = now();
      row.updated_at = now();
    }
    return { rows: [], rowCount: row ? 1 : 0 };
  }

  if (sql.includes("UPDATE aura_actions") && sql.includes("status = 'completed'")) {
    const row = actionsTable.find((item) => item.id === params[0]);
    if (row) {
      row.status = "completed";
      row.executed_at = now();
      row.result = JSON.parse(params[1]);
      row.updated_at = now();
    }
    return { rows: row ? [cloneRow(row)] : [], rowCount: row ? 1 : 0 };
  }

  if (sql.includes("UPDATE aura_actions") && sql.includes("status = 'failed'")) {
    const row = actionsTable.find((item) => item.id === params[0]);
    if (row) {
      row.status = "failed";
      row.error_code = params[1];
      row.error_message_redacted = params[2];
      row.updated_at = now();
    }
    return { rows: row ? [cloneRow(row)] : [], rowCount: row ? 1 : 0 };
  }

  if (sql.includes("UPDATE aura_actions") && sql.includes("status = 'expired'")) {
    const row = actionsTable.find((item) => item.id === params[0]);
    if (row) {
      row.status = "expired";
      row.error_code = "AURA_ACTION_EXPIRED";
      row.updated_at = now();
    }
    return { rows: [], rowCount: row ? 1 : 0 };
  }

  if (sql.includes("UPDATE aura_actions") && sql.includes("status = 'rejected'")) {
    const row = findAction(params[0], params[1]);
    if (!row || !["draft", "pending_approval", "approved"].includes(row.status)) {
      return { rows: [], rowCount: 0 };
    }
    row.status = "rejected";
    row.result = { ...(row.result || {}), ...JSON.parse(params[2]) };
    row.updated_at = now();
    return { rows: [cloneRow(row)], rowCount: 1 };
  }

  if (sql.includes("UPDATE marketing_campaigns") && sql.includes("SET status = 'approved'")) {
    const campaign = campaignsTable.find((row) =>
      Number(row.owner_admin_id) === Number(params[0]) && row.id === params[1]
    );
    if (!campaign || !["draft", "pending_approval", "approved"].includes(campaign.status)) {
      return { rows: [], rowCount: 0 };
    }
    campaign.status = "approved";
    campaign.approved_by = params[2];
    campaign.updated_at = now();
    return { rows: [{ id: campaign.id, status: campaign.status, approved_by: campaign.approved_by }], rowCount: 1 };
  }

  if (sql.includes("UPDATE marketing_campaigns") && sql.includes("SET status = 'scheduled'")) {
    const campaign = campaignsTable.find((row) =>
      Number(row.owner_admin_id) === Number(params[0]) && row.id === params[1]
    );
    if (!campaign || !["approved", "scheduled"].includes(campaign.status)) return { rows: [], rowCount: 0 };
    campaign.status = "scheduled";
    campaign.scheduled_at = params[2];
    return { rows: [{ id: campaign.id, status: campaign.status, scheduled_at: campaign.scheduled_at }], rowCount: 1 };
  }

  if (sql.includes("UPDATE marketing_campaigns") && sql.includes("SET status = 'paused'")) {
    const campaign = campaignsTable.find((row) =>
      Number(row.owner_admin_id) === Number(params[0]) && row.id === params[1]
    );
    if (!campaign || !["scheduled", "running", "approved"].includes(campaign.status)) return { rows: [], rowCount: 0 };
    campaign.status = "paused";
    return { rows: [{ id: campaign.id, status: campaign.status }], rowCount: 1 };
  }

  if (sql.includes("INSERT INTO discounts")) {
    const row = {
      id: discountsTable.length + 1,
      name: params[0],
      type: params[1],
      value: params[2],
      starts_at: params[3],
      ends_at: params[4],
      code: params[5],
      description: params[6],
      created_by: params[7],
      owner_admin_id: params[8],
      scope: params[9],
      active: false,
    };
    discountsTable.push(row);
    return { rows: [{ id: row.id, name: row.name, active: row.active }], rowCount: 1 };
  }

  if (sql.includes("INSERT INTO discount_targets")) {
    discountTargetsTable.push({ discount_id: params[0], target_type: params[1], target_id: params[2] });
    return { rows: [], rowCount: 1 };
  }

  if (sql.includes("UPDATE discounts") && sql.includes("SET active = true")) {
    const row = discountsTable.find((item) =>
      Number(item.owner_admin_id) === Number(params[0]) && Number(item.id) === Number(params[1])
    );
    if (!row) return { rows: [], rowCount: 0 };
    row.active = true;
    return { rows: [{ id: row.id, active: row.active }], rowCount: 1 };
  }

  if (sql.includes("SELECT mc.id, mc.channel, mc.status")) {
    const campaign = campaignsTable.find((row) =>
      Number(row.owner_admin_id) === Number(params[0]) && row.id === params[1]
    );
    if (!campaign) return { rows: [], rowCount: 0 };
    const content = contentsTable.find((row) => row.campaign_id === campaign.id && row.channel === campaign.channel);
    return {
      rows: [{
        id: campaign.id,
        channel: campaign.channel,
        status: campaign.status,
        scheduled_at: campaign.scheduled_at,
        headline: content?.headline || null,
        body: content?.body || null,
        call_to_action: content?.call_to_action || null,
      }],
      rowCount: 1,
    };
  }

  if (sql.includes("FROM marketing_campaigns mc") && sql.includes("LEFT JOIN marketing_segments")) {
    const campaign = campaignsTable.find((row) =>
      Number(row.owner_admin_id) === Number(params[0]) && row.id === params[1]
    );
    return {
      rows: campaign ? [{
        ...campaign,
        segment_id: null,
        segment_name: null,
        segment_definition: null,
        segment_estimated_size: 0,
      }] : [],
      rowCount: campaign ? 1 : 0,
    };
  }

  if (sql.includes("FROM campaign_contents") && sql.includes("ORDER BY channel ASC")) {
    const rows = contentsTable.filter((row) => row.campaign_id === params[0]);
    return { rows, rowCount: rows.length };
  }

  if (sql.includes("WITH reset_previous AS") && sql.includes("INSERT INTO campaign_recipients")) {
    const ownerAdminId = Number(params[0]);
    const channel = params[1];
    const campaignId = params.find((value) => typeof value === "string" && value.includes("-"));
    const recipients = recipientsTable.filter((recipient) =>
      Number(recipient.owner_admin_id) === ownerAdminId
      && recipient.campaign_id === campaignId
      && recipient.channel === channel
    );
    for (const recipient of recipients) {
      const user = usersTable.find((item) =>
        item.id === recipient.recipient_user_id
        && Number(item.owner_admin_id) === ownerAdminId
        && item.is_active
      );
      const consent = consentsTable.find((item) =>
        Number(item.owner_admin_id) === ownerAdminId
        && item.user_id === recipient.recipient_user_id
        && item.channel === channel
      );
      const hasContact = channel === "email" ? Boolean(user?.email) : Boolean(user?.phone);
      recipient.status = consent?.status === "revoked"
        ? "excluded_opt_out"
        : consent?.status !== "granted"
          ? "excluded_no_consent"
          : hasContact
            ? "ready"
            : "excluded_missing_contact";
      recipient.consent_snapshot = { status: consent?.status || "unknown" };
    }
    return {
      rows: [{
        prepared: recipients.length,
        ready: recipients.filter((row) => row.status === "ready").length,
        missing_consent: recipients.filter((row) => row.status === "excluded_no_consent").length,
        opt_out: recipients.filter((row) => row.status === "excluded_opt_out").length,
        missing_contact: recipients.filter((row) => row.status === "excluded_missing_contact").length,
      }],
      rowCount: 1,
    };
  }

  if (sql.includes("WITH eligible AS") && sql.includes("INSERT INTO notification_queue")) {
    const ownerAdminId = Number(params[0]);
    const campaignId = params[1];
    const channel = params[2];
    const payload = JSON.parse(params[3]);
    const eligible = recipientsTable.filter((recipient) => {
      const user = usersTable.find((item) =>
        item.id === recipient.recipient_user_id && Number(item.owner_admin_id) === ownerAdminId && item.is_active
      );
      const consent = consentsTable.find((item) =>
        Number(item.owner_admin_id) === ownerAdminId
        && item.user_id === recipient.recipient_user_id
        && item.channel === channel
      );
      return user
        && Number(recipient.owner_admin_id) === ownerAdminId
        && recipient.campaign_id === campaignId
        && recipient.channel === channel
        && ["ready", "eligible"].includes(recipient.status)
        && consent?.status === "granted";
    });
    const rows = [];
    for (const recipient of eligible) {
      const dedupe = `campaign:${campaignId}:${channel}:${recipient.recipient_user_id}`;
      if (notificationQueue.some((row) => Number(row.owner_admin_id) === ownerAdminId && row.dedupe_key === dedupe)) {
        continue;
      }
      const row = {
        id: notificationQueue.length + 1,
        owner_admin_id: ownerAdminId,
        campaign_id: campaignId,
        recipient_user_id: recipient.recipient_user_id,
        recipient: { userId: recipient.recipient_user_id },
        channel,
        payload,
        dedupe_key: dedupe,
        status: "pending",
        attempts: 0,
        max_attempts: 3,
        available_at: params[4] || now(),
        event: "aura_campaign_delivery",
        rendered_subject: params[5],
        rendered_message: params[6],
      };
      notificationQueue.push(row);
      rows.push({ id: row.id, recipient_user_id: row.recipient_user_id });
    }
    return { rows, rowCount: rows.length };
  }

  if (sql.includes("INSERT INTO campaign_events") && sql.includes("event_type")) {
    return { rows: [], rowCount: Array.isArray(params[2]) ? params[2].length : 1 };
  }

  if (sql.includes("UPDATE marketing_campaigns") && sql.includes("CASE WHEN status = 'draft'")) {
    const campaign = campaignsTable.find((row) =>
      Number(row.owner_admin_id) === Number(params[0]) && row.id === params[1]
    );
    if (campaign && campaign.status === "draft") campaign.status = "approved";
    return { rows: [], rowCount: campaign ? 1 : 0 };
  }

  if (sql.includes("WITH next_jobs AS") && sql.includes("FOR UPDATE SKIP LOCKED")) {
    const limit = Number(params[0]);
    const rows = notificationQueue
      .filter((row) => row.status === "pending")
      .filter((row) => Number(row.attempts || 0) < Number(row.max_attempts || 3))
      .filter((row) => !row.available_at || new Date(row.available_at) <= now())
      .filter((row) => !row.scheduled_for || new Date(row.scheduled_for) <= now())
      .slice(0, limit);
    rows.forEach((row) => {
      row.status = "sending";
      row.attempts = Number(row.attempts || 0) + 1;
      row.locked_at = now();
      row.locked_by = params[1];
    });
    return { rows: rows.map(cloneRow), rowCount: rows.length };
  }

  throw new Error(`Unexpected query: ${sql.slice(0, 160)}`);
}

const fakeDb = {
  query: handleQuery,
  async connect() {
    return {
      query: handleQuery,
      release() {},
    };
  },
};

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: fakeDb,
};

const auraActions = require("../src/modules/aura/actions/actions.service");
const auraTools = require("../src/modules/aura/tools/tools.service");
const notificationOutbox = require("../src/modules/notifications/notification-outbox.service");

const adminCtx = { ownerAdminId: 101, userId: 11, roles: ["admin"] };
const managerCtx = { ownerAdminId: 101, userId: 12, roles: ["gerente"] };

function addAction(actionType, payload, ownerAdminId = 101, overrides = {}) {
  const normalized = auraActions.validateActionPayload(actionType, payload);
  const row = {
    id: overrides.id || `aaaaaaaa-aaaa-4aaa-8aaa-${String(actionsTable.length + 1).padStart(12, "0")}`,
    owner_admin_id: ownerAdminId,
    user_id: overrides.userId || 11,
    action_type: actionType,
    status: overrides.status || "pending_approval",
    payload: normalized,
    payload_hash: overrides.payloadHash || auraActions.hashPayload(normalized),
    required_permission: auraActions.ACTION_PERMISSIONS[actionType],
    idempotency_key: overrides.idempotencyKey || `test:${actionType}:${actionsTable.length + 1}`,
    expires_at: overrides.expiresAt || new Date(Date.now() + 60_000).toISOString(),
    approved_by: null,
    approved_at: null,
    executed_at: null,
    result: {},
    error_code: null,
    error_message_redacted: null,
    created_at: now(),
    updated_at: now(),
  };
  actionsTable.push(row);
  return row;
}

test.beforeEach(resetData);

test("proposeAction is idempotent and tenant-aware", async () => {
  const payload = { campaignId: "11111111-1111-4111-8111-111111111111" };

  const first = await auraActions.proposeAction({
    ...adminCtx,
    actionType: "approve_campaign",
    payload,
  });
  const second = await auraActions.proposeAction({
    ...adminCtx,
    actionType: "approve_campaign",
    payload,
  });

  assert.equal(first.id, second.id);
  assert.equal(actionsTable.length, 1);
  assert.equal(actionsTable[0].owner_admin_id, 101);
  assert.equal(actionsTable[0].status, "pending_approval");
});

test("AURA tool can only propose an action, not execute it", async () => {
  const result = await auraTools.executeAuraTool("propose_aura_action", {
    actionType: "approve_campaign",
    payload: { campaignId: "11111111-1111-4111-8111-111111111111" },
  }, adminCtx);

  assert.equal(result.data.executed, false);
  assert.equal(result.data.requiresEndpointApproval, true);
  assert.equal(actionsTable.length, 1);
  assert.equal(campaignsTable[0].status, "draft");
});

test("approveAction approves campaigns through the domain query and blocks double click", async () => {
  const action = addAction("approve_campaign", {
    campaignId: "11111111-1111-4111-8111-111111111111",
  });

  const approved = await auraActions.approveAction({ ...adminCtx, actionId: action.id });
  assert.equal(approved.status, "completed");
  assert.equal(campaignsTable[0].status, "approved");
  assert.equal(campaignsTable[0].approved_by, 11);
  await assert.rejects(
    () => auraActions.approveAction({ ...adminCtx, actionId: action.id }),
    /Estado actual no permite aprobacion/
  );
});

test("expired actions cannot be approved", async () => {
  const action = addAction("pause_campaign", {
    campaignId: "11111111-1111-4111-8111-111111111111",
  }, 101, { expiresAt: "2020-01-01T00:00:00.000Z" });

  await assert.rejects(
    () => auraActions.approveAction({ ...adminCtx, actionId: action.id }),
    /La accion expiro/
  );
  assert.equal(actionsTable[0].status, "expired");
});

test("tenant A cannot read or approve tenant B actions", async () => {
  const action = addAction("approve_campaign", {
    campaignId: "22222222-2222-4222-8222-222222222222",
  }, 202);

  await assert.rejects(
    () => auraActions.getAction({ ...adminCtx, actionId: action.id }),
    /Accion no encontrada/
  );
  await assert.rejects(
    () => auraActions.approveAction({ ...adminCtx, actionId: action.id }),
    /Accion no encontrada/
  );
  assert.equal(campaignsTable[1].status, "draft");
});

test("manager cannot approve discount actions", async () => {
  const action = addAction("create_discount_draft", {
    name: "VIP",
    type: "percentage",
    value: 10,
    startsAt: "2026-07-15T00:00:00.000Z",
    endsAt: "2026-07-20T00:00:00.000Z",
    scope: "all",
  });

  await assert.rejects(
    () => auraActions.approveAction({ ...managerCtx, actionId: action.id }),
    /Permiso insuficiente/
  );
  assert.equal(discountsTable.length, 0);
});

test("rejectAction does not execute anything", async () => {
  const action = addAction("approve_campaign", {
    campaignId: "11111111-1111-4111-8111-111111111111",
  });

  const rejected = await auraActions.rejectAction({ ...adminCtx, actionId: action.id, reason: "no hoy" });
  assert.equal(rejected.status, "rejected");
  assert.equal(campaignsTable[0].status, "draft");
});

test("enqueue campaign delivery respects consent, opt-out and tenant isolation", async () => {
  campaignsTable[0].status = "approved";
  const action = addAction("enqueue_campaign_delivery", {
    campaignId: "11111111-1111-4111-8111-111111111111",
  });

  const approved = await auraActions.approveAction({ ...adminCtx, actionId: action.id });
  assert.equal(approved.status, "completed");
  assert.equal(notificationQueue.length, 1);
  assert.equal(notificationQueue[0].owner_admin_id, 101);
  assert.equal(notificationQueue[0].recipient_user_id, 41);
  assert.deepEqual(notificationQueue[0].recipient, { userId: 41 });
  assert.equal(JSON.stringify(notificationQueue).includes("x@example.test"), false);
});

test("enqueue campaign delivery requires prior human approval", async () => {
  const action = addAction("enqueue_campaign_delivery", {
    campaignId: "11111111-1111-4111-8111-111111111111",
  });

  await assert.rejects(
    () => auraActions.approveAction({ ...adminCtx, actionId: action.id }),
    (err) => err.code === "CAMPAIGN_APPROVAL_REQUIRED"
  );
  assert.equal(notificationQueue.length, 0);
  assert.equal(campaignsTable[0].status, "draft");
});

test("claimNotificationJobs never reclaims terminal legacy rows regardless of attempts", async () => {
  notificationQueue.push(
    {
      id: 1,
      owner_admin_id: 101,
      status: "pending",
      attempts: 0,
      max_attempts: 3,
      available_at: "2026-07-14T11:00:00.000Z",
      scheduled_for: "2026-07-14T11:00:00.000Z",
    },
    {
      id: 2,
      owner_admin_id: 101,
      status: "sent",
      attempts: 0,
      max_attempts: 3,
      available_at: "2026-07-14T11:00:00.000Z",
      scheduled_for: "2026-07-14T11:00:00.000Z",
    },
    { id: 3, owner_admin_id: 101, status: "pending", attempts: 3, max_attempts: 3 },
    {
      id: 5,
      owner_admin_id: 101,
      status: "failed",
      attempts: 0,
      max_attempts: 3,
      available_at: "2026-07-14T11:00:00.000Z",
      scheduled_for: "2026-07-14T11:00:00.000Z",
    },
    {
      id: 4,
      owner_admin_id: 101,
      status: "pending",
      attempts: 0,
      max_attempts: 3,
      available_at: "2026-07-14T13:00:00.000Z",
      scheduled_for: "2026-07-14T13:00:00.000Z",
    }
  );

  const rows = await notificationOutbox.claimNotificationJobs(10, "worker-a");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "sending");
  assert.equal(notificationQueue[0].locked_by, "worker-a");
  assert.deepEqual(
    notificationQueue.filter((row) => [2, 5].includes(row.id)).map((row) => ({
      id: row.id,
      status: row.status,
      attempts: row.attempts,
    })),
    [
      { id: 2, status: "sent", attempts: 0 },
      { id: 5, status: "failed", attempts: 0 },
    ]
  );
  const claimCall = calls.find((call) => call.sql.includes("FOR UPDATE SKIP LOCKED"));
  assert.ok(claimCall);
  assert.match(claimCall.sql, /status = 'pending'/);
  assert.match(claimCall.sql, /available_at <= NOW\(\)/);
  assert.match(claimCall.sql, /scheduled_for <= NOW\(\)/);
  assert.match(claimCall.sql, /attempts < max_attempts/);
  assert.match(claimCall.sql, /UPDATE notification_queue nq[\s\S]*status = 'sending'/);
  assert.doesNotMatch(claimCall.sql, /status IN \('pending', 'queued'\)/);
});
