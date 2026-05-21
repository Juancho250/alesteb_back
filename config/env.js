const REQUIRED = [
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'NEON_DB_URL',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  'CLOUDINARY_CLOUD_NAME',
];

const INSECURE_DEFAULTS = {
  SETUP_SECRET_KEY: 'alesteb-setup-2024',
};

module.exports = function validateEnv() {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`[ENV] Faltan variables de entorno requeridas: ${missing.join(', ')}`);
    process.exit(1);
  }

  for (const [key, insecure] of Object.entries(INSECURE_DEFAULTS)) {
    if (process.env[key] === insecure) {
      console.warn(`[ENV] ADVERTENCIA: ${key} está usando el valor por defecto inseguro.`);
    }
  }

  if (process.env.NODE_ENV === 'production') {
    if (!process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGINS === '*') {
      console.error('[ENV] ALLOWED_ORIGINS no puede ser wildcard en producción.');
      process.exit(1);
    }
    if (!process.env.SETUP_SECRET_KEY) {
      console.warn('[ENV] ADVERTENCIA: SETUP_SECRET_KEY vacío en producción — endpoint /setup deshabilitado.');
    }
  }
};
