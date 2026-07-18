const test = require("node:test");
const assert = require("node:assert/strict");

process.env.AURA_SEND_TIME_MIN_OBSERVATIONS = "10";
process.env.AURA_SEND_TIME_MIN_CAMPAIGNS = "2";

const dbPath = require.resolve("../config/db");
const calls = [];
const runs = [];
const snapshots = [];
let observedRows = [];
let settingsByTenant = new Map();
let consentRows = [];

async function handleQuery(sql, params = []) {
  calls.push({ sql, params });

  if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };

  if (sql.includes("FROM (SELECT $1::int AS admin_id) seed")) {
    const settings = settingsByTenant.get(Number(params[0])) || {};
    return {
      rows: [{
        notification_timezone: settings.timezone || "America/Bogota",
        quiet_hours_start: settings.quiet_hours_start || "22:00",
        quiet_hours_end: settings.quiet_hours_end || "08:00",
        profile_timezone: null,
      }],
      rowCount: 1,
    };
  }

  if (sql.includes("FROM aura_send_time_metric_runs") && sql.includes("LIMIT 1")) {
    const row = runs
      .filter((item) =>
        Number(item.owner_admin_id) === Number(params[0])
        && item.as_of_date === params[1]
        && item.metric_version === params[2]
        && Number(item.min_observations) === Number(params[3])
        && Number(item.min_campaigns) === Number(params[4])
        && item.status === "completed"
      )
      .at(-1);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }

  if (sql.includes("INSERT INTO aura_send_time_metric_runs")) {
    runs.push({
      id: params[0],
      owner_admin_id: Number(params[1]),
      as_of_date: params[2],
      metric_version: params[3],
      timezone: params[4],
      timezone_source: params[5],
      min_observations: Number(params[6]),
      min_campaigns: Number(params[7]),
      status: "running",
      rows_count: 0,
      created_at: "2026-07-14T00:00:00Z",
      completed_at: null,
    });
    return { rows: [], rowCount: 1 };
  }

  if (sql.includes("WITH raw_events AS")) {
    return {
      rows: observedRows.filter((row) => Number(row.owner_admin_id || params[0]) === Number(params[0])),
      rowCount: observedRows.length,
    };
  }

  if (sql.includes("INSERT INTO aura_send_time_metric_snapshots")) {
    snapshots.push({
      run_id: params[0],
      owner_admin_id: Number(params[1]),
      as_of_date: params[2],
      metric_version: params[3],
      channel: params[4],
      campaign_type: params[5],
      segment_key: params[6],
      day_of_week: Number(params[7]),
      hour_bucket: params[8],
      hour_start: Number(params[9]),
      hour_end: Number(params[10]),
      campaign_count: Number(params[11]),
      delivered_count: Number(params[12]),
      read_count: Number(params[13]),
      clicked_count: Number(params[14]),
      converted_count: Number(params[15]),
      avg_read_rate: Number(params[16]),
      avg_click_rate: Number(params[17]),
      avg_conversion_rate: Number(params[18]),
      performance_score: Number(params[19]),
      confidence_level: params[20],
      evidence: JSON.parse(params[21]),
      limitations: JSON.parse(params[22]),
      created_at: "2026-07-14T00:01:00Z",
    });
    return { rows: [], rowCount: 1 };
  }

  if (sql.includes("UPDATE aura_send_time_metric_runs")) {
    const run = runs.find((item) => item.id === params[0]);
    if (run) {
      run.status = "completed";
      run.rows_count = Number(params[1]);
      run.data_quality = JSON.parse(params[2]);
      run.completed_at = "2026-07-14T00:01:00Z";
    }
    return { rows: [], rowCount: run ? 1 : 0 };
  }

  if (sql.includes("FROM customer_consents")) {
    return {
      rows: consentRows.filter((row) => Number(row.owner_admin_id) === Number(params[0])),
      rowCount: consentRows.length,
    };
  }

  if (sql.includes("FROM aura_send_time_metric_snapshots")) {
    let rows = snapshots.filter((row) => row.run_id === params[0] && Number(row.owner_admin_id) === Number(params[1]));
    if (sql.includes("channel = $3")) rows = rows.filter((row) => row.channel === params[2]);
    return { rows, rowCount: rows.length };
  }

  throw new Error(`Unexpected send-time query: ${sql.slice(0, 120)}`);
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

