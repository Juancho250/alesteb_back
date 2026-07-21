const test = require("node:test");
const assert = require("node:assert/strict");

const dbPath = require.resolve("../src/platform/database");
const calls = [];
const campaignsTable = [];
const segmentsTable = [];
const contentsTable = [];
const attributionsTable = [];

const users = [
  { id: 41, owner_admin_id: 101, email: "cliente41@example.test", phone: "+573001111111", is_active: true, role: "user" },
  { id: 42, owner_admin_id: 101, email: "cliente42@example.test", phone: "+573002222222", is_active: true, role: "user" },
  { id: 43, owner_admin_id: 101, email: "cliente43@example.test", phone: "+573003333333", is_active: true, role: "user" },
  { id: 44, owner_admin_id: 101, email: "", phone: "+573004444444", is_active: true, role: "user" },
  { id: 51, owner_admin_id: 202, email: "cliente51@example.test", phone: "+573005555555", is_active: true, role: "user" },
];

const discounts = [
  { id: 7, owner_admin_id: 101 },
  { id: 8, owner_admin_id: 202 },
];

const consents = [
  { owner_admin_id: 101, user_id: 41, channel: "email", status: "granted", source: "checkout" },
  { owner_admin_id: 101, user_id: 42, channel: "email", status: "revoked", source: "opt_out" },
  { owner_admin_id: 101, user_id: 44, channel: "email", status: "granted", source: "manual" },
  { owner_admin_id: 202, user_id: 51, channel: "email", status: "granted", source: "checkout" },
];

const sales = [
  { id: 900, owner_admin_id: 101, customer_id: 41, payment_status: "paid", status: "completed", delivery_status: "delivered", total: 125000 },
  { id: 901, owner_admin_id: 101, customer_id: 41, payment_status: "cancelled", status: "cancelled", delivery_status: "cancelled", total: 99000 },
  { id: 902, owner_admin_id: 202, customer_id: 51, payment_status: "paid", status: "completed", delivery_status: "delivered", total: 225000 },
];

function now() {
  return new Date("2026-07-14T12:00:00Z");
}

function joinedCampaign(row) {
  const segment = segmentsTable.find((item) => item.id === row.segment_id && item.owner_admin_id === row.owner_admin_id);
  return {
    ...row,
    segment_name: segment?.name || null,
    segment_definition: segment?.definition || null,
    segment_estimated_size: segment?.estimated_size || 0,
  };
}

function isPaidSale(sale) {
  return sale
    && sale.payment_status === "paid"
    && !["cancelled", "canceled", "anulado", "annulled", "void"].includes(String(sale.status || "").toLowerCase())
    && !["cancelled", "canceled"].includes(String(sale.delivery_status || "").toLowerCase());
}

