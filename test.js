require('dotenv').config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});

pool.query("SELECT 1")
  .then(() => console.log("✅ Conectado a Supabase"))
  .catch(err => console.error("❌ Error:", err.message));
