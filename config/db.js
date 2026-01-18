const { Pool } = require("pg");
require("dotenv").config();
// Usamos Pool para gestionar múltiples conexiones eficientemente
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // Necesario para servicios como Render y Supabase
  },
});

// Verificación de conexión
db.connect((err, client, release) => {
  if (err) {
    return console.error("❌ Error conectando a Supabase:", err.stack);
  }
  console.log("🟢 Conectado exitosamente a Supabase (PostgreSQL)");
  release();
});

// Exportamos un objeto compatible con lo que ya tienes
module.exports = {
  // Para SELECT (múltiples filas)
  all: (sql, params = []) => db.query(sql, params).then(res => res.rows),
  
  // Para INSERT/UPDATE (una sola fila)
  run: (sql, params = []) => db.query(sql, params),
  
  // Para obtener una sola fila
  get: (sql, params = []) => db.query(sql, params).then(res => res.rows[0]),
  
  // Referencia directa al pool por si la necesitas
  query: (text, params) => db.query(text, params),
};