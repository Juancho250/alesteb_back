const axios = require("axios");
const cloudinary = require("../../../../config/cloudinary");

const OPENAI_IMAGES_GENERATIONS_URL = "https://api.openai.com/v1/images/generations";
const OPENAI_IMAGES_EDITS_URL = "https://api.openai.com/v1/images/edits";
const OPENAI_MODERATIONS_URL = "https://api.openai.com/v1/moderations";
const DEFAULT_IMAGE_TIMEOUT_MS = 90_000;
const DEFAULT_MODERATION_MODEL = "omni-moderation-latest";
const MOCK_IMAGE_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function envFlag(name, defaultValue = false) {
  const value = process.env[name];
  if (value === undefined || value === null || value === "") return defaultValue;
  return ["true", "1", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function isImageMockProviderEnabled() {
  return envFlag("AURA_IMAGE_MOCK_PROVIDER_ENABLED", false)
    && (["test", "development"].includes(String(process.env.NODE_ENV || "").toLowerCase())
      || envFlag("AURA_STAGING_MODE", false));
}

function configuredMaxOutputBytes() {
  const mb = Number.parseInt(process.env.AURA_IMAGE_MAX_OUTPUT_MB || "10", 10);
  const safeMb = Number.isSafeInteger(mb) ? Math.min(Math.max(mb, 1), 20) : 10;
  return safeMb * 1024 * 1024;
}

function estimatedImageCost() {
  const value = Number(process.env.AURA_IMAGE_USD_PER_IMAGE || 0);
  return Number((Number.isFinite(value) && value > 0 ? value : 0).toFixed(8));
}

function createProviderError(message, code = "AURA_IMAGE_PROVIDER_ERROR", status = 502) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function redactExternalError(err) {
  const status = err.response?.status || err.status || null;
  const providerCode = err.response?.data?.error?.code || err.code || "EXTERNAL_ERROR";
  const providerType = err.response?.data?.error?.type || null;
  return {
    code: String(providerCode).slice(0, 80),
    message: status
      ? `Proveedor externo devolvio HTTP ${status}`
      : "Proveedor externo no disponible",
    providerType,
    status,
  };
}

function requireOpenAIConfig() {
  if (isImageMockProviderEnabled()) {
    return {
      apiKey: null,
      imageModel: "aura-image-mock-v1",
      moderationModel: "aura-moderation-mock-v1",
      mock: true,
    };
  }
  if (!process.env.OPENAI_API_KEY) {
    throw createProviderError("OPENAI_API_KEY no configurada", "AURA_IMAGE_OPENAI_MISSING_KEY", 503);
  }
  if (!process.env.OPENAI_IMAGE_MODEL) {
    throw createProviderError("OPENAI_IMAGE_MODEL no configurado", "AURA_IMAGE_MODEL_MISSING", 503);
  }
  return {
    apiKey: process.env.OPENAI_API_KEY,
    imageModel: process.env.OPENAI_IMAGE_MODEL,
    moderationModel: process.env.OPENAI_MODERATION_MODEL || DEFAULT_MODERATION_MODEL,
  };
}

function timeoutMs() {
  const parsed = Number.parseInt(process.env.AURA_IMAGE_OPENAI_TIMEOUT_MS || String(DEFAULT_IMAGE_TIMEOUT_MS), 10);
  if (!Number.isSafeInteger(parsed)) return DEFAULT_IMAGE_TIMEOUT_MS;
  return Math.min(Math.max(parsed, 5_000), 180_000);
}

async function postOpenAI(url, payload, config = {}) {
  const { apiKey } = requireOpenAIConfig();
  return axios.post(url, payload, {
    timeout: timeoutMs(),
    ...config,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(config.headers || {}),
    },
  });
}

function moderationFlagged(responseData) {
  const results = Array.isArray(responseData?.results) ? responseData.results : [];
  return results.some((item) => Boolean(item?.flagged));
}

async function moderateImageRequest({ prompt, imageUrl = null, imageBase64 = null }) {
  const { moderationModel, mock } = requireOpenAIConfig();
  if (mock) {
    return {
      status: "approved",
      flagged: false,
      model: moderationModel,
      id: "mock-moderation",
    };
  }
  const input = [{ type: "text", text: String(prompt || "").slice(0, 4000) }];

  if (imageUrl) {
    input.push({ type: "image_url", image_url: { url: imageUrl } });
  }
  if (imageBase64) {
    input.push({ type: "image_url", image_url: { url: `data:image/png;base64,${imageBase64}` } });
  }

  try {
    const { data } = await postOpenAI(OPENAI_MODERATIONS_URL, {
      model: moderationModel,
      input,
    });
    return {
      status: moderationFlagged(data) ? "flagged" : "approved",
      flagged: moderationFlagged(data),
      model: data?.model || moderationModel,
      id: data?.id || null,
    };
  } catch (err) {
    const redacted = redactExternalError(err);
    throw createProviderError(redacted.message, "AURA_IMAGE_MODERATION_ERROR", redacted.status || 502);
  }
}

function extractImageBase64(responseData) {
  const item = Array.isArray(responseData?.data) ? responseData.data[0] : null;
  if (item?.b64_json) return item.b64_json;
  throw createProviderError("OpenAI no devolvio imagen base64", "AURA_IMAGE_EMPTY_RESULT", 502);
}

function validateGeneratedImageBase64(b64Json) {
  let buffer;
  try {
    buffer = Buffer.from(String(b64Json || ""), "base64");
  } catch {
    throw createProviderError("Imagen generada invalida", "AURA_IMAGE_INVALID_BUFFER", 502);
  }
  if (!buffer.length || buffer.length > configuredMaxOutputBytes()) {
    throw createProviderError("Imagen generada fuera del tamano permitido", "AURA_IMAGE_INVALID_BUFFER", 502);
  }

  const isPng = buffer.length >= 8
    && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isWebp = buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  if (!isPng && !isJpeg && !isWebp) {
    throw createProviderError("Tipo de imagen generado no permitido", "AURA_IMAGE_INVALID_TYPE", 502);
  }
  return {
    buffer,
    format: isPng ? "png" : isJpeg ? "jpg" : "webp",
  };
}

async function createImageFromPrompt({ prompt, size, quality = null }) {
  const { imageModel, mock } = requireOpenAIConfig();
  if (mock) {
    return {
      b64Json: MOCK_IMAGE_BASE64,
      model: imageModel,
      usage: { images: 1, estimatedCostUsd: 0 },
      endpoint: "mock/images/generations",
    };
  }
  try {
    const { data } = await postOpenAI(OPENAI_IMAGES_GENERATIONS_URL, {
      model: imageModel,
      prompt,
      n: 1,
      size,
      quality: quality || process.env.OPENAI_IMAGE_QUALITY || "high",
    });
    return {
      b64Json: extractImageBase64(data),
      model: data?.model || imageModel,
      usage: data?.usage || null,
      estimatedCostUsd: estimatedImageCost(),
      endpoint: "images/generations",
    };
  } catch (err) {
    const redacted = redactExternalError(err);
    throw createProviderError(redacted.message, "AURA_IMAGE_GENERATION_ERROR", redacted.status || 502);
  }
}

async function editImageFromCatalog({ prompt, sourceImageUrl, size, quality = null }) {
  const { imageModel, mock } = requireOpenAIConfig();
  if (mock) {
    return {
      b64Json: MOCK_IMAGE_BASE64,
      model: imageModel,
      usage: { images: 1, estimatedCostUsd: 0 },
      endpoint: "mock/images/edits",
    };
  }
  try {
    const { data } = await postOpenAI(OPENAI_IMAGES_EDITS_URL, {
      model: imageModel,
      prompt,
      images: [{ image_url: sourceImageUrl }],
      size,
      quality: quality || process.env.OPENAI_IMAGE_QUALITY || "high",
      output_format: "png",
    });
    return {
      b64Json: extractImageBase64(data),
      model: data?.model || imageModel,
      usage: data?.usage || null,
      estimatedCostUsd: estimatedImageCost(),
      endpoint: "images/edits",
    };
  } catch (err) {
    const redacted = redactExternalError(err);
    throw createProviderError(redacted.message, "AURA_IMAGE_EDIT_ERROR", redacted.status || 502);
  }
}

async function uploadGeneratedImage({ b64Json, folder, assetId }) {
  const { buffer, format } = validateGeneratedImageBase64(b64Json);
  if (isImageMockProviderEnabled()) {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME || "mock-cloud";
    const publicId = `${folder}/aura-${assetId}`;
    return {
      secureUrl: `https://res.cloudinary.com/${cloudName}/image/upload/${publicId}.${format}`,
      publicId,
      width: 1,
      height: 1,
      format,
      bytes: buffer.length,
      mock: true,
    };
  }

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: "image",
        overwrite: false,
        unique_filename: true,
        public_id: `aura-${assetId}`,
        format,
      },
      (err, result) => {
        if (err) {
          return reject(createProviderError("Cloudinary no pudo guardar la imagen", "AURA_IMAGE_CLOUDINARY_UPLOAD_ERROR", 502));
        }
        return resolve({
          secureUrl: result.secure_url,
          publicId: result.public_id,
          width: result.width || null,
          height: result.height || null,
          format: result.format || format,
          bytes: result.bytes || null,
        });
      }
    );
    stream.end(buffer);
  });
}

async function destroyGeneratedImage(publicId) {
  if (!publicId) return { result: "skipped" };
  if (isImageMockProviderEnabled()) return { result: "mock_deleted" };
  return cloudinary.uploader.destroy(publicId, { resource_type: "image" });
}

module.exports = {
  OPENAI_IMAGES_GENERATIONS_URL,
  OPENAI_IMAGES_EDITS_URL,
  OPENAI_MODERATIONS_URL,
  requireOpenAIConfig,
  isImageMockProviderEnabled,
  validateGeneratedImageBase64,
  configuredMaxOutputBytes,
  redactExternalError,
  moderateImageRequest,
  createImageFromPrompt,
  editImageFromCatalog,
  uploadGeneratedImage,
  destroyGeneratedImage,
};
