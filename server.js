import 'dotenv/config'; // 1. Cargar env antes que nada
import app from "./app.js"; // 2. Añadir la extensión .js (obligatorio en ESM)

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en: http://localhost:${PORT}`);
});