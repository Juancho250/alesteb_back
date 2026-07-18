const crypto = require("crypto");
const axios = require("axios");
const db = require("../config/db");
const auraChat = require("./auraChat.service");
const { redactText, redactObject } = require("./auraAudit.service");

const OPENAI_TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";

const DEFAULT_TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts";
const DEFAULT_TTS_VOICE = "marin";
const DEFAULT_TTS_FORMAT = "mp3";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_SESSION_TTL_SECONDS = 10 * 60;
const DEFAULT_TURN_RETENTION_HOURS = 24;
const DEFAULT_MAX_AUDIO_MB = 10;
const DEFAULT_MAX_DURATION_SECONDS = 60;
const DEFAULT_MAX_TRANSCRIPT_CHARS = 2000;

const ALLOWED_AUDIO_TYPES = new Map([
  ["audio/mpeg", "mp3"],
  ["audio/mp3", "mp3"],
  ["audio/mp4", "mp4"],
  ["audio/m4a", "m4a"],
  ["audio/x-m4a", "m4a"],
  ["audio/wav", "wav"],
  ["audio/x-wav", "wav"],
  ["audio/webm", "webm"],
]);

const MIME_BY_TTS_FORMAT = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  opus: "audio/opus",
  aac: "audio/aac",
  flac: "audio/flac",
  pcm: "audio/pcm",
};

