const express = require("express");
const { auth, requireManager } = require("../middleware/auth.middleware");
const expensesController = require("../controllers/expenses.controller");

const router = express.Router();

// ============================================
// 💸 RUTAS DE GASTOS
// ============================================

/**
 * @route   GET /api/expenses
 * @desc    Obtener todos los gastos
 * @access  Private (Admin y Gerente)
 */
router.get("/", auth, requireManager, expensesController.getExpenses);

/**
 * @route   GET /api/expenses/summary
 * @desc    Obtener resumen financiero
 * @access  Private (Admin y Gerente)
 */
router.get("/summary", auth, requireManager, expensesController.getFinanceSummary);

/**
 * @route   POST /api/expenses
 * @desc    Crear nuevo gasto/compra
 * @access  Private (Admin y Gerente)
 */
router.post("/", auth, requireManager, expensesController.createExpense);

module.exports = router;