async function handleQuery(sql, params = []) {
  calls.push({ sql, params });

  if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
    return { rows: [], rowCount: 0 };
  }

  if (sql.includes("SELECT id") && sql.includes("FROM discounts")) {
    const found = discounts.find((row) => row.id === Number(params[0]) && row.owner_admin_id === Number(params[1]));
    return { rows: found ? [{ id: found.id }] : [], rowCount: found ? 1 : 0 };
  }

  if (sql.includes("INSERT INTO marketing_segments")) {
    const row = {
      id: params[0],
      owner_admin_id: params[1],
      name: params[2],
      definition: JSON.parse(params[3]),
      estimated_size: params[4],
      created_by: params[5],
      created_at: now(),
      updated_at: now(),
    };
    segmentsTable.push(row);
    return { rows: [row], rowCount: 1 };
  }

  if (sql.includes("INSERT INTO marketing_campaigns")) {
    const row = {
      id: params[0],
      owner_admin_id: params[1],
      name: params[2],
      objective: params[3],
      channel: params[4],
      status: params[5],
      segment_id: params[6],
      discount_id: params[7],
      created_by: params[8],
      scheduled_at: params[9],
      budget: params[10],
      currency: params[11],
      source_type: params[12],
      ai_generated: params[13],
      approved_by: null,
      started_at: null,
      completed_at: null,
      created_at: now(),
      updated_at: now(),
    };
    campaignsTable.push(row);
    return { rows: [row], rowCount: 1 };
  }

  if (sql.includes("SELECT COALESCE(MAX(version), 0) + 1 AS next_version")) {
    const versions = contentsTable
      .filter((row) => row.campaign_id === params[0] && row.channel === params[1])
      .map((row) => row.version);
    return { rows: [{ next_version: versions.length ? Math.max(...versions) + 1 : 1 }], rowCount: 1 };
  }

  if (sql.includes("INSERT INTO campaign_contents")) {
    const row = {
      id: contentsTable.length + 1,
      campaign_id: params[0],
      channel: params[1],
      version: params[2],
      headline: params[3],
      body: params[4],
      call_to_action: params[5],
      metadata: JSON.parse(params[6]),
      prompt_version: params[7],
      model: params[8],
      created_by: params[9],
      created_at: now(),
    };
    contentsTable.push(row);
    return { rows: [row], rowCount: 1 };
  }

  if (sql.includes("FROM marketing_campaigns mc") && sql.includes("mc.id = $2") && sql.includes("LIMIT 1")) {
    const row = campaignsTable.find((item) => item.owner_admin_id === Number(params[0]) && item.id === params[1]);
    return { rows: row ? [joinedCampaign(row)] : [], rowCount: row ? 1 : 0 };
  }

  if (sql.includes("FROM campaign_contents") && sql.includes("ORDER BY channel ASC")) {
    return {
      rows: contentsTable.filter((row) => row.campaign_id === params[0]),
      rowCount: contentsTable.filter((row) => row.campaign_id === params[0]).length,
    };
  }

  if (sql.includes("FROM marketing_campaigns mc") && sql.includes("ORDER BY mc.created_at DESC")) {
    let rows = campaignsTable.filter((row) => row.owner_admin_id === Number(params[0]));
    if (sql.includes("mc.status =")) rows = rows.filter((row) => row.status === params[1]);
    if (sql.includes("mc.channel =")) {
      const channel = params.find((value) => ["email", "whatsapp", "push", "instagram", "tiktok"].includes(value));
      rows = rows.filter((row) => row.channel === channel);
    }
    return { rows: rows.map(joinedCampaign), rowCount: rows.length };
  }

  if (sql.includes("SELECT status") && sql.includes("FROM marketing_campaigns")) {
    const row = campaignsTable.find((item) => item.owner_admin_id === Number(params[0]) && item.id === params[1]);
    return { rows: row ? [{ status: row.status }] : [], rowCount: row ? 1 : 0 };
  }

  if (sql.includes("DELETE FROM marketing_campaigns")) {
    const index = campaignsTable.findIndex((item) => item.owner_admin_id === Number(params[0]) && item.id === params[1]);
    if (index >= 0) campaignsTable.splice(index, 1);
    return { rows: [], rowCount: index >= 0 ? 1 : 0 };
  }

  if (sql.includes("WITH candidates AS")) {
    const ownerAdminId = Number(params[0]);
    const channel = params[1];
    const candidates = users.filter((user) => user.owner_admin_id === ownerAdminId && user.is_active && user.role === "user");
    const evaluated = candidates.map((user) => {
      const consent = consents.find(
        (row) => row.owner_admin_id === ownerAdminId && row.user_id === user.id && row.channel === channel
      );
      const hasContact = channel === "email"
        ? Boolean(user.email && user.email.trim())
        : Boolean(user.phone && user.phone.trim());
      return { consentStatus: consent?.status || null, hasContact };
    });
    return {
      rows: [{
        candidates: evaluated.length,
        eligible: evaluated.filter((row) => row.consentStatus === "granted" && row.hasContact).length,
        opt_out: evaluated.filter((row) => row.consentStatus === "revoked").length,
        missing_consent: evaluated.filter((row) => row.consentStatus === null || row.consentStatus === "unknown").length,
        missing_contact: evaluated.filter((row) => row.consentStatus === "granted" && !row.hasContact).length,
      }],
      rowCount: 1,
    };
  }

  if (sql.includes("COUNT(*) FILTER (WHERE cr.status = 'ready')")) {
    return {
      rows: [{
        prepared_ready: 0,
        prepared_excluded: 0,
        queued_active: 0,
        sent: 0,
        failed: 0,
      }],
      rowCount: 1,
    };
  }

  if (sql.includes("INSERT INTO campaign_attributions")) {
    const [campaignId, ownerAdminId, saleId, recipientUserId, paymentReference, attributionModel] = params;
    const campaign = campaignsTable.find((row) => row.id === campaignId && row.owner_admin_id === Number(ownerAdminId));
    const sale = sales.find(
      (row) => row.id === Number(saleId)
        && row.owner_admin_id === Number(ownerAdminId)
        && row.customer_id === Number(recipientUserId)
    );
    if (!campaign || !isPaidSale(sale)) return { rows: [], rowCount: 0 };
    const duplicate = attributionsTable.find(
      (row) => row.campaign_id === campaignId && row.sale_id === Number(saleId) && row.attribution_model === attributionModel
    );
    if (duplicate) return { rows: [], rowCount: 0 };
    const row = {
      id: attributionsTable.length + 1,
      campaign_id: campaignId,
      owner_admin_id: Number(ownerAdminId),
      recipient_user_id: sale.customer_id,
      sale_id: sale.id,
      payment_reference: paymentReference,
      attribution_model: attributionModel,
      attributed_revenue: sale.total,
      occurred_at: now(),
      created_at: now(),
    };
    attributionsTable.push(row);
    return { rows: [row], rowCount: 1 };
  }

  throw new Error(`Unexpected campaign test query: ${sql.slice(0, 120)}`);
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

