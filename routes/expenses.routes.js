const express = require("express");
const { auth } = require("../middleware/auth.middleware");
const expensesController = require("../controllers/expenses.controller");

const router = express.Router();

router.get("/", auth, expensesController.getExpenses);
router.get("/summary", auth, expensesController.getFinanceSummary);
router.post("/", auth, expensesController.createExpense);

module.exports = router;