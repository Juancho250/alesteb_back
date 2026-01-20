// backend/routes/expenses.routes.js
import { Router } from "express";
import { auth } from "../middleware/auth.middleware.js"; // ✅ Correcto
import { getExpenses, getFinanceSummary, createExpense } from "../controllers/expenses.controller.js";

const router = Router();

router.get("/", auth, getExpenses); // Protegido
router.get("/summary", auth, getFinanceSummary); // Protegido
router.post("/", auth, createExpense); // Protegido

export default router;