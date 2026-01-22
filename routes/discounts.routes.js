const express = require("express");
const { auth, requireRole } = require("../middleware/auth.middleware");
const ctrl = require("../controllers/discounts.controller");

const router = express.Router();

router.get("/", auth, requireRole(["admin"]), ctrl.getAll);
router.post("/", auth, requireRole(["admin"]), ctrl.create);
router.delete("/:id", auth, requireRole(["admin"]), ctrl.remove);
router.put("/:id", auth, requireRole(["admin"]), ctrl.update);

module.exports = router;