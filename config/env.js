'use strict';

const PROCESS_ROLES = Object.freeze([
  'web',
  'notification-worker',
  'image-worker',
  'predictive-worker',
]);
const PROCESS_ROLE_SET = new Set(PROCESS_ROLES);

const DATABASE_REQUIRED = Object.freeze(['NEON_DB_URL']);
const WEB_REQUIRED = Object.freeze([
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'NEON_DB_URL',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  'CLOUDINARY_CLOUD_NAME',
  'PAYMENTS_ENCRYPTION_KEY',
]);
const IMAGE_PROVIDER_REQUIRED = Object.freeze([
  'OPENAI_API_KEY',
  'OPENAI_IMAGE_MODEL',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  'CLOUDINARY_CLOUD_NAME',
]);

const INSECURE_DEFAULTS = {
  SETUP_SECRET_KEY: 'alesteb-setup-2024',
};
const JWT_MIN_LENGTH = 32;

function envFlag(env, name) {
  return String(env[name] || '').trim().toLowerCase() === 'true';
}

function isImageStagingMockEnabled(env) {
  return envFlag(env, 'AURA_STAGING_MODE')
    && envFlag(env, 'AURA_IMAGE_MOCK_PROVIDER_ENABLED');
}

function requiredVariablesForRole(role, env) {
  if (role === 'web') return [...WEB_REQUIRED];
  if (role === 'notification-worker' || role === 'predictive-worker') {
    return [...DATABASE_REQUIRED];
  }
  if (role === 'image-worker') {
    return isImageStagingMockEnabled(env)
      ? [...DATABASE_REQUIRED]
      : [...DATABASE_REQUIRED, ...IMAGE_PROVIDER_REQUIRED];
  }
  throw new Error(`Unsupported ALESTEB_PROCESS_ROLE: ${role}`);
}

function createValidationError(message) {
  const err = new Error(String(message).replace(/^\[ENV\]\s*/, ''));
  err.code = 'ENV_VALIDATION_FAILED';
  return err;
}

function failValidation(message, { logger, exitOnError }) {
  logger.error(message);
  const err = createValidationError(message);
  if (exitOnError) process.exit(1);
  throw err;
}

function validateImageSettings(env, fail) {
  const auraImageMaxJobs = Number.parseInt(env.AURA_IMAGE_MAX_JOBS_PER_DAY || '20', 10);
  if (!Number.isSafeInteger(auraImageMaxJobs) || auraImageMaxJobs < 1 || auraImageMaxJobs > 500) {
    fail('[ENV] AURA_IMAGE_MAX_JOBS_PER_DAY debe estar entre 1 y 500.');
  }

  const auraImageTimeout = Number.parseInt(env.AURA_IMAGE_OPENAI_TIMEOUT_MS || '90000', 10);
  if (!Number.isSafeInteger(auraImageTimeout) || auraImageTimeout < 5000 || auraImageTimeout > 180000) {
    fail('[ENV] AURA_IMAGE_OPENAI_TIMEOUT_MS debe estar entre 5000 y 180000 ms.');
  }

  const auraImageWorkerPollMs = Number.parseInt(env.AURA_IMAGE_WORKER_POLL_MS || '5000', 10);
  if (
    !Number.isSafeInteger(auraImageWorkerPollMs)
    || auraImageWorkerPollMs < 1000
    || auraImageWorkerPollMs > 60000
  ) {
    fail('[ENV] AURA_IMAGE_WORKER_POLL_MS debe estar entre 1000 y 60000 ms.');
  }
}

