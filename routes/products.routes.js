import { Router } from "express";
import {
  auth,
  requireRole
} from "../middleware/auth.middleware.js";
import upload from "../middleware/upload.middleware.js";
import * as ctrl from "../controllers/products.controller.js";

const router = Router();

// 🌐 PÚBLICO
router.get("/", ctrl.getAll);
router.get("/:id", ctrl.getById);

// 🔐 SOLO ADMIN
router.post(
  "/",
  auth,
  requireRole(["admin"]),
  upload.array("images", 6),
  ctrl.create
);

router.put(
  "/:id",
  auth,
  requireRole(["admin"]),
  ctrl.update
);

router.delete(
  "/:id",
  auth,
  requireRole(["admin"]),
  ctrl.remove
);

export default router;
