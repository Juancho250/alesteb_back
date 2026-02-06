const express = require("express");
const { auth, requireRole } = require("../middleware/auth.middleware");
const ctrl = require("../controllers/categories.controller");

const router = express.Router();

// 🌐 PÚBLICAS
router.get("/", ctrl.getAll);
router.get("/flat", ctrl.getFlat); // 🆕 LISTA PLANA PARA SELECTS

// 🔐 ADMIN
router.post("/", auth, requireRole(["admin"]), ctrl.create);
router.put("/:id", auth, requireRole(["admin"]), ctrl.update);
router.delete("/:id", auth, requireRole(["admin"]), ctrl.remove);

module.exports = router;