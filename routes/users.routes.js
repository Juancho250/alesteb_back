const express = require("express");
const router = express.Router();

const usersController = require("../controllers/users.controller");

const {
  auth,
  isAdmin,
  sanitizeParams,
  allowFields,
} = require("../middleware/auth.middleware");

// ─── Sanitizar params en todas las rutas ─────────────────────────
router.use(sanitizeParams);

// ═══════════════════════════════════════════════════════════════════
// TODAS LAS RUTAS DE /api/users REQUIEREN ADMIN
// Los datos de otros usuarios nunca deben ser visibles a un cliente.
// ═══════════════════════════════════════════════════════════════════

// GET /api/users  — lista de usuarios
router.get("/", auth, isAdmin, usersController.getUsers);

// POST /api/users  — crear usuario
router.post(
  "/",
  auth,
  isAdmin,
  allowFields(["email", "password", "name", "phone", "cedula", "city", "address", "role_id"]),
  usersController.createUser
);

// PUT /api/users/:id  — editar usuario
router.put(
  "/:id",
  auth,
  isAdmin,
  allowFields(["name", "email", "phone", "cedula", "city", "address", "role_id", "password"]),
  usersController.updateUser
);

// DELETE /api/users/:id  — eliminar usuario
router.delete("/:id", auth, isAdmin, usersController.deleteUser);

module.exports = router;