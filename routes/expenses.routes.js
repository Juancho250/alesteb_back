const express = require("express");
const expensesController = require("../controllers/expenses.controller");

const router = express.Router();

router.get("/", expensesController.getExpenses);
router.get("/summary", expensesController.getFinanceSummary);
router.post("/", expensesController.createExpense);

module.exports = router;