function validateWebSettings(env, fail, logger) {
  const encKeyRaw = env.PAYMENTS_ENCRYPTION_KEY;
  const encKeyBuf = Buffer.from(encKeyRaw, encKeyRaw.length === 64 ? 'hex' : 'base64');
  if (encKeyBuf.length !== 32) {
    fail('[ENV] PAYMENTS_ENCRYPTION_KEY debe decodificar a exactamente 32 bytes. Usa 64 caracteres hex o 44 caracteres base64.');
  }

  for (const [key, insecure] of Object.entries(INSECURE_DEFAULTS)) {
    if (env[key] === insecure) {
      logger.warn(`[ENV] ADVERTENCIA: ${key} esta usando el valor por defecto inseguro.`);
    }
  }

  if (env.JWT_SECRET.length < JWT_MIN_LENGTH) {
    fail('[ENV] JWT_SECRET demasiado corto. Genera un secreto de al menos 32 caracteres.');
  }
  if (env.JWT_REFRESH_SECRET.length < JWT_MIN_LENGTH) {
    fail('[ENV] JWT_REFRESH_SECRET demasiado corto.');
  }

  const auraDailyLimit = Number.parseInt(env.AURA_DAILY_REQUEST_LIMIT || '100', 10);
  if (!Number.isSafeInteger(auraDailyLimit) || auraDailyLimit <= 0) {
    fail('[ENV] AURA_DAILY_REQUEST_LIMIT debe ser un entero positivo.');
  }

  const auraProviderTimeout = Number.parseInt(env.AURA_OPENAI_TIMEOUT_MS || '18000', 10);
  if (
    !Number.isSafeInteger(auraProviderTimeout)
    || auraProviderTimeout < 1000
    || auraProviderTimeout > 25000
  ) {
    fail('[ENV] AURA_OPENAI_TIMEOUT_MS debe estar entre 1000 y 25000 ms.');
  }

  const retentionDays = Number.parseInt(env.AURA_CONVERSATION_RETENTION_DAYS || '180', 10);
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 730) {
    fail('[ENV] AURA_CONVERSATION_RETENTION_DAYS debe estar entre 1 y 730 dias.');
  }

  validateImageSettings(env, fail);

  if (!env.OPENAI_API_KEY) {
    logger.warn('[ENV] OPENAI_API_KEY no configurada; AURA devolvera 503 hasta configurarla.');
  }
  if (!env.OPENAI_IMAGE_MODEL) {
    logger.warn('[ENV] OPENAI_IMAGE_MODEL no configurado; los jobs de imagen AURA fallaran hasta configurarlo.');
  }

  for (const key of ['AURA_INPUT_USD_PER_1M', 'AURA_OUTPUT_USD_PER_1M']) {
    if (env[key] !== undefined) {
      const value = Number(env[key]);
      if (!Number.isFinite(value) || value < 0) {
        fail(`[ENV] ${key} debe ser un numero mayor o igual a cero.`);
      }
    }
  }

  if (env.NODE_ENV !== 'production') return;

  if (!env.ALLOWED_ORIGINS || env.ALLOWED_ORIGINS === '*') {
    fail('[ENV] ALLOWED_ORIGINS no puede ser wildcard en produccion.');
  }
  if (env.JWT_SECRET === env.JWT_REFRESH_SECRET) {
    fail('[ENV] JWT_SECRET y JWT_REFRESH_SECRET deben ser diferentes en produccion.');
  }
  if (!env.FRONTEND_URL) {
    fail('[ENV] FRONTEND_URL es requerido en produccion.');
  }
  if (!env.SETUP_SECRET_KEY) {
    logger.warn('[ENV] ADVERTENCIA: SETUP_SECRET_KEY vacio en produccion; endpoint /setup deshabilitado.');
  }
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    logger.warn('[ENV] ADVERTENCIA: VAPID_PUBLIC_KEY/PRIVATE_KEY no configurados; push notifications deshabilitadas.');
  }
  if (env.WOMPI_ENV !== 'production') {
    logger.warn('[ENV] ADVERTENCIA: WOMPI_ENV no es "production"; usando entorno de pruebas Wompi.');
  }
}

function validateEnv(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const exitOnError = options.exitOnError !== false;
  const fail = (message) => failValidation(message, { logger, exitOnError });

  const configuredRole = String(env.ALESTEB_PROCESS_ROLE || '').trim();
  const role = configuredRole || 'web';
  if (!PROCESS_ROLE_SET.has(role)) {
    fail(`[ENV] ALESTEB_PROCESS_ROLE invalido. Valores permitidos: ${PROCESS_ROLES.join(', ')}.`);
  }

  const requiredVariables = requiredVariablesForRole(role, env);
  const missing = requiredVariables.filter((key) => !env[key]);
  if (missing.length) {
    fail(`[ENV] Faltan variables de entorno requeridas: ${missing.join(', ')}`);
  }

  if (role === 'web') {
    validateWebSettings(env, fail, logger);
  } else if (role === 'image-worker') {
    validateImageSettings(env, fail);
  }

  return {
    role,
    requiredVariables,
    imageMockEnabled: role === 'image-worker' && isImageStagingMockEnabled(env),
  };
}

module.exports = validateEnv;
module.exports.PROCESS_ROLES = PROCESS_ROLES;
module.exports.requiredVariablesForRole = requiredVariablesForRole;
module.exports.isImageStagingMockEnabled = isImageStagingMockEnabled;
