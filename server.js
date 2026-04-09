// server.js
require('dotenv/config');
const app = require("./app");

const PORT = process.env.PORT || 4000;

// ✅ CORRECCIÓN CRÍTICA: Siempre levantar el listener HTTP.
// Render es un servidor tradicional (NO serverless) y necesita app.listen()
// aunque NODE_ENV sea 'production'. El condicional anterior hacía que
// el proceso arrancara pero nunca escuchara ningún puerto → todas las
// rutas fallaban silenciosamente.
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  console.log(`🌍 Entorno: ${process.env.NODE_ENV || 'development'}`);
});

// ✅ Exportar para Vercel (serverless) — no interfiere con Render
module.exports = app;