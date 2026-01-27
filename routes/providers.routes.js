const { Router } = require("express"); // Cambiar a require
const { 
  getProviders, 
  createProvider, 
  getProviderHistory 
} = require("../controllers/providers.controller"); // Asegúrate que el controlador use exports.nombre

const router = Router();

router.get("/", getProviders); // Nota: solo "/" porque el prefijo /api/providers se pone en app.js
router.post("/", createProvider);
router.get("/:id/history", getProviderHistory);

module.exports = router; // Cambiar a module.exports