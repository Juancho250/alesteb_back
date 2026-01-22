import { Router } from "express";
import { auth, requireRole } from "../middleware/auth.middleware.js";
import * as ctrl from "../controllers/discounts.controller.js";

const router = Router();

router.get("/", auth, requireRole(["admin"]), ctrl.getAll);
router.post("/", auth, requireRole(["admin"]), ctrl.create);
router.delete("/:id", auth, requireRole(["admin"]), ctrl.remove);

export default router;