const auraCampaigns = require("../services/auraCampaigns.service");

const ctxA = { ownerAdminId: 101, userId: 11, roles: ["admin"] };
const ctxB = { ownerAdminId: 202, userId: 22, roles: ["admin"] };

test.beforeEach(() => {
  calls.length = 0;
  campaignsTable.length = 0;
  segmentsTable.length = 0;
  contentsTable.length = 0;
  attributionsTable.length = 0;
});

async function createEmailDraft(ctx = ctxA) {
  return auraCampaigns.createCampaignDraft({
    ...ctx,
    payload: {
      name: "Reactivacion julio",
      objective: "reactivar clientes dormidos",
      channel: "email",
      discountId: ctx.ownerAdminId === 101 ? 7 : undefined,
      segmentName: "Clientes dormidos",
      segmentDefinition: { type: "inactive_customers", days: 60 },
      content: {
        headline: "Vuelve a ALESTEB",
        body: "Tenemos una seleccion especial para ti.",
        callToAction: "Ver seleccion",
        metadata: { source: "test" },
      },
    },
  });
}

test("AURA Growth creates draft campaigns without queuing sends", async () => {
  const draft = await createEmailDraft();

  assert.equal(draft.ownerAdminId, 101);
  assert.equal(draft.status, "draft");
  assert.equal(draft.discountId, 7);
  assert.equal(draft.segment.definition.type, "inactive_customers");
  assert.equal(draft.contents[0].body, "Tenemos una seleccion especial para ti.");
  assert.equal(draft.safety.sendEnabled, false);
  assert.equal(draft.safety.automaticActionsEnabled, false);
  assert.equal(calls.some((call) => call.sql.includes("INSERT INTO notification_queue")), false);
  assert.equal(calls.some((call) => call.sql.includes("INSERT INTO campaign_recipients")), false);
});

test("AURA Growth rejects cross-tenant discounts", async () => {
  await assert.rejects(
    () => auraCampaigns.createCampaignDraft({
      ...ctxA,
      payload: {
        name: "Cruce bloqueado",
        objective: "usar descuento ajeno",
        channel: "email",
        discountId: 8,
      },
    }),
    /Descuento no encontrado/
  );
});

test("AURA Growth list and read operations are tenant-scoped", async () => {
  const tenantA = await createEmailDraft(ctxA);
  const tenantB = await createEmailDraft(ctxB);

  const listA = await auraCampaigns.listCampaigns({ ...ctxA, query: {} });
  assert.deepEqual(listA.rows.map((row) => row.id), [tenantA.id]);

  await assert.rejects(
    () => auraCampaigns.getCampaign({ ...ctxA, campaignId: tenantB.id }),
    /Campana no encontrada/
  );

  const campaignCalls = calls.filter((call) => call.sql.includes("marketing_campaigns"));
  assert.ok(campaignCalls.every((call) => call.params.includes(101) || call.params.includes(202)));
});

