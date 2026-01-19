import { Router } from "express";
import {
  getExpenses,
  getFinanceSummary,
  createExpense
} from "../controllers/expenses.controller.js";

const router = Router();

router.get("/", getExpenses);
router.get("/summary", getFinanceSummary);
router.post("/", createExpense);

export default router;
