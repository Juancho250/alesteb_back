"use strict";

const { Pool } = require("pg");

const connectionString = process.env.NEON_DB_URL || "";

function isLocalDatabase(url) {
  return (
    !url ||
    url.includes("localhost") ||
    url.includes("127.0.0.1")
  );
}

const useSsl = !isLocalDatabase(connectionString);

const pool = new Pool({
  connectionString: connectionString || undefined,

  // Neon usa SSL; PostgreSQL local normalmente no.
  ssl: useSsl
    ? {
        rejectUnauthorized: false,
      }
    : false,

  max: Number.parseInt(process.env.DB_POOL_MAX || "10", 10),
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
 * Verifica la conexión explícitamente.
 * No se ejecuta automáticamente al importar este archivo.
 */
pool.checkConnection = async function checkConnection() {
  const result = await pool.query("SELECT 1 AS ok");
  console.log("[DB] Conectada");
  return result;
};

module.exports = pool;