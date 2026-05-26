// controllers/wompi.controller.js
// Thin controller — all gateway logic lives in services/payment.service.js.
// Credentials are NEVER read from .env here; each store loads its own account from the DB.
const db = require("../config/db");
const { buildCheckoutSession, processWompiWebhook } = require("../services/payment.service");
const { emitDataUpdate } = require("../config/socket");
const { sendPaymentConfirmedEmail }   = require("../config/emailConfig");
const { notifyUser, notifyTenant, Payloads } = require("../services/push.service");

// ── GET /api/wompi/session/:sale_id ──────────────────────────────────────────
// Returns the checkout parameters for Wompi Widget / Redirect.
// Amount is always read from the DB — never accepted from the client.
const getSession = async (req, res) => {
  try {
    const { sale_id } = req.params;

    // Load sale and resolve its owner admin
    const { rows } = await db.query(
      `SELECT id, sale_number, total, payment_status, owner_admin_id
       FROM sales WHERE id = $1`,
      [sale_id]
    );

    if (!rows.length)
      return res.status(404).json({ success: false, message: "Venta no encontrada" });

    const sale = rows[0];

    if (sale.payment_status === "paid")
      return res.status(400).json({ success: false, message: "Esta venta ya fue pagada" });

    // Build checkout session using the store's own payment account
    let sessionData;
    try {
      sessionData = await buildCheckoutSession(sale, sale.owner_admin_id);
    } catch (err) {
      const status = err.status === 402 ? 402 : 500;
      return res.status(status).json({ success: false, message: err.message });
    }

    return res.json({ success: true, data: sessionData });
  } catch (err) {
    console.error("[wompi] getSession error:", err.message);
    return res.status(500).json({ success: false, message: "Error interno al preparar el pago" });
  }
};

// ── POST /api/wompi/webhook ───────────────────────────────────────────────────
// Raw body (Buffer) required — express.raw() is applied in the route file BEFORE
// express.json() global middleware.
// Always responds 200; never exposes internal errors to Wompi.
const handleWebhook = async (req, res) => {
  const rawBody = req.body; // Buffer from express.raw()

  if (!Buffer.isBuffer(rawBody) || !rawBody.length) {
    // Unexpected — body parser may have run first; still respond 200
    console.warn("[wompi] webhook received non-raw body");
    return res.sendStatus(200);
  }

  const result = await processWompiWebhook(rawBody);

  // Fire side-effects after successful approval (outside the DB transaction)
  if (result.processed && result.reason === "approved" && result.sale_id) {
    try {
      const { rows: info } = await db.query(
        `SELECT s.total, s.sale_number, s.customer_id, s.owner_admin_id,
                u.name, u.email
         FROM sales s
         JOIN users u ON u.id = s.customer_id
         WHERE s.id = $1`,
        [result.sale_id]
      );
      if (info.length) {
        const { email, name, customer_id, owner_admin_id, total, sale_number } = info[0];
        const orderCode = `AL-${sale_number?.slice(4)}`;

        if (email) {
          sendPaymentConfirmedEmail?.(email, name, { orderCode, total, items: [] }).catch(() => {});
        }
        notifyUser(customer_id, Payloads.paymentConfirmed(orderCode)).catch(() => {});
        if (owner_admin_id) {
          notifyTenant(owner_admin_id, Payloads.paymentReceived(sale_number, total)).catch(() => {});
          emitDataUpdate("sales", "updated", { id: result.sale_id, payment_status: result.new_status }, owner_admin_id);
        }
      }
    } catch (sideErr) {
      // Side-effects failing must not cause a non-200 response to Wompi
      console.error("[wompi] webhook side-effect error:", sideErr.message);
    }
  }

  return res.sendStatus(200);
};

// ── GET /api/wompi/verify/:reference ─────────────────────────────────────────
// Polling endpoint called by the storefront after Wompi redirect.
// Returns the sale's current payment status by reference (sale_number).
const verifyByReference = async (req, res) => {
  try {
    const { reference } = req.params;

    const { rows } = await db.query(
      `SELECT s.id, s.sale_number, s.total, s.payment_status, s.created_at,
              spt.status AS tx_status, spt.provider_tx_id
       FROM sales s
       LEFT JOIN sale_payment_transactions spt ON spt.reference = s.sale_number
       WHERE s.sale_number = $1
       LIMIT 1`,
      [reference]
    );

    if (!rows.length)
      return res.status(404).json({ success: false, message: "Venta no encontrada" });

    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("[wompi] verifyByReference error:", err.message);
    return res.status(500).json({ success: false, message: "Error interno" });
  }
};

module.exports = { getSession, handleWebhook, verifyByReference };