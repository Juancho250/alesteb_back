'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const validateEnv = require('../config/env');

function createLogger() {
  const messages = { errors: [], warnings: [] };
  return {
    messages,
    error(message) {
      messages.errors.push(String(message));
    },
    warn(message) {
      messages.warnings.push(String(message));
    },
  };
}

function validate(env) {
  const logger = createLogger();
  const result = validateEnv({ env, logger, exitOnError: false });
  return { result, logger };
}

function validWebEnv(overrides = {}) {
  return {
    ALESTEB_PROCESS_ROLE: 'web',
    NODE_ENV: 'development',
    JWT_SECRET: 'a'.repeat(64),
    JWT_REFRESH_SECRET: 'b'.repeat(64),
    NEON_DB_URL: 'postgresql://example.invalid/alesteb',
    CLOUDINARY_API_KEY: 'cloudinary-key',
    CLOUDINARY_API_SECRET: 'cloudinary-secret',
    CLOUDINARY_CLOUD_NAME: 'alesteb',
    PAYMENTS_ENCRYPTION_KEY: '0'.repeat(64),
    ...overrides,
  };
}

test('web keeps the complete legacy environment contract', () => {
  assert.throws(
    () => validate({
      ALESTEB_PROCESS_ROLE: 'web',
      NEON_DB_URL: 'postgresql://example.invalid/alesteb',
    }),
    (err) => {
      assert.equal(err.code, 'ENV_VALIDATION_FAILED');
      assert.match(err.message, /JWT_SECRET/);
      assert.match(err.message, /JWT_REFRESH_SECRET/);
      assert.match(err.message, /CLOUDINARY_API_KEY/);
      assert.match(err.message, /CLOUDINARY_API_SECRET/);
      assert.match(err.message, /CLOUDINARY_CLOUD_NAME/);
      assert.match(err.message, /PAYMENTS_ENCRYPTION_KEY/);
      return true;
    }
  );

  const { result } = validate(validWebEnv());
  assert.equal(result.role, 'web');
  assert.deepEqual(result.requiredVariables, [
    'JWT_SECRET',
    'JWT_REFRESH_SECRET',
    'NEON_DB_URL',
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_API_SECRET',
    'CLOUDINARY_CLOUD_NAME',
    'PAYMENTS_ENCRYPTION_KEY',
  ]);
});

test('a missing process role falls back to the strict web contract', () => {
  assert.throws(
    () => validate({ NEON_DB_URL: 'postgresql://example.invalid/alesteb' }),
    (err) => err.code === 'ENV_VALIDATION_FAILED' && /JWT_SECRET/.test(err.message)
  );
});

test('notification-worker requires only the configured database connection', () => {
  const env = {
    NODE_ENV: 'production',
    ALESTEB_PROCESS_ROLE: 'notification-worker',
    NEON_DB_URL: 'postgresql://example.invalid/alesteb',
    AURA_STAGING_MODE: 'true',
    AURA_NOTIFICATION_WORKER_ENABLED: 'true',
    AURA_NOTIFICATION_MOCK_PROVIDER_ENABLED: 'true',
    LEGACY_CREDIT_REMINDER_WORKER_ENABLED: 'false',
  };
  const { result, logger } = validate(env);

  assert.equal(result.role, 'notification-worker');
  assert.deepEqual(result.requiredVariables, ['NEON_DB_URL']);
  assert.deepEqual(logger.messages.errors, []);
  for (const unrelated of [
    'JWT_SECRET',
    'JWT_REFRESH_SECRET',
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_API_SECRET',
    'CLOUDINARY_CLOUD_NAME',
    'PAYMENTS_ENCRYPTION_KEY',
    'OPENAI_API_KEY',
    'BREVO_API_KEY',
    'VAPID_PUBLIC_KEY',
    'VAPID_PRIVATE_KEY',
  ]) {
    assert.equal(Object.hasOwn(env, unrelated), false);
  }
});

test('image-worker staging mock starts without real provider credentials', () => {
  const { result } = validate({
    NODE_ENV: 'production',
    ALESTEB_PROCESS_ROLE: 'image-worker',
    NEON_DB_URL: 'postgresql://example.invalid/alesteb',
    AURA_STAGING_MODE: 'true',
    AURA_IMAGE_MOCK_PROVIDER_ENABLED: 'true',
    AURA_IMAGE_WORKER_ENABLED: 'true',
  });

  assert.equal(result.imageMockEnabled, true);
  assert.deepEqual(result.requiredVariables, ['NEON_DB_URL']);
});

test('image-worker real mode requires OpenAI and Cloudinary credentials', () => {
  const base = {
    NODE_ENV: 'production',
    ALESTEB_PROCESS_ROLE: 'image-worker',
    NEON_DB_URL: 'postgresql://example.invalid/alesteb',
    AURA_STAGING_MODE: 'true',
    AURA_IMAGE_MOCK_PROVIDER_ENABLED: 'false',
  };

  assert.throws(
    () => validate(base),
    (err) => {
      assert.equal(err.code, 'ENV_VALIDATION_FAILED');
      for (const name of [
        'OPENAI_API_KEY',
        'OPENAI_IMAGE_MODEL',
        'CLOUDINARY_API_KEY',
        'CLOUDINARY_API_SECRET',
        'CLOUDINARY_CLOUD_NAME',
      ]) {
        assert.match(err.message, new RegExp(name));
      }
      return true;
    }
  );

  const { result } = validate({
    ...base,
    OPENAI_API_KEY: 'openai-key',
    OPENAI_IMAGE_MODEL: 'configured-image-model',
    CLOUDINARY_API_KEY: 'cloudinary-key',
    CLOUDINARY_API_SECRET: 'cloudinary-secret',
    CLOUDINARY_CLOUD_NAME: 'alesteb',
  });
  assert.equal(result.imageMockEnabled, false);
});

test('predictive-worker requires only the configured database connection', () => {
  const { result } = validate({
    NODE_ENV: 'production',
    ALESTEB_PROCESS_ROLE: 'predictive-worker',
    NEON_DB_URL: 'postgresql://example.invalid/alesteb',
  });

  assert.equal(result.role, 'predictive-worker');
  assert.deepEqual(result.requiredVariables, ['NEON_DB_URL']);
});

test('an invalid process role is rejected', () => {
  assert.throws(
    () => validate({
      ALESTEB_PROCESS_ROLE: 'unknown-worker',
      NEON_DB_URL: 'postgresql://example.invalid/alesteb',
    }),
    (err) => err.code === 'ENV_VALIDATION_FAILED'
      && /ALESTEB_PROCESS_ROLE invalido/.test(err.message)
  );
});

test('each entrypoint defines its role before the first require', () => {
  const entrypoints = {
    'server.js': 'web',
    'worker.notification.js': 'notification-worker',
    'worker.ai.js': 'image-worker',
    'worker.predictive.js': 'predictive-worker',
  };

  for (const [file, expectedRole] of Object.entries(entrypoints)) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const assignment = source.match(
      /process\.env\.ALESTEB_PROCESS_ROLE\s*=\s*['"]([^'"]+)['"]\s*;/
    );
    const firstRequire = source.search(/\brequire\s*\(/);

    assert.ok(assignment, `${file} no define ALESTEB_PROCESS_ROLE`);
    assert.equal(assignment[1], expectedRole);
    assert.ok(assignment.index < firstRequire, `${file} define el rol despues de require`);
  }
});
