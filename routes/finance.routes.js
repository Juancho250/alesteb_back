const express = require("express");
const router = express.Router();
const fc = require("../controllers/finance.controller");
const { auth, requireManager } = require("../middleware/auth.middleware");

// ============================================
// 📊 RESUMEN Y REPORTES
// ============================================

/**
 * @route   GET /api/finance/summary
 * @desc    Obtener resumen financiero (KPIs del dashboard)
 * @query   start_date, end_date - Opcional para filtrar por período
 * @access  Private (Admin, Gerente)
 */
router.get("/summary", auth, requireManager, fc.getSummary);

/**
 * @route   GET /api/finance/cashflow
 * @desc    Obtener flujo de caja mensual (últimos 6 meses)
 * @access  Private (Admin, Gerente)
 */
router.get("/cashflow", auth, requireManager, fc.getCashflow);

/**
 * @route   GET /api/finance/profit-by-product
 * @desc    Obtener rentabilidad por producto
 * @access  Private (Admin, Gerente)
 */
router.get("/profit-by-product", auth, requireManager, fc.getProfitByProduct);

// ============================================
// 📄 FACTURAS
// ============================================

/**
 * @route   GET /api/finance/invoices
 * @desc    Listar facturas
 * @query   type - 'service' o 'purchase' (opcional)
 * @query   status - 'paid', 'pending', 'partial' (opcional)
 * @query   start_date, end_date - Rango de fechas (opcional)
 * @query   limit, offset - Paginación
 * @access  Private (Admin, Gerente)
 */
router.get("/invoices", auth, requireManager, fc.getInvoices);

/**
 * @route   POST /api/finance/invoices
 * @desc    Crear factura (servicio o compra)
 * @body    {
 *   invoice_type: 'service' | 'purchase',
 *   provider_id: number (requerido para compras),
 *   invoice_number: string (opcional),
 *   invoice_date: date,
 *   due_date: date (opcional),
 *   description: string,
 *   total_amount: number,
 *   payment_method: 'cash' | 'credit' | 'transfer' | 'check',
 *   items: [{ product_id, quantity, unit_price }] (solo para compras),
 *   notes: string (opcional)
 * }
 * @access  Private (Admin, Gerente)
 * 
 * IMPORTANTE:
 * - Para SERVICIOS: solo llenar campos básicos (luz, internet, etc.)
 * - Para COMPRAS: incluir items[] con productos
 * - Si payment_method='credit', se crea deuda pendiente
 */
router.post("/invoices", auth, requireManager, fc.createInvoice);

/**
 * @route   POST /api/finance/invoices/pay
 * @desc    Registrar pago de factura (pago total o parcial)
 * @body    {
 *   invoice_id: number,
 *   amount: number,
 *   payment_method: string,
 *   payment_date: date (opcional),
 *   notes: string (opcional)
 * }
 * @access  Private (Admin, Gerente)
 */
router.post("/invoices/pay", auth, requireManager, fc.payInvoice);

module.exports = router;