function createVoiceError(message, code = "AURA_VOICE_ERROR", status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function envFlag(name, defaultValue = false) {
  const value = process.env[name];
  if (value === undefined || value === null || value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function configuredTimeoutMs() {
  return boundedInt(process.env.AURA_VOICE_OPENAI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000, 60_000);
}

function configuredSessionTtlSeconds() {
  return boundedInt(process.env.AURA_VOICE_SESSION_TTL_SECONDS, DEFAULT_SESSION_TTL_SECONDS, 60, 3600);
}

function configuredTurnRetentionHours() {
  return boundedInt(process.env.AURA_VOICE_RETENTION_HOURS, DEFAULT_TURN_RETENTION_HOURS, 1, 168);
}

function configuredMaxDurationSeconds() {
  return boundedInt(process.env.AURA_VOICE_MAX_DURATION_SECONDS, DEFAULT_MAX_DURATION_SECONDS, 5, 300);
}

function configuredMaxTranscriptChars() {
  return boundedInt(process.env.AURA_VOICE_MAX_TRANSCRIPT_CHARS, DEFAULT_MAX_TRANSCRIPT_CHARS, 200, 4000);
}

function getMaxAudioBytes() {
  const mb = boundedInt(process.env.AURA_VOICE_MAX_AUDIO_MB, DEFAULT_MAX_AUDIO_MB, 1, 25);
  return mb * 1024 * 1024;
}

function isVoiceEnabled() {
  return envFlag("AURA_VOICE_ENABLED", false);
}

function isVoiceMockProviderEnabled() {
  return envFlag("AURA_VOICE_MOCK_PROVIDER_ENABLED", false)
    && (["test", "development"].includes(String(process.env.NODE_ENV || "").toLowerCase())
      || envFlag("AURA_STAGING_MODE", false));
}

function validateAuraVoiceConfig() {
  const enabled = isVoiceEnabled();
  const mockEnabled = isVoiceMockProviderEnabled();
  if (enabled && !process.env.OPENAI_API_KEY && !mockEnabled) {
    console.warn("[AURA Voice] OPENAI_API_KEY no configurada; voz devolvera 503 hasta configurarla.");
  }

  console.log(JSON.stringify({
    level: "info",
    event: "aura_voice_config_validated",
    enabled,
    provider: mockEnabled ? "mock" : "openai",
    transcribeModel: mockEnabled ? "aura-stt-mock-v1" : process.env.OPENAI_TRANSCRIBE_MODEL || DEFAULT_TRANSCRIBE_MODEL,
    ttsModel: mockEnabled ? "aura-tts-mock-v1" : process.env.OPENAI_TTS_MODEL || DEFAULT_TTS_MODEL,
    ttsVoice: process.env.OPENAI_TTS_VOICE || DEFAULT_TTS_VOICE,
    maxAudioBytes: getMaxAudioBytes(),
    maxDurationSeconds: configuredMaxDurationSeconds(),
    timeoutMs: configuredTimeoutMs(),
    hasApiKey: Boolean(process.env.OPENAI_API_KEY),
    mockEnabled,
  }));
}

function requireVoiceEnabled() {
  if (!isVoiceEnabled()) {
    throw createVoiceError("AURA Voice no esta habilitado", "AURA_VOICE_DISABLED", 403);
  }
}

function requireOpenAIKey() {
  if (isVoiceMockProviderEnabled()) return;
  if (!process.env.OPENAI_API_KEY) {
    throw createVoiceError("OPENAI_API_KEY no configurada", "AURA_OPENAI_MISSING_KEY", 503);
  }
}

function requireCtx(ctx) {
  if (!ctx?.ownerAdminId || !ctx?.userId) {
    throw createVoiceError("Contexto AURA Voice incompleto", "AURA_VOICE_CONTEXT_REQUIRED", 401);
  }
  return {
    ownerAdminId: Number(ctx.ownerAdminId),
    userId: Number(ctx.userId),
    roles: Array.isArray(ctx.roles) ? ctx.roles : [],
    requestId: ctx.requestId || crypto.randomUUID(),
  };
}

function normalizeSessionId(value) {
  const text = String(value || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw createVoiceError("sessionId invalido", "AURA_VOICE_INVALID_SESSION", 400);
  }
  return text;
}

function parseDurationSeconds(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw createVoiceError("durationSeconds invalido", "AURA_VOICE_INVALID_DURATION", 400);
  }
  return Math.round(parsed * 100) / 100;
}

function validateAudioFile(file, durationInput) {
  if (!file || !file.buffer || !file.size) {
    throw createVoiceError("audio es requerido", "AURA_VOICE_AUDIO_REQUIRED", 400);
  }

  const mimeType = String(file.mimetype || "").toLowerCase();
  const extension = ALLOWED_AUDIO_TYPES.get(mimeType);
  if (!extension) {
    throw createVoiceError("Tipo de audio no permitido", "AURA_VOICE_UNSUPPORTED_AUDIO", 415);
  }

  const maxAudioBytes = getMaxAudioBytes();
  if (file.size > maxAudioBytes) {
    throw createVoiceError("Audio demasiado grande", "AURA_VOICE_AUDIO_TOO_LARGE", 413);
  }

  const durationSeconds = parseDurationSeconds(durationInput);
  const maxDurationSeconds = configuredMaxDurationSeconds();
  if (durationSeconds !== null && durationSeconds > maxDurationSeconds) {
    throw createVoiceError("Audio demasiado largo", "AURA_VOICE_AUDIO_TOO_LONG", 413);
  }

  return {
    mimeType,
    extension,
    sizeBytes: Number(file.size),
    durationSeconds,
    originalName: String(file.originalname || `aura.${extension}`).slice(0, 160),
  };
}

function mapSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerAdminId: Number(row.owner_admin_id),
    userId: Number(row.user_id),
    conversationId: row.conversation_id || null,
    status: row.status,
    expiresAt: row.expires_at,
    lastActivityAt: row.last_activity_at,
    createdAt: row.created_at,
    closedAt: row.closed_at || null,
  };
}

function normalizeConversationId(value) {
  return auraChat.normalizeConversationId(value);
}

