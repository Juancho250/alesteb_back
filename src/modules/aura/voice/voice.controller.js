const auraVoice = require("./voice.service");

function quotaUsage(req) {
  const usage = req.auraUsage || {};
  return {
    requestsRemaining: Number(usage.requestsRemaining ?? usage.remaining ?? 0),
  };
}

function sendVoiceError(req, res, err) {
  if (res.headersSent) return res;
  const known = {
    AURA_VOICE_DISABLED: [403, "AURA Voice no esta habilitado"],
    AURA_OPENAI_MISSING_KEY: [503, "OPENAI_API_KEY no configurada en el servidor"],
    AURA_VOICE_CONTEXT_REQUIRED: [401, "No autenticado"],
    AURA_VOICE_INVALID_SESSION: [400, "sessionId invalido"],
    AURA_VOICE_SESSION_NOT_FOUND: [404, "Sesion de voz no encontrada"],
    AURA_VOICE_SESSION_EXPIRED: [410, "Sesion de voz expirada"],
    AURA_VOICE_AUDIO_REQUIRED: [400, "audio es requerido"],
    AURA_VOICE_UNSUPPORTED_AUDIO: [415, "Tipo de audio no permitido"],
    AURA_VOICE_AUDIO_TOO_LARGE: [413, "Audio demasiado grande"],
    AURA_VOICE_AUDIO_TOO_LONG: [413, "Audio demasiado largo"],
    AURA_VOICE_INVALID_DURATION: [400, "durationSeconds invalido"],
    AURA_VOICE_EMPTY_TRANSCRIPT: [400, "No se detecto texto en el audio"],
    AURA_VOICE_TRANSCRIPT_TOO_LONG: [413, "Transcripcion demasiado larga"],
    AURA_VOICE_PROVIDER_RATE_LIMIT: [429, "Limite del proveedor de voz alcanzado"],
    AURA_VOICE_PROVIDER_TIMEOUT: [504, "El proveedor de voz tardo demasiado en responder"],
    AURA_VOICE_TRANSCRIPTION_FAILED: [502, "No fue posible transcribir el audio"],
    AURA_VOICE_TTS_FAILED: [502, "No fue posible sintetizar la respuesta de voz"],
    AURA_CONVERSATION_NOT_FOUND: [404, "Conversacion no encontrada"],
    AURA_OPENAI_RATE_LIMIT: [429, "Limite del proveedor de IA alcanzado"],
    AURA_OPENAI_TIMEOUT: [504, "El proveedor de IA tardo demasiado en responder"],
    AURA_OPENAI_ERROR: [502, "El proveedor de IA no pudo procesar la solicitud"],
  };
  const [status, message] = known[err.code] || [err.status || 500, "Error al procesar AURA Voice"];
  return res.status(status).json({
    success: false,
    message,
    code: err.code || "AURA_VOICE_ERROR",
    requestId: req.id,
  });
}

function voiceCtx(req) {
  return {
    ownerAdminId: req.auraAdminId,
    userId: req.user?.id,
    roles: req.user?.roles || [],
    requestId: req.id,
  };
}

exports.requireVoiceEnabled = (req, res, next) => {
  try {
    auraVoice.requireVoiceEnabled();
    return next();
  } catch (err) {
    return sendVoiceError(req, res, err);
  }
};

exports.validateVoiceTurnRequest = (req, res, next) => {
  try {
    req.auraVoiceAudio = auraVoice.validateAudioFile(req.file, req.body?.durationSeconds);
    return next();
  } catch (err) {
    return sendVoiceError(req, res, err);
  }
};

exports.createSession = async (req, res) => {
  try {
    const session = await auraVoice.createSession({
      ...voiceCtx(req),
      conversationId: req.body?.conversationId || null,
    });
    return res.status(201).json({
      success: true,
      data: session,
      requestId: req.id,
    });
  } catch (err) {
    return sendVoiceError(req, res, err);
  }
};

exports.getSession = async (req, res) => {
  try {
    const session = await auraVoice.getSession({
      ...voiceCtx(req),
      sessionId: req.params.id,
    });
    if (!session) {
      return res.status(404).json({
        success: false,
        message: "Sesion de voz no encontrada",
        code: "AURA_VOICE_SESSION_NOT_FOUND",
        requestId: req.id,
      });
    }
    return res.json({ success: true, data: session, requestId: req.id });
  } catch (err) {
    return sendVoiceError(req, res, err);
  }
};

exports.closeSession = async (req, res) => {
  try {
    const session = await auraVoice.closeSession({
      ...voiceCtx(req),
      sessionId: req.params.id,
    });
    return res.json({ success: true, data: session, requestId: req.id });
  } catch (err) {
    return sendVoiceError(req, res, err);
  }
};

exports.processTurn = async (req, res) => {
  try {
    const result = await auraVoice.processTurn({
      ...voiceCtx(req),
      sessionId: req.params.id,
      conversationId: req.body?.conversationId || null,
      durationSeconds: req.body?.durationSeconds,
      file: req.file,
      requestId: req.id,
    });
    return res.json({
      success: true,
      sessionId: result.sessionId,
      turnId: result.turnId,
      conversationId: result.conversationId,
      runId: result.runId,
      transcript: result.transcript,
      answer: result.answer,
      suggestions: result.suggestions,
      blockedActionConfirmation: result.blockedActionConfirmation,
      audio: result.audio,
      models: result.models,
      usage: quotaUsage(req),
      requestId: req.id,
    });
  } catch (err) {
    return sendVoiceError(req, res, err);
  }
};

exports.sendVoiceError = sendVoiceError;
