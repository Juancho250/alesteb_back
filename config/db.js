import postgres from 'postgres'
import 'dotenv/config' // Asegura que las variables de entorno se carguen

const connectionString = process.env.DATABASE_URL

// Creamos la instancia de conexión
const sql = postgres(connectionString, {
  ssl: 'require', // Supabase requiere SSL
  prepare: false  // Recomendado para usar con el Transaction Pooler (puerto 6543)
})

// Verificación real de conexión usando la variable correcta 'sql'
sql`SELECT 1`
  .then(() => {
    console.log("🟢 Conectado exitosamente a Supabase (PostgreSQL)")
  })
  .catch(err => {
    console.error("❌ Error conectando a Supabase:", err.message)
  })

export default sql