async function createSession(input) {
  requireVoiceEnabled();
  const ctx = requireCtx(input);
  const conversationId = normalizeConversationId(input.conversationId || null);
  const sessionId = crypto.randomUUID();
  const ttlSeconds = configuredSessionTtlSeconds();

  const { rows } = await db.query(
    `INSERT INTO aura_voice_sessions
       (id, owner_admin_id, user_id, conversation_id, status, expires_at,
        last_activity_at, metadata)
     VALUES ($1, $2, $3, $4, 'active', NOW() + ($5::int * INTERVAL '1 second'),
        NOW(), $6::jsonb)
     RETURNING id, owner_admin_id, user_id, conversation_id, status, expires_at,
               last_activity_at, created_at, closed_at`,
    [
      sessionId,
      ctx.ownerAdminId,
      ctx.userId,
      conversationId,
      ttlSeconds,
      JSON.stringify({ mode: "push_to_talk", retention: "audio_not_stored" }),
    ]
  );

  return mapSession(rows[0]);
}

async function getSession(input) {
  const ctx = requireCtx(input);
  const sessionId = normalizeSessionId(input.sessionId);
  const { rows } = await db.query(
    `SELECT id, owner_admin_id, user_id, conversation_id, status, expires_at,
            last_activity_at, created_at, closed_at
     FROM aura_voice_sessions
     WHERE owner_admin_id = $1
       AND user_id = $2
       AND id = $3
     LIMIT 1`,
    [ctx.ownerAdminId, ctx.userId, sessionId]
  );
  return mapSession(rows[0]);
}

async function loadActiveSession(ctx, sessionId) {
  const session = await getSession({ ...ctx, sessionId });
  if (!session) {
    throw createVoiceError("Sesion de voz no encontrada", "AURA_VOICE_SESSION_NOT_FOUND", 404);
  }

  const expiresAt = new Date(session.expiresAt).getTime();
  if (session.status !== "active" || Number.isNaN(expiresAt) || expiresAt <= Date.now()) {
    await db.query(
      `UPDATE aura_voice_sessions
       SET status = CASE WHEN status = 'active' THEN 'expired' ELSE status END,
           updated_at = NOW()
       WHERE owner_admin_id = $1
         AND user_id = $2
         AND id = $3`,
      [ctx.ownerAdminId, ctx.userId, session.id]
    );
    throw createVoiceError("Sesion de voz expirada", "AURA_VOICE_SESSION_EXPIRED", 410);
  }

  return session;
}

async function closeSession(input) {
  requireVoiceEnabled();
  const ctx = requireCtx(input);
  const sessionId = normalizeSessionId(input.sessionId);
  const { rows } = await db.query(
    `UPDATE aura_voice_sessions
     SET status = 'closed',
         closed_at = NOW(),
         updated_at = NOW()
     WHERE owner_admin_id = $1
       AND user_id = $2
       AND id = $3
       AND status IN ('active', 'expired', 'closed')
     RETURNING id, owner_admin_id, user_id, conversation_id, status, expires_at,
               last_activity_at, created_at, closed_at`,
    [ctx.ownerAdminId, ctx.userId, sessionId]
  );
  if (!rows.length) {
    throw createVoiceError("Sesion de voz no encontrada", "AURA_VOICE_SESSION_NOT_FOUND", 404);
  }
  return mapSession(rows[0]);
}

async function createTurnRecord({ ctx, session, requestId, audioMeta }) {
  const turnId = crypto.randomUUID();
  const retentionHours = configuredTurnRetentionHours();
  const { rows } = await db.query(
    `INSERT INTO aura_voice_turns
       (id, session_id, owner_admin_id, user_id, conversation_id, request_id,
        status, audio_mime_type, audio_size_bytes, audio_duration_seconds,
        audio_retention, audio_deleted_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'transcribing', $7, $8, $9,
        'not_stored', NOW(), NOW() + ($10::int * INTERVAL '1 hour'))
     RETURNING id`,
    [
      turnId,
      session.id,
      ctx.ownerAdminId,
      ctx.userId,
      session.conversationId,
      requestId,
      audioMeta.mimeType,
      audioMeta.sizeBytes,
      audioMeta.durationSeconds,
      retentionHours,
    ]
  );
  return rows[0]?.id || turnId;
}

