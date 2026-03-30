// server.js
require('dotenv/config');
const app = require("./app");

const PORT = process.env.PORT || 4000;

// Solo levantar servidor HTTP en local (no en Vercel)
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en: http://localhost:${PORT}`);
  });
}

// ✅ ESTO ES LO QUE FALTABA — Vercel necesita el export
module.exports = app;