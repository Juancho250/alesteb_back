require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.NEON_DB_URL,
  ssl: { rejectUnauthorized: false } // necesario por sslmode=require
});

pool.query('SELECT 1')
  .then(() => console.log('✅ Conectado a Neon'))
  .catch(err => console.error('❌ Error al conectar a Neon:', err.message));

module.exports = pool;
