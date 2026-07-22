const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  WHATSAPP_PROVIDER: process.env.WHATSAPP_PROVIDER,
  META_WA_APP_SECRET: process.env.META_WA_APP_SECRET,
};
process.env.NODE_ENV = "production";
process.env.WHATSAPP_PROVIDER = "meta_cloud";
process.env.META_WA_APP_SECRET = "test-meta-secret";

const updates = [];
function mockModule(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

mockModule("../src/platform/database", { query: async () => ({ rows: [], rowCount: 0 }) });
mockModule("../src/modules/notifications/notification.service", {
  getOrCreateSettings: async () => ({}),
  enqueueNotification: async () => null,
});
mockModule("../services/providers/whatsapp.provider", {});
mockModule("../src/modules/notifications/notification-outbox.service", {
  async updateProviderStatusByMessageId(providerMessageId, status, metadata) {
    updates.push({ providerMessageId, status, metadata });
    return { updated: 1 };
  },
});

const controller = require("../src/modules/notifications/notifications.controller");

function responseMock() {
  return {
    statusCode: null,
    sendStatus(code) {
      this.statusCode = code;
      return this;
    },
  };
}

function metaRequest(signature) {
  const body = {
    entry: [{ changes: [{ value: { statuses: [{ id: "provider-message-1", status: "delivered" }] } }] }],
  };
  const rawBody = Buffer.from(JSON.stringify(body));
  return {
    headers: { "x-hub-signature-256": signature },
    rawBody,
    body,
    protocol: "https",
    originalUrl: "/api/notifications/webhook/whatsapp",
    get: () => "staging.example.test",
  };
}

test.after(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test.beforeEach(() => updates.splice(0));

test("WhatsApp webhook rejects an invalid Meta signature", async () => {
  const req = metaRequest("sha256=invalid");
  const res = responseMock();
  await controller.webhookWhatsapp(req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(updates.length, 0);
});

test("WhatsApp webhook accepts a valid signature and maps provider status", async () => {
  const req = metaRequest(null);
  req.headers["x-hub-signature-256"] = "sha256=" + crypto
    .createHmac("sha256", process.env.META_WA_APP_SECRET)
    .update(req.rawBody)
    .digest("hex");
  const res = responseMock();
  await controller.webhookWhatsapp(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].providerMessageId, "provider-message-1");
  assert.equal(updates[0].status, "delivered");
});
