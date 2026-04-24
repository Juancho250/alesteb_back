import { Router } from "express";
import { chat } from "../controllers/agent.controller.js";
import authMiddleware from "../middleware/auth.middleware.js";

const router = Router();
router.post("/chat", authMiddleware, chat);

export default router;