async function markTurnFailed({ turnId, ctx, error }) {
  if (!turnId) return;
  await db.query(
    `UPDATE aura_voice_turns
     SET status = 'failed',
         error_code = $3,
         error_message_redacted = $4,
         updated_at = NOW(),
         completed_at = NOW()
     WHERE id = $1
       AND owner_admin_id = $2`,
    [
      turnId,
      ctx.ownerAdminId,
      String(error.code || "AURA_VOICE_ERROR").slice(0, 100),
      redactText(error.message || "Error AURA Voice", 1000),
    ]
  );
}

async function markTurnCompleted({
  turnId,
  ctx,
  status = "completed",
  transcript,
  answer,
  suggestions,
  auraRunId = null,
  conversationId = null,
  tts,
}) {
  await db.query(
    `UPDATE aura_voice_turns
     SET status = $3,
         aura_run_id = $4,
         conversation_id = COALESCE($5, conversation_id),
         transcript_redacted = $6,
         response_text_redacted = $7,
         suggested_actions = $8::jsonb,
         tts_model = $9,
         tts_voice = $10,
         tts_format = $11,
         updated_at = NOW(),
         transcribed_at = COALESCE(transcribed_at, NOW()),
         completed_at = NOW()
     WHERE id = $1
       AND owner_admin_id = $2`,
    [
      turnId,
      ctx.ownerAdminId,
      status,
      auraRunId,
      conversationId,
      redactText(transcript, 2000),
      redactText(answer, 4000),
      JSON.stringify(redactObject(suggestions || [])),
      tts.model,
      tts.voice,
      tts.format,
    ]
  );
}

async function touchSession({ ctx, sessionId, conversationId }) {
  await db.query(
    `UPDATE aura_voice_sessions
     SET conversation_id = COALESCE($4, conversation_id),
         last_activity_at = NOW(),
         expires_at = NOW() + ($5::int * INTERVAL '1 second'),
         updated_at = NOW()
     WHERE owner_admin_id = $1
       AND user_id = $2
       AND id = $3`,
    [
      ctx.ownerAdminId,
      ctx.userId,
      sessionId,
      conversationId,
      configuredSessionTtlSeconds(),
    ]
  );
}

function isConfirmationAttempt(text) {
  const normalized = String(text || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.!?¿¡,;:\s]+/g, " ")
    .trim();
  if (!normalized) return false;
  return /^(si|si confirmo|confirmo|confirmar|apruebo|aprobado|dale|ok|okay|de acuerdo|adelante|hazlo|ejecuta|procede|autorizo)$/.test(normalized);
}

function mapProviderError(err, fallbackCode, fallbackMessage) {
  if (
    err.code === "ECONNABORTED" ||
    err.code === "ETIMEDOUT" ||
    err.code === "ERR_CANCELED" ||
    err.name === "CanceledError"
  ) {
    return createVoiceError("Timeout del proveedor OpenAI", "AURA_VOICE_PROVIDER_TIMEOUT", 504);
  }
  if (err.response?.status === 429) {
    return createVoiceError("Limite del proveedor OpenAI alcanzado", "AURA_VOICE_PROVIDER_RATE_LIMIT", 429);
  }
  return createVoiceError(fallbackMessage, fallbackCode, 502);
}

function createAbortController(timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, timeout };
}

