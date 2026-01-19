import { Router } from "express";
import {
  getExpenses,
  createExpense,
  getFinanceSummary
} from "../controllers/expenses.controller.js";
import authMiddleware from "../middleware/auth.middleware.js";

const router = Router();

router.get("/", authMiddleware, getExpenses);
router.post("/", authMiddleware, createExpense);
router.get("/summary", authMiddleware, getFinanceSummary);

export default router;
