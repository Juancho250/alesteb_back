const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth.middleware');

// --- CORRECCIÓN AQUÍ ---
// Cambia '../services/db' por la ruta real. 
// Si tienes una carpeta 'config', prueba con:
const db = require('../config/db'); 
// -----------------------

router.get('/', auth, async (req, res) => {
  try {
    const result = await db.query("SELECT id, slug, description FROM permissions ORDER BY description ASC");
    res.json(result.rows || result); 
  } catch (error) {
    console.error("Error en permisos:", error);
    res.status(500).json({ message: "Error al obtener permisos" });
  }
});

module.exports = router;