async function transcribeAudio({ file, audioMeta }) {
  requireOpenAIKey();
  if (isVoiceMockProviderEnabled()) {
    const text = String(process.env.AURA_VOICE_MOCK_TRANSCRIPT || "Resume las ventas del dia").trim();
    if (!text || text.length > configuredMaxTranscriptChars()) {
      throw createVoiceError("Transcripcion mock invalida", "AURA_VOICE_MOCK_TRANSCRIPT_INVALID", 500);
    }
    return { text, model: "aura-stt-mock-v1" };
  }
  const model = process.env.OPENAI_TRANSCRIBE_MODEL || DEFAULT_TRANSCRIBE_MODEL;
  const timeoutMs = configuredTimeoutMs();
  const { controller, timeout } = createAbortController(timeoutMs);

  try {
    const form = new FormData();
    const blob = new Blob([file.buffer], { type: audioMeta.mimeType });
    form.append("file", blob, audioMeta.originalName || `aura.${audioMeta.extension}`);
    form.append("model", model);
    form.append("response_format", "json");
    form.append("language", "es");
    form.append("prompt", "Transcribe preguntas de negocio para ALESTEB y AURA 2070. Conserva nombres de productos si aparecen.");

    const response = await axios.post(
      OPENAI_TRANSCRIPTIONS_URL,
      form,
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        timeout: timeoutMs,
        signal: controller.signal,
      }
    );

    const transcript = typeof response.data === "string"
      ? response.data
      : response.data?.text;
    const clean = String(transcript || "").trim();
    if (!clean) {
      throw createVoiceError("No se detecto texto en el audio", "AURA_VOICE_EMPTY_TRANSCRIPT", 400);
    }
    if (clean.length > configuredMaxTranscriptChars()) {
      throw createVoiceError("Transcripcion demasiado larga", "AURA_VOICE_TRANSCRIPT_TOO_LONG", 413);
    }
    return { text: clean, model };
  } catch (err) {
    if (err.code && err.code.startsWith("AURA_VOICE_")) throw err;
    throw mapProviderError(err, "AURA_VOICE_TRANSCRIPTION_FAILED", "No fue posible transcribir el audio");
  } finally {
    clearTimeout(timeout);
  }
}

async function synthesizeSpeech(text) {
  requireOpenAIKey();
  if (isVoiceMockProviderEnabled()) {
    const buffer = Buffer.from(`AURA_MOCK_AUDIO:${String(text || "").slice(0, 120)}`, "utf8");
    return {
      model: "aura-tts-mock-v1",
      voice: "mock",
      format: "mp3",
      mimeType: "audio/mpeg",
      base64: buffer.toString("base64"),
      bytes: buffer.length,
      retention: "not_stored",
    };
  }
  const model = process.env.OPENAI_TTS_MODEL || DEFAULT_TTS_MODEL;
  const voice = process.env.OPENAI_TTS_VOICE || DEFAULT_TTS_VOICE;
  const format = process.env.OPENAI_TTS_FORMAT || DEFAULT_TTS_FORMAT;
  const timeoutMs = configuredTimeoutMs();
  const { controller, timeout } = createAbortController(timeoutMs);

  try {
    const response = await axios.post(
      OPENAI_SPEECH_URL,
      {
        model,
        voice,
        input: String(text || "").slice(0, 4000),
        instructions: "Habla en espanol con tono ejecutivo, premium, futurista, claro y directo.",
        response_format: format,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        responseType: "arraybuffer",
        timeout: timeoutMs,
        signal: controller.signal,
      }
    );

    const buffer = Buffer.from(response.data || []);
    return {
      model,
      voice,
      format,
      mimeType: MIME_BY_TTS_FORMAT[format] || "audio/mpeg",
      base64: buffer.toString("base64"),
      bytes: buffer.length,
      retention: "not_stored",
    };
  } catch (err) {
    throw mapProviderError(err, "AURA_VOICE_TTS_FAILED", "No fue posible sintetizar la respuesta de voz");
  } finally {
    clearTimeout(timeout);
  }
}

function fixedVoiceConfirmationAnswer() {
  return "Por seguridad, no puedo aprobar ni ejecutar acciones mediante una frase de voz. Revisa la accion en pantalla y usa el boton de aprobacion autenticado cuando corresponda.";
}