test("AURA Growth audience estimates respect consent, opt-out and missing contacts without PII", async () => {
  const draft = await createEmailDraft();
  const estimate = await auraCampaigns.estimateCampaignAudience({
    ...ctxA,
    campaignId: draft.id,
    definition: { type: "all_customers" },
  });

  assert.equal(estimate.exportOnly, false);
  assert.equal(estimate.sendReady, false);
  assert.deepEqual(estimate.totals, {
    candidates: 4,
    eligible: 1,
    missingConsent: 1,
    optOut: 1,
    missingContact: 1,
  });
  const serialized = JSON.stringify(estimate);
  assert.equal(serialized.includes("@example.test"), false);
  assert.equal(serialized.includes("+57300"), false);
});

test("AURA Growth preview is read-only and blocks unapproved delivery", async () => {
  const draft = await auraCampaigns.createCampaignDraft({
    ...ctxA,
    payload: {
      name: "Preview seguro",
      objective: "retention",
      channel: "email",
      content: { body: "Contenido de prueba" },
    },
  });
  const callCount = calls.length;
  const preview = await auraCampaigns.previewCampaignDelivery({ ...ctxA, campaignId: draft.id });

  assert.equal(preview.dryRun, true);
  assert.equal(preview.canEnqueue, false);
  assert.ok(preview.blockers.includes("approval_required"));
  assert.equal(preview.audience.eligible, 1);
  const previewCalls = calls.slice(callCount);
  assert.equal(previewCalls.some((call) => /\b(INSERT|UPDATE|DELETE)\b/.test(call.sql)), false);
});

test("AURA Growth treats Instagram and TikTok as export-only channels", async () => {
  const draft = await auraCampaigns.createCampaignDraft({
    ...ctxA,
    payload: {
      name: "Video lanzamiento",
      objective: "presentar novedades",
      channel: "tiktok",
      content: {
        body: "Guion exportable para video corto.",
      },
    },
  });
  const estimate = await auraCampaigns.estimateCampaignAudience({ ...ctxA, campaignId: draft.id });

  assert.equal(draft.safety.exportOnly, true);
  assert.equal(estimate.exportOnly, true);
  assert.equal(estimate.totals.eligible, 0);
  assert.equal(calls.some((call) => call.sql.includes("notification_queue")), false);
});

test("AURA Growth attributes only paid non-cancelled same-tenant sales", async () => {
  const draft = await createEmailDraft();

  const attributed = await auraCampaigns.recordPaidSaleAttribution({
    ...ctxA,
    campaignId: draft.id,
    saleId: 900,
    recipientUserId: 41,
    paymentReference: "WOMPI-OK",
  });
  const cancelled = await auraCampaigns.recordPaidSaleAttribution({
    ...ctxA,
    campaignId: draft.id,
    saleId: 901,
    recipientUserId: 41,
  });
  const crossTenant = await auraCampaigns.recordPaidSaleAttribution({
    ...ctxA,
    campaignId: draft.id,
    saleId: 902,
    recipientUserId: 51,
  });

  assert.equal(attributed.saleId, 900);
  assert.equal(attributed.attributedRevenue, 125000);
  assert.equal(cancelled, null);
  assert.equal(crossTenant, null);
});

test("AURA Growth allows deleting only non-executed draft campaigns", async () => {
  const draft = await createEmailDraft();
  const deleted = await auraCampaigns.deleteCampaign({ ...ctxA, campaignId: draft.id });

  assert.equal(deleted, true);
  assert.equal(campaignsTable.length, 0);

  const running = await createEmailDraft();
  campaignsTable[0].status = "running";
  await assert.rejects(
    () => auraCampaigns.deleteCampaign({ ...ctxA, campaignId: running.id }),
    /Solo campanas no ejecutadas/
  );
});
