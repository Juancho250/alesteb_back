const express = require("express");
const router = express.Router();

const salesController = require("../controllers/sales.controller");
const { auth, requireManager } = require("../middleware/auth");

/*
|--------------------------------------------------------------------------
| RUTAS DE VENTAS
|--------------------------------------------------------------------------
| Prefijo usado en app.js:
| app.use("/api/sales", salesRoutes);
|--------------------------------------------------------------------------
*/

/**
 * 🔹 LISTADO GENERAL DE VENTAS
 * 👉 ESTA ES LA RUTA QUE FALTABA
 * GET /api/sales
 */
router.get(
  "/",
  auth,
  requireManager,
  salesController.getAllSales
);

/**
 * 🔹 CREAR VENTA
 * POST /api/sales
 */
router.post(
  "/",
  auth,
  salesController.createSale
);

/**
 * 🔹 CHECKOUT (e-commerce)
 * POST /api/sales/checkout
 */
router.post(
  "/checkout",
  auth,
  salesController.checkout
);

/**
 * 🔹 HISTORIAL DE VENTAS DEL USUARIO
 * GET /api/sales/user/history
 */
router.get(
  "/user/history",
  auth,
  salesController.getUserSalesHistory
);

/**
 * 🔹 ESTADÍSTICAS DEL USUARIO
 * GET /api/sales/user/stats
 */
router.get(
  "/user/stats",
  auth,
  salesController.getUserSalesStats
);

/**
 * 🔹 DETALLE DE UNA VENTA
 * GET /api/sales/:id
 */
router.get(
  "/:id",
  auth,
  salesController.getSaleById
);

module.exports = router;
