// routes/categories.routes.js — SIMPLIFICADO
const express = require("express");
const { requireManager } = require("../middleware/auth.middleware");
const ctrl = require("../controllers/categories.controller");

const router = express.Router();

// auth y adminScope ya vienen del index.js global
// Solo agregas el rol requerido por ruta
router.get("/",     ctrl.getAll);   // ← pública o semi-pública
router.get("/flat", ctrl.getFlat);
router.post("/",    requireManager, ctrl.create);
router.put("/:id",  requireManager, ctrl.update);
router.delete("/:id", requireManager, ctrl.remove);

module.exports = router;