const sendTime = require("../services/auraSendTime.service");
const auraTools = require("../services/auraTools.service");

const ctxA = { ownerAdminId: 101, userId: 11, roles: ["admin"], query: { asOfDate: "2026-07-14" } };

test.beforeEach(() => {
  calls.length = 0;
  runs.length = 0;
  snapshots.length = 0;
  observedRows = [];
  consentRows = [
    { owner_admin_id: 101, channel: "email", granted: 15 },
    { owner_admin_id: 101, channel: "whatsapp", granted: 30 },
    { owner_admin_id: 202, channel: "email", granted: 5 },
  ];
  settingsByTenant = new Map([
    [101, { timezone: "America/Bogota", quiet_hours_start: "22:00", quiet_hours_end: "08:00" }],
    [202, { timezone: "America/Bogota", quiet_hours_start: "22:00", quiet_hours_end: "08:00" }],
  ]);
});

test("recommends observed channel and slot when volume is sufficient", async () => {
  observedRows = [
    {
      owner_admin_id: 101,
      channel: "email",
      campaign_type: "reactivar",
      segment_key: "dormidos",
      day_of_week: 2,
      hour_bucket: "10_12",
      campaign_count: 3,
      delivered_count: 60,
      read_count: 30,
      clicked_count: 12,
      converted_count: 6,
      avg_read_rate: 0.5,
      avg_click_rate: 0.2,
      avg_conversion_rate: 0.1,
    },
    {
      owner_admin_id: 101,
      channel: "whatsapp",
      campaign_type: "reactivar",
      segment_key: "dormidos",
      day_of_week: 4,
      hour_bucket: "16_18",
      campaign_count: 2,
      delivered_count: 50,
      read_count: 20,
      clicked_count: 5,
      converted_count: 2,
      avg_read_rate: 0.4,
      avg_click_rate: 0.1,
      avg_conversion_rate: 0.04,
    },
  ];

  const result = await sendTime.getSendTimeRecommendation({
    ...ctxA,
    query: { asOfDate: "2026-07-14", campaignType: "reactivar", segment: "dormidos" },
  });

  assert.equal(result.mode, "observed");
  assert.equal(result.recommended, true);
  assert.equal(result.recommendedChannel, "email");
  assert.equal(result.recommendedDay.label, "martes");
  assert.equal(result.recommendedTimeWindow.key, "10_12");
  assert.equal(result.sampleSize, 60);
  assert.equal(result.evidence.biasControl.includes("promediadas"), true);
});

test("uses neutral strategy when observations are insufficient", async () => {
  observedRows = [{
    owner_admin_id: 101,
    channel: "email",
    campaign_type: "generic",
    segment_key: "all_customers",
    day_of_week: 2,
    hour_bucket: "10_12",
    campaign_count: 1,
    delivered_count: 4,
    read_count: 3,
    clicked_count: 2,
    converted_count: 1,
    avg_read_rate: 0.75,
    avg_click_rate: 0.5,
    avg_conversion_rate: 0.25,
  }];

  const result = await sendTime.getSendTimeRecommendation({ ...ctxA, query: { asOfDate: "2026-07-14" } });

  assert.equal(result.mode, "neutral");
  assert.equal(result.recommended, false);
  assert.equal(result.recommendedChannel, null);
  assert.equal(result.confidence, "insuficiente");
  assert.equal(result.neutralFallback.channel, "whatsapp");
});

