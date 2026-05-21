const { Pool } = require('pg');

const pool = new Pool({
  connectionString:       process.env.NEON_DB_URL,
  ssl:                    { rejectUnauthorized: false },
  max:                    10,
  idleTimeoutMillis:      30_000,
  connectionTimeoutMillis: 5_000,
  allowExitOnIdle:        true,
});

pool.query('SELECT 1')
  .then(() => console.log('DB conectada'))
  .catch((err) => {
    console.error('Error al conectar a la DB:', err.message);
    process.exit(1);
  });

module.exports = pool;
