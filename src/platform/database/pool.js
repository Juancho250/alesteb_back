"use strict";

const { Pool } = require("pg");

const connectionString = String(
  process.env.NEON_DB_URL || ""
).trim();

function isLocalDatabase(url) {
  if (!url) return true;

  try {
    const parsed = new URL(url);

    return [
      "localhost",
      "127.0.0.1",
      "::1",
      "[::1]",
    ].includes(parsed.hostname);
  } catch {
    return false;
  }
}

const configuredPoolMax = Number.parseInt(
  process.env.DB_POOL_MAX || "10",
  10
);

const pool = new Pool({
  ...(connectionString
    ? {
        connectionString,
      }
    : {}),

  // PostgreSQL local normalmente no usa SSL.
  // Neon y otras bases remotas requieren SSL.
  ssl: isLocalDatabase(connectionString)
    ? false
    : {
        rejectUnauthorized: false,
      },

  max:
    Number.isSafeInteger(configuredPoolMax) &&
    configuredPoolMax > 0
      ? configuredPoolMax
      : 10,

  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  allowExitOnIdle: true,
});

pool.on("error", (error) => {
  console.error(
    "[DB] Error inesperado en cliente idle:",
    error.message
  );
});

/**
 * Comprueba explícitamente la conexión.
 * Importar el módulo no abre una conexión automáticamente.
 */
pool.checkConnection = async function checkConnection() {
  const result = await pool.query("SELECT 1 AS ok");

  console.log("[DB] Conectada");

  return result;
};

module.exports = pool;