test("does not recommend a slot overlapping quiet hours", async () => {
  settingsByTenant.set(101, { timezone: "America/Bogota", quiet_hours_start: "10:00", quiet_hours_end: "12:00" });
  observedRows = [
    {
      owner_admin_id: 101,
      channel: "email",
      campaign_type: "generic",
      segment_key: "all_customers",
      day_of_week: 2,
      hour_bucket: "10_12",
      campaign_count: 5,
      delivered_count: 200,
      read_count: 160,
      clicked_count: 80,
      converted_count: 40,
      avg_read_rate: 0.8,
      avg_click_rate: 0.4,
      avg_conversion_rate: 0.2,
    },
    {
      owner_admin_id: 101,
      channel: "email",
      campaign_type: "generic",
      segment_key: "all_customers",
      day_of_week: 3,
      hour_bucket: "14_16",
      campaign_count: 2,
      delivered_count: 25,
      read_count: 8,
      clicked_count: 4,
      converted_count: 1,
      avg_read_rate: 0.32,
      avg_click_rate: 0.16,
      avg_conversion_rate: 0.04,
    },
  ];

  const result = await sendTime.getSendTimeRecommendation({ ...ctxA, query: { asOfDate: "2026-07-14", channel: "email" } });

  assert.equal(result.mode, "observed");
  assert.equal(result.recommendedTimeWindow.key, "14_16");
  assert.equal(result.quietHours.start, "10:00");
});

test("keeps tenant metrics isolated", async () => {
  observedRows = [
    {
      owner_admin_id: 101,
      channel: "email",
      campaign_type: "generic",
      segment_key: "all_customers",
      day_of_week: 2,
      hour_bucket: "10_12",
      campaign_count: 2,
      delivered_count: 20,
      read_count: 10,
      clicked_count: 4,
      converted_count: 1,
      avg_read_rate: 0.5,
      avg_click_rate: 0.2,
      avg_conversion_rate: 0.05,
    },
    {
      owner_admin_id: 202,
      channel: "whatsapp",
      campaign_type: "generic",
      segment_key: "all_customers",
      day_of_week: 5,
      hour_bucket: "18_20",
      campaign_count: 3,
      delivered_count: 90,
      read_count: 80,
      clicked_count: 30,
      converted_count: 8,
      avg_read_rate: 0.88,
      avg_click_rate: 0.33,
      avg_conversion_rate: 0.08,
    },
  ];

  const tenantA = await sendTime.getSendTimeRecommendation({ ...ctxA, query: { asOfDate: "2026-07-14" } });
  const tenantB = await sendTime.getSendTimeRecommendation({
    ownerAdminId: 202,
    userId: 22,
    roles: ["admin"],
    query: { asOfDate: "2026-07-14" },
  });

  assert.equal(tenantA.recommendedChannel, "email");
  assert.equal(tenantB.recommendedChannel, "whatsapp");
  assert.equal(snapshots.some((row) => row.owner_admin_id === 101 && row.channel === "whatsapp"), false);
});

test("suggest_campaign_send_time tool is read-only and never schedules", async () => {
  observedRows = [{
    owner_admin_id: 101,
    channel: "email",
    campaign_type: "generic",
    segment_key: "all_customers",
    day_of_week: 2,
    hour_bucket: "10_12",
    campaign_count: 2,
    delivered_count: 20,
    read_count: 10,
    clicked_count: 4,
    converted_count: 1,
    avg_read_rate: 0.5,
    avg_click_rate: 0.2,
    avg_conversion_rate: 0.05,
  }];

  const result = await auraTools.executeAuraTool("suggest_campaign_send_time", { channel: "email" }, {
    ownerAdminId: 101,
    userId: 11,
    roles: ["admin"],
    requestId: "send-time-test",
  });

  assert.equal(result.success, true);
  assert.equal(result.data.safety.notScheduled, true);
  assert.equal(result.data.safety.noAutomaticSend, true);
  assert.equal(calls.some((call) => call.sql.includes("UPDATE marketing_campaigns")), false);
  assert.equal(calls.some((call) => call.sql.includes("INSERT INTO notification_queue")), false);
});
