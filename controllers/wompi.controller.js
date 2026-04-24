// controllers/wompi.controller.js
const crypto = require("crypto");
const pool   = require("../config/db"); // ajusta si tu pool se importa distinto

const WOMPI_BASE =
  process.env.WOMPI_ENV === "prod"
    ? "https://production.wompi.co/v1"
    : "https://sandbox.wompi.co/v1";

/* ─────────────────────────────────────────────────────────────────────────
   Genera la firma de integridad que exige Wompi
   chain = reference + amount_in_cents + currency + integrity_secret
   ───────────────────────────────────────────────────────────────────────── */
function buildSignature(reference, amountInCents, currency = "COP") {
  const chain = `${reference}${amountInCents}${currency}${process.env.WOMPI_INTEGRITY_SECRET}`;
  return crypto.createHash("sha256").update(chain).digest("hex");
}

/* ─────────────────────────────────────────────────────────────────────────
   GET /api/wompi/session/:sale_id
   Devuelve todo lo necesario para armar el redirect a Wompi Hosted Checkout
   ───────────────────────────────────────────────────────────────────────── */
const getSession = async (req, res) => {
  try {
    const { sale_id } = req.params;

    const { rows } = await pool.query(
      "SELECT id, sale_number, total, payment_status FROM sales WHERE id = $1",
      [sale_id]
    );

    if (!rows.length)
      return res.status(404).json({ success: false, message: "Venta no encontrada" });

    const sale = rows[0];

    if (sale.payment_status === "paid")
      return res.status(400).json({ success: false, message: "Esta venta ya fue pagada" });

    const reference     = sale.sale_number;
    const amountInCents = Math.round(parseFloat(sale.total) * 100);
    const currency      = "COP";
    const signature     = buildSignature(reference, amountInCents, currency);

    return res.json({
      success: true,
      data: {
        public_key:      process.env.WOMPI_PUBLIC_KEY,
        reference,
        amount_in_cents: amountInCents,
        currency,
        signature,
        redirect_url: `${process.env.FRONTEND_URL}/order-success`,
      },
    });
  } catch (err) {
    console.error("[wompi] getSession error:", err);
    return res.status(500).json({ success: false, message: "Error interno" });
  }
};

/* ─────────────────────────────────────────────────────────────────────────
   POST /api/wompi/webhook
   Wompi llama este endpoint cuando cambia el estado de una transacción.
   Sin autenticación JWT — verificamos con firma Wompi.
   ───────────────────────────────────────────────────────────────────────── */
const handleWebhook = async (req, res) => {
  try {
    const { event, data, timestamp, signature } = req.body;

    // ── 1. Verificar firma ────────────────────────────────────────────────
    if (signature?.properties && signature?.checksum) {
      const transaction = data?.transaction ?? {};
      const valuesStr   = signature.properties
        .map((prop) => {
          // e.g. "transaction.id" → transaction["id"]
          const key = prop.replace("transaction.", "");
          return transaction[key] ?? "";
        })
        .join("");

      const chain    = `${valuesStr}${timestamp}${process.env.WOMPI_EVENTS_SECRET}`;
      const expected = crypto.createHash("sha256").update(chain).digest("hex");

      if (expected !== signature.checksum) {
        console.warn("[wompi] Firma de webhook inválida");
        return res.status(401).json({ success: false, message: "Firma inválida" });
      }
    }

    // ── 2. Solo procesamos transaction.updated ────────────────────────────
    if (event === "transaction.updated") {
      const tx = data?.transaction ?? {};
      const { reference, status } = tx;

      const statusMap = {
        APPROVED: "paid",
        DECLINED: "pending",
        VOIDED:   "pending",
        ERROR:    "pending",
      };

      const newStatus = statusMap[status] ?? "pending";

      await pool.query(
        `UPDATE sales SET payment_status = $1, updated_at = now()
         WHERE sale_number = $2`,
        [newStatus, reference]
      );

      if (status === "APPROVED") {
        console.log(`[wompi] ✅ Pago aprobado: ${reference}`);
        // Aquí puedes disparar notificaciones, reducir stock extra, etc.
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("[wompi] webhook error:", err);
    return res.status(500).json({ success: false, message: "Error procesando webhook" });
  }
};

/* ─────────────────────────────────────────────────────────────────────────
   GET /api/wompi/verify/:reference
   El frontend puede consultar si la transacción fue aprobada
   (útil al regresar del hosted checkout)
   ───────────────────────────────────────────────────────────────────────── */
const verifyByReference = async (req, res) => {
  try {
    const { reference } = req.params;

    const { rows } = await pool.query(
      `SELECT id, sale_number, total, payment_status, created_at
       FROM sales WHERE sale_number = $1`,
      [reference]
    );

    if (!rows.length)
      return res.status(404).json({ success: false, message: "Venta no encontrada" });

    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("[wompi] verifyByReference error:", err);
    return res.status(500).json({ success: false, message: "Error interno" });
  }
};

module.exports = { getSession, handleWebhook, verifyByReference };