async function processTurn(input) {
  requireVoiceEnabled();
  const ctx = requireCtx(input);
  const sessionId = normalizeSessionId(input.sessionId);
  const audioMeta = validateAudioFile(input.file, input.durationSeconds);
  const session = await loadActiveSession(ctx, sessionId);
  const requestId = input.requestId || ctx.requestId || crypto.randomUUID();
  const turnId = await createTurnRecord({ ctx, session, requestId, audioMeta });

  try {
    const transcription = await transcribeAudio({ file: input.file, audioMeta });
    let answer;
    let suggestions = [];
    let conversationId = session.conversationId || null;
    let runId = null;
    let status = "completed";

    if (isConfirmationAttempt(transcription.text)) {
      answer = fixedVoiceConfirmationAnswer();
      status = "blocked_confirmation";
    } else {
      await db.query(
        `UPDATE aura_voice_turns
         SET status = 'responding',
             transcript_redacted = $3,
             transcribed_at = NOW(),
             updated_at = NOW()
         WHERE id = $1
           AND owner_admin_id = $2`,
        [turnId, ctx.ownerAdminId, redactText(transcription.text, 2000)]
      );

      const aura = await auraChat.executeAuraChat({
        ownerAdminId: ctx.ownerAdminId,
        userId: ctx.userId,
        roles: ctx.roles,
        message: transcription.text,
        conversationId: session.conversationId || input.conversationId || null,
        requestId,
      });

      answer = aura.answer || aura.reply;
      suggestions = aura.suggestions || aura.suggestedActions || [];
      conversationId = aura.conversationId || conversationId;
      runId = aura.runId;
    }

    await db.query(
      `UPDATE aura_voice_turns
       SET status = 'synthesizing',
           updated_at = NOW()
       WHERE id = $1
         AND owner_admin_id = $2`,
      [turnId, ctx.ownerAdminId]
    );

    const tts = await synthesizeSpeech(answer);
    await markTurnCompleted({
      turnId,
      ctx,
      status,
      transcript: transcription.text,
      answer,
      suggestions,
      auraRunId: runId,
      conversationId,
      tts,
    });
    await touchSession({ ctx, sessionId: session.id, conversationId });

    return {
      sessionId: session.id,
      turnId,
      conversationId,
      runId,
      transcript: transcription.text,
      answer,
      suggestions,
      blockedActionConfirmation: status === "blocked_confirmation",
      audio: {
        mimeType: tts.mimeType,
        format: tts.format,
        base64: tts.base64,
        bytes: tts.bytes,
        retention: tts.retention,
      },
      models: {
        transcribe: transcription.model,
        tts: tts.model,
        voice: tts.voice,
      },
    };
  } catch (err) {
    await markTurnFailed({ turnId, ctx, error: err });
    throw err;
  }
}

async function cleanupExpiredVoiceData(limit = 500) {
  const safeLimit = boundedInt(limit, 500, 1, 5000);
  const sessions = await db.query(
    `UPDATE aura_voice_sessions
     SET status = 'expired',
         updated_at = NOW()
     WHERE status = 'active'
       AND expires_at <= NOW()
     RETURNING id`
  );
  const turns = await db.query(
    `WITH expired AS (
       SELECT id
       FROM aura_voice_turns
       WHERE expires_at IS NOT NULL
         AND expires_at <= NOW()
       ORDER BY expires_at ASC
       LIMIT $1
     )
     DELETE FROM aura_voice_turns turn_row
     USING expired
     WHERE turn_row.id = expired.id
     RETURNING turn_row.id`,
    [safeLimit]
  );
  return {
    expiredSessions: sessions.rowCount || sessions.rows.length,
    deletedTurns: turns.rowCount || turns.rows.length,
  };
}

validateAuraVoiceConfig();

module.exports = {
  ALLOWED_AUDIO_TYPES,
  createSession,
  getSession,
  closeSession,
  processTurn,
  validateAudioFile,
  isVoiceEnabled,
  isVoiceMockProviderEnabled,
  requireVoiceEnabled,
  validateAuraVoiceConfig,
  getMaxAudioBytes,
  isConfirmationAttempt,
  transcribeAudio,
  synthesizeSpeech,
  cleanupExpiredVoiceData,
};
