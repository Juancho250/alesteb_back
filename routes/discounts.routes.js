import { Router } from "express";
import { auth, requireRole } from "../middleware/auth.middleware.js";
import * as ctrl from "../controllers/discounts.controller.js";

const router = Router();

router.get("/", auth, requireRole(["admin"]), ctrl.getAll);
router.post("/", auth, requireRole(["admin"]), ctrl.create);
router.delete("/:id", auth, requireRole(["admin"]), ctrl.remove);

// FALTA ESTA LÍNEA:
router.put("/:id", auth, requireRole(["admin"]), ctrl.update); 

export default router;