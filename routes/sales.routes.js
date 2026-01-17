const express = require("express");
const router = express.Router();
const {
  createSale,
  getSales,
  getSaleById,
} = require("../controllers/sales.controller");

router.post("/", createSale);
router.get("/", getSales);
router.get("/:id", getSaleById); // 👈 ESTA ES LA CLAVE

module.exports = router;
