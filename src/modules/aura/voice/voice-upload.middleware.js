const multer = require("multer");
const { getMaxAudioBytes } = require("./voice.service");

function buildUpload() {
  return multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: getMaxAudioBytes(),
      files: 1,
      fields: 8,
      fieldSize: 16 * 1024,
    },
  }).single("audio");
}

function auraVoiceUpload(req, res, next) {
  buildUpload()(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
      const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      const code = err.code === "LIMIT_FILE_SIZE"
        ? "AURA_VOICE_AUDIO_TOO_LARGE"
        : "AURA_VOICE_UPLOAD_INVALID";
      return res.status(status).json({
        success: false,
        message: err.code === "LIMIT_FILE_SIZE" ? "Audio demasiado grande" : "Upload de audio invalido",
        code,
        requestId: req.id,
      });
    }

    return res.status(400).json({
      success: false,
      message: "Upload de audio invalido",
      code: "AURA_VOICE_UPLOAD_INVALID",
      requestId: req.id,
    });
  });
}

module.exports = {
  auraVoiceUpload,
};
