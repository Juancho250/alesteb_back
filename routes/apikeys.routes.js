// routes/apikeys.routes.js
// Cada admin gestiona ÚNICAMENTE sus propias API keys.
// El superadmin también puede acceder (bypass automático en requireAdmin).
const express      = require("express");
const router       = express.Router();
const apiKeysCtrl  = require("../controllers/apikeys.controller");
const { auth, requireAdmin } = require("../middleware/auth.middleware");

// Todas las rutas requieren autenticación como admin (o superadmin)
router.use(auth, requireAdmin);

// ─── Permisos disponibles ────────────────────────────────────────────────────
// GET /api/api-keys/permissions
// Devuelve el listado de permisos para poblar el formulario en el frontend
router.get("/permissions", apiKeysCtrl.getAvailablePermissions);

// ─── CRUD ────────────────────────────────────────────────────────────────────
// GET    /api/api-keys          → Lista todas las keys del admin autenticado
router.get("/", apiKeysCtrl.getApiKeys);

// POST   /api/api-keys          → Crea una nueva key (la clave completa se muestra UNA sola vez)
router.post("/", apiKeysCtrl.createApiKey);

// PUT    /api/api-keys/:id      → Edita nombre, permisos, orígenes (NO regenera la clave)
router.put("/:id", apiKeysCtrl.updateApiKey);

// PATCH  /api/api-keys/:id/toggle → Activa o desactiva la key
router.patch("/:id/toggle", apiKeysCtrl.toggleApiKey);

// POST   /api/api-keys/:id/rotate → Regenera la clave (invalida la anterior)
router.post("/:id/rotate", apiKeysCtrl.rotateApiKey);

// DELETE /api/api-keys/:id      → Elimina la key permanentemente
router.delete("/:id", apiKeysCtrl.deleteApiKey);

// GET    /api/api-keys/:id/logs → Historial de uso de la key
router.get("/:id/logs", apiKeysCtrl.getApiKeyLogs);

module.exports = router;