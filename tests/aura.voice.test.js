const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.AURA_VOICE_ENABLED = "true";
process.env.OPENAI_API_KEY = "sk-test-aura-voice";
process.env.OPENAI_TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
process.env.OPENAI_TTS_MODEL = "gpt-4o-mini-tts";
process.env.OPENAI_TTS_VOICE = "marin";
process.env.OPENAI_TTS_FORMAT = "mp3";
process.env.AURA_VOICE_MAX_AUDIO_MB = "1";
process.env.AURA_VOICE_MAX_DURATION_SECONDS = "60";
process.env.AURA_VOICE_SESSION_TTL_SECONDS = "600";

const dbPath = require.resolve("../src/platform/database");
const auraChatPath = require.resolve("../src/modules/aura/core/chat.service");
const axiosPath = require.resolve("axios");

const sessions = [];
const turns = [];
const dbCalls = [];
const chatCalls = [];
const axiosCalls = [];

let transcriptText = "ventas de hoy";
let providerFailure = null;

function now() {
  return new Date("2026-07-14T12:00:00Z");
}

function future(seconds = 600) {
  return new Date(Date.now() + seconds * 1000);
}

function past() {
  return new Date(Date.now() - 1000);
}

function resetData() {
  sessions.length = 0;
  turns.length = 0;
  dbCalls.length = 0;
  chatCalls.length = 0;
  axiosCalls.length = 0;
  transcriptText = "ventas de hoy";
  providerFailure = null;
}

