const REQUIRED = [
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'NEON_DB_URL',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  'CLOUDINARY_CLOUD_NAME',
  'PAYMENTS_ENCRYPTION_KEY',
];

const INSECURE_DEFAULTS = {
  SETUP_SECRET_KEY: 'alesteb-setup-2024',
};

// Longitud mínima de secretos JWT para garantizar entropía suficiente (256 bits)
const JWT_MIN_LENGTH = 32;

module.exports = function validateEnv() {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`[ENV] Faltan variables de entorno requeridas: ${missing.join(', ')}`);
    process.exit(1);
  }

  // PAYMENTS_ENCRYPTION_KEY must decode to exactly 32 bytes for AES-256-GCM
  const encKeyRaw = process.env.PAYMENTS_ENCRYPTION_KEY;
  const encKeyBuf = Buffer.from(encKeyRaw, encKeyRaw.length === 64 ? 'hex' : 'base64');
  if (encKeyBuf.length !== 32) {
    console.error('[ENV] PAYMENTS_ENCRYPTION_KEY debe decodificar a exactamente 32 bytes. Usa 64 caracteres hex o 44 caracteres base64.');
    console.error('[ENV] Genera una clave válida con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    process.exit(1);
  }

  for (const [key, insecure] of Object.entries(INSECURE_DEFAULTS)) {
    if (process.env[key] === insecure) {
      console.warn(`[ENV] ADVERTENCIA: ${key} está usando el valor por defecto inseguro.`);
    }
  }

  // Validar longitud mínima de secretos JWT
  if (process.env.JWT_SECRET.length < JWT_MIN_LENGTH) {
    console.error('[ENV] JWT_SECRET demasiado corto. Genera uno con: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
    process.exit(1);
  }
  if (process.env.JWT_REFRESH_SECRET.length < JWT_MIN_LENGTH) {
    console.error('[ENV] JWT_REFRESH_SECRET demasiado corto.');
    process.exit(1);
  }

  const auraDailyLimit = Number.parseInt(process.env.AURA_DAILY_REQUEST_LIMIT || '100', 10);
  if (!Number.isSafeInteger(auraDailyLimit) || auraDailyLimit <= 0) {
    console.error('[ENV] AURA_DAILY_REQUEST_LIMIT debe ser un entero positivo.');
    process.exit(1);
  }

  const auraProviderTimeout = Number.parseInt(process.env.AURA_OPENAI_TIMEOUT_MS || '18000', 10);
  if (!Number.isSafeInteger(auraProviderTimeout) || auraProviderTimeout < 1000 || auraProviderTimeout > 25000) {
    console.error('[ENV] AURA_OPENAI_TIMEOUT_MS debe estar entre 1000 y 25000 ms.');
    process.exit(1);
  }

  const auraConversationRetentionDays = Number.parseInt(process.env.AURA_CONVERSATION_RETENTION_DAYS || '180', 10);
  if (!Number.isSafeInteger(auraConversationRetentionDays) || auraConversationRetentionDays < 1 || auraConversationRetentionDays > 730) {
    console.error('[ENV] AURA_CONVERSATION_RETENTION_DAYS debe estar entre 1 y 730 dias.');
    process.exit(1);
  }

  const auraImageMaxJobs = Number.parseInt(process.env.AURA_IMAGE_MAX_JOBS_PER_DAY || '20', 10);
  if (!Number.isSafeInteger(auraImageMaxJobs) || auraImageMaxJobs < 1 || auraImageMaxJobs > 500) {
    console.error('[ENV] AURA_IMAGE_MAX_JOBS_PER_DAY debe estar entre 1 y 500.');
    process.exit(1);
  }

  const auraImageTimeout = Number.parseInt(process.env.AURA_IMAGE_OPENAI_TIMEOUT_MS || '90000', 10);
  if (!Number.isSafeInteger(auraImageTimeout) || auraImageTimeout < 5000 || auraImageTimeout > 180000) {
    console.error('[ENV] AURA_IMAGE_OPENAI_TIMEOUT_MS debe estar entre 5000 y 180000 ms.');
    process.exit(1);
  }

  const auraImageWorkerPollMs = Number.parseInt(process.env.AURA_IMAGE_WORKER_POLL_MS || '5000', 10);
  if (!Number.isSafeInteger(auraImageWorkerPollMs) || auraImageWorkerPollMs < 1000 || auraImageWorkerPollMs > 60000) {
    console.error('[ENV] AURA_IMAGE_WORKER_POLL_MS debe estar entre 1000 y 60000 ms.');
    process.exit(1);
  }

  if (!process.env.OPENAI_API_KEY) {
    console.warn('[ENV] OPENAI_API_KEY no configurada; AURA devolvera 503 hasta configurarla.');
  }

  if (!process.env.OPENAI_IMAGE_MODEL) {
    console.warn('[ENV] OPENAI_IMAGE_MODEL no configurado; los jobs de imagen AURA fallaran hasta configurarlo.');
  }

  for (const key of ['AURA_INPUT_USD_PER_1M', 'AURA_OUTPUT_USD_PER_1M']) {
    if (process.env[key] !== undefined) {
      const value = Number(process.env[key]);
      if (!Number.isFinite(value) || value < 0) {
        console.error(`[ENV] ${key} debe ser un número mayor o igual a cero.`);
        process.exit(1);
      }
    }
  }

  if (process.env.NODE_ENV === 'production') {
    if (!process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGINS === '*') {
      console.error('[ENV] ALLOWED_ORIGINS no puede ser wildcard en producción.');
      process.exit(1);
    }

    // Los secrets JWT deben ser distintos en producción
    if (process.env.JWT_SECRET === process.env.JWT_REFRESH_SECRET) {
      console.error('[ENV] JWT_SECRET y JWT_REFRESH_SECRET deben ser diferentes en producción.');
      process.exit(1);
    }

    // Verificar que FRONTEND_URL está configurado
    if (!process.env.FRONTEND_URL) {
      console.error('[ENV] FRONTEND_URL es requerido en producción.');
      process.exit(1);
    }

    if (!process.env.SETUP_SECRET_KEY) {
      console.warn('[ENV] ADVERTENCIA: SETUP_SECRET_KEY vacío en producción — endpoint /setup deshabilitado.');
    }

    // Advertir si VAPID no está configurado (push notifications no funcionarán)
    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
      console.warn('[ENV] ADVERTENCIA: VAPID_PUBLIC_KEY/PRIVATE_KEY no configurados — push notifications deshabilitadas.');
    }

    // Advertir si Wompi no está en modo producción
    if (process.env.WOMPI_ENV !== 'production') {
      console.warn('[ENV] ADVERTENCIA: WOMPI_ENV no es "production" — usando entorno de pruebas Wompi.');
    }
  }
};
