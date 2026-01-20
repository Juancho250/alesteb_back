const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth.middleware");
const expensesController = require("../controllers/expenses.controller");

router.get("/", auth, expensesController.getExpenses);
router.get("/summary", auth, expensesController.getFinanceSummary);
router.post("/", auth, expensesController.createExpense);

module.exports = router;