const fakeDb = {
  async query(sql, params = []) {
    dbCalls.push({ sql, params });

    if (sql.includes("INSERT INTO aura_voice_sessions")) {
      const row = {
        id: params[0],
        owner_admin_id: params[1],
        user_id: params[2],
        conversation_id: params[3],
        status: "active",
        expires_at: future(params[4]),
        last_activity_at: now(),
        created_at: now(),
        closed_at: null,
      };
      sessions.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.includes("FROM aura_voice_sessions") && sql.includes("LIMIT 1")) {
      const row = sessions.find((item) => (
        Number(item.owner_admin_id) === Number(params[0]) &&
        Number(item.user_id) === Number(params[1]) &&
        item.id === params[2]
      ));
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.includes("UPDATE aura_voice_sessions") && sql.includes("CASE WHEN status = 'active'")) {
      const row = sessions.find((item) => item.id === params[2]);
      if (row && row.status === "active") row.status = "expired";
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (sql.includes("UPDATE aura_voice_sessions") && sql.includes("SET status = 'closed'")) {
      const row = sessions.find((item) => (
        Number(item.owner_admin_id) === Number(params[0]) &&
        Number(item.user_id) === Number(params[1]) &&
        item.id === params[2]
      ));
      if (!row) return { rows: [], rowCount: 0 };
      row.status = "closed";
      row.closed_at = now();
      return { rows: [{ ...row }], rowCount: 1 };
    }

    if (sql.includes("INSERT INTO aura_voice_turns")) {
      const row = {
        id: params[0],
        session_id: params[1],
        owner_admin_id: params[2],
        user_id: params[3],
        conversation_id: params[4],
        request_id: params[5],
        status: "transcribing",
        audio_mime_type: params[6],
        audio_size_bytes: params[7],
        audio_duration_seconds: params[8],
      };
      turns.push(row);
      return { rows: [{ id: row.id }], rowCount: 1 };
    }

    if (sql.includes("UPDATE aura_voice_turns") && sql.includes("status = 'failed'")) {
      const row = turns.find((item) => item.id === params[0] && Number(item.owner_admin_id) === Number(params[1]));
      if (row) {
        row.status = "failed";
        row.error_code = params[2];
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (sql.includes("UPDATE aura_voice_turns") && sql.includes("status = 'responding'")) {
      const row = turns.find((item) => item.id === params[0]);
      if (row) row.status = "responding";
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (sql.includes("UPDATE aura_voice_turns") && sql.includes("status = 'synthesizing'")) {
      const row = turns.find((item) => item.id === params[0]);
      if (row) row.status = "synthesizing";
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (sql.includes("UPDATE aura_voice_turns") && sql.includes("suggested_actions")) {
      const row = turns.find((item) => item.id === params[0] && Number(item.owner_admin_id) === Number(params[1]));
      if (row) {
        row.status = params[2];
        row.aura_run_id = params[3];
        row.conversation_id = params[4] || row.conversation_id;
        row.transcript_redacted = params[5];
        row.response_text_redacted = params[6];
        row.suggested_actions = JSON.parse(params[7]);
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (sql.includes("UPDATE aura_voice_sessions") && sql.includes("last_activity_at = NOW()")) {
      const row = sessions.find((item) => (
        Number(item.owner_admin_id) === Number(params[0]) &&
        Number(item.user_id) === Number(params[1]) &&
        item.id === params[2]
      ));
      if (row) {
        row.conversation_id = params[3] || row.conversation_id;
        row.expires_at = future(params[4]);
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    throw new Error(`Unexpected voice test query: ${sql.slice(0, 100)}`);
  },
};

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: fakeDb,
};

require.cache[auraChatPath] = {
  id: auraChatPath,
  filename: auraChatPath,
  loaded: true,
  exports: {
    normalizeConversationId(value) {
      if (value === undefined || value === null || value === "") return null;
      const text = String(value).trim();
      if (!/^[A-Za-z0-9-]{1,100}$/.test(text)) {
        const err = new Error("conversationId invalido");
        err.code = "INVALID_CONVERSATION_ID";
        throw err;
      }
      return text;
    },
    async executeAuraChat(input) {
      chatCalls.push(input);
      return {
        runId: "11111111-1111-4111-8111-111111111111",
        conversationId: input.conversationId || "voice-conv-1",
        answer: "AURA detecta ventas positivas y recomienda revisar bajo stock.",
        suggestions: [{
          type: "inventory_review",
          label: "Revisar inventario",
          priority: "high",
          requiresConfirmation: true,
        }],
      };
    },
  },
};

require.cache[axiosPath] = {
  id: axiosPath,
  filename: axiosPath,
  loaded: true,
  exports: {
    async post(url, payload, options) {
      axiosCalls.push({ url, payload, options });
      if (providerFailure) throw providerFailure;
      if (url.includes("/audio/transcriptions")) {
        return { data: { text: transcriptText } };
      }
      if (url.includes("/audio/speech")) {
        return { data: Buffer.from("fake-audio") };
      }
      throw new Error(`Unexpected axios URL ${url}`);
    },
  },
};

const voice = require("../services/auraVoice.service");

function ctx(ownerAdminId = 101, userId = 11) {
  return {
    ownerAdminId,
    userId,
    roles: ["admin"],
    requestId: "55555555-5555-4555-8555-555555555555",
  };
}

function audio(overrides = {}) {
  return {
    buffer: Buffer.from("audio"),
    size: 5,
    mimetype: "audio/webm",
    originalname: "aura.webm",
    ...overrides,
  };
}

test.beforeEach(resetData);

test("AURA Voice requires authenticated tenant context", async () => {
  await assert.rejects(
    () => voice.createSession({ ownerAdminId: null, userId: 11 }),
    { code: "AURA_VOICE_CONTEXT_REQUIRED" }
  );
});

test("AURA Voice creates tenant-aware sessions and blocks cross-tenant access", async () => {
  const session = await voice.createSession(ctx(101, 11));
  const own = await voice.getSession({ ...ctx(101, 11), sessionId: session.id });
  const otherTenant = await voice.getSession({ ...ctx(202, 11), sessionId: session.id });

  assert.equal(own.id, session.id);
  assert.equal(otherTenant, null);
});

test("AURA Voice rejects expired sessions before provider calls", async () => {
  const session = await voice.createSession(ctx());
  sessions[0].expires_at = past();

  await assert.rejects(
    () => voice.processTurn({ ...ctx(), sessionId: session.id, file: audio(), durationSeconds: 3 }),
    { code: "AURA_VOICE_SESSION_EXPIRED" }
  );
  assert.equal(axiosCalls.length, 0);
});

test("AURA Voice rejects invalid audio type and excessive duration", () => {
  assert.throws(
    () => voice.validateAudioFile(audio({ mimetype: "text/plain" }), 1),
    { code: "AURA_VOICE_UNSUPPORTED_AUDIO" }
  );
  assert.throws(
    () => voice.validateAudioFile(audio(), 90),
    { code: "AURA_VOICE_AUDIO_TOO_LONG" }
  );
});

test("AURA Voice consumes quota on turn routes and inherits secure AURA middleware", () => {
  const routeSource = fs.readFileSync(path.join(__dirname, "../src/modules/aura/aura.routes.js"), "utf8");
  assert.match(routeSource, /router\.use\(auth\)/);
  assert.match(routeSource, /router\.use\(adminScope\)/);
  assert.match(routeSource, /router\.use\(requireFeature\("has_ai_agent"\)\)/);
  assert.match(routeSource, /"\/voice\/sessions\/:id\/turn"[\s\S]*auraQuota[\s\S]*voiceCtrl\.processTurn/);
});

test("AURA Voice records provider errors without completing the turn", async () => {
  const session = await voice.createSession(ctx());
  providerFailure = new Error("provider down");

  await assert.rejects(
    () => voice.processTurn({ ...ctx(), sessionId: session.id, file: audio(), durationSeconds: 3 }),
    { code: "AURA_VOICE_TRANSCRIPTION_FAILED" }
  );
  assert.equal(turns.at(-1).status, "failed");
  assert.equal(turns.at(-1).error_code, "AURA_VOICE_TRANSCRIPTION_FAILED");
});

test("AURA Voice never treats textual confirmation as approval", async () => {
  const session = await voice.createSession(ctx());
  transcriptText = "si";

  const result = await voice.processTurn({ ...ctx(), sessionId: session.id, file: audio(), durationSeconds: 2 });

  assert.equal(result.blockedActionConfirmation, true);
  assert.match(result.answer, /no puedo aprobar/i);
  assert.equal(chatCalls.length, 0);
  assert.equal(turns.at(-1).status, "blocked_confirmation");
});

test("AURA Voice normal turn reuses the textual AURA core and returns spoken audio", async () => {
  const session = await voice.createSession({ ...ctx(), conversationId: "conv-1" });

  const result = await voice.processTurn({ ...ctx(), sessionId: session.id, file: audio(), durationSeconds: 4 });

  assert.equal(result.conversationId, "conv-1");
  assert.equal(result.runId, "11111111-1111-4111-8111-111111111111");
  assert.equal(result.transcript, "ventas de hoy");
  assert.equal(result.audio.mimeType, "audio/mpeg");
  assert.equal(result.audio.base64, Buffer.from("fake-audio").toString("base64"));
  assert.deepEqual(chatCalls[0], {
    ownerAdminId: 101,
    userId: 11,
    roles: ["admin"],
    message: "ventas de hoy",
    conversationId: "conv-1",
    requestId: "55555555-5555-4555-8555-555555555555",
  });
});
