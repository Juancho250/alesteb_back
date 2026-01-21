import express from "express";
import { auth } from "../middleware/auth.middleware.js";
import * as expensesController from "../controllers/expenses.controller.js";

const router = express.Router();

router.get("/", auth, expensesController.getExpenses);
router.get("/summary", auth, expensesController.getFinanceSummary);
router.post("/", auth, expensesController.createExpense);

export default router;
