// controllers/paymentAccounts.controller.js
// CRUD for store payment gateway accounts.
// Secrets are always stored AES-256-GCM encrypted; never returned in plaintext.
const db = require("../config/db");
const { encrypt }              = require("../utils/crypto");
const { decryptCredentials, verifyWompiCredentials } = require("../services/payment.service");

const ALLOWED_PROVIDERS    = ["wompi"];
const ALLOWED_ENVIRONMENTS = ["sandbox", "production"];

function maskSecret(s) {
  if (!s || s.length < 8) return "••••••••";
  return s.slice(0, 4) + "•".repeat(Math.min(s.length - 8, 12)) + s.slice(-4);
}

// ── GET /api/payment-accounts ──────────────────────────────────────────────
exports.getAccount = async (req, res) => {
  try {
    const adminId = req.user.owner_admin_id ?? req.user.id;

    const { rows } = await db.query(
      `SELECT id, provider, environment, status, public_key,
              last_verified_at, is_active, created_at, updated_at
       FROM store_payment_accounts
       WHERE admin_id = $1 AND is_active = true
       LIMIT 1`,
      [adminId]
    );

    if (!rows.length) return res.json({ success: true, data: null });

    const row = rows[0];
    return res.json({
      success: true,
      data: {
        id:               row.id,
        provider:         row.provider,
        environment:      row.environment,
        status:           row.status,
        public_key:       row.public_key,
        private_key:      maskSecret("hidden"),
        events_secret:    maskSecret("hidden"),
        integrity_secret: maskSecret("hidden"),
        last_verified_at: row.last_verified_at,
        is_active:        row.is_active,
        created_at:       row.created_at,
        updated_at:       row.updated_at,
      },
    });
  } catch (err) {
    console.error("[paymentAccounts] getAccount:", err.message);
    return res.status(500).json({ success: false, message: "Error al obtener cuenta de pago" });
  }
};

// ── POST /api/payment-accounts ─────────────────────────────────────────────
exports.createOrUpdate = async (req, res) => {
  const {
    provider = "wompi",
    environment = "sandbox",
    public_key,
    private_key,
    events_secret,
    integrity_secret,
  } = req.body;

  if (!public_key || !private_key || !events_secret || !integrity_secret) {
    return res.status(400).json({
      success: false,
      message: "Se requieren: public_key, private_key, events_secret, integrity_secret",
    });
  }

  if (!ALLOWED_PROVIDERS.includes(provider)) {
    return res.status(400).json({ success: false, message: `Proveedor no soportado. Use: ${ALLOWED_PROVIDERS.join(", ")}` });
  }

  if (!ALLOWED_ENVIRONMENTS.includes(environment)) {
    return res.status(400).json({ success: false, message: `Ambiente inválido. Use: ${ALLOWED_ENVIRONMENTS.join(", ")}` });
  }

  const adminId = req.user.owner_admin_id ?? req.user.id;
  const client  = await db.connect();
  try {
    await client.query("BEGIN");

    const private_key_enc      = encrypt(private_key);
    const events_secret_enc    = encrypt(events_secret);
    const integrity_secret_enc = encrypt(integrity_secret);

    const { rows } = await client.query(
      `INSERT INTO store_payment_accounts
         (admin_id, provider, environment, status, public_key,
          private_key_enc, events_secret_enc, integrity_secret_enc, updated_at)
       VALUES ($1,$2,$3,'pending',$4,$5,$6,$7,now())
       ON CONFLICT (admin_id, provider) DO UPDATE SET
         environment          = EXCLUDED.environment,
         status               = 'pending',
         public_key           = EXCLUDED.public_key,
         private_key_enc      = EXCLUDED.private_key_enc,
         events_secret_enc    = EXCLUDED.events_secret_enc,
         integrity_secret_enc = EXCLUDED.integrity_secret_enc,
         updated_at           = now()
       RETURNING id, provider, environment, status, public_key, created_at, updated_at`,
      [adminId, provider, environment, public_key,
       private_key_enc, events_secret_enc, integrity_secret_enc]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Cuenta de pago guardada. Usa /verify para confirmar las credenciales con Wompi.",
      data: rows[0],
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[paymentAccounts] createOrUpdate:", err.message);
    return res.status(500).json({ success: false, message: "Error al guardar la cuenta de pago" });
  } finally {
    client.release();
  }
};

// ── POST /api/payment-accounts/verify ─────────────────────────────────────
// Tests credentials against Wompi; sets status='connected' on success.
exports.verify = async (req, res) => {
  const adminId = req.user.owner_admin_id ?? req.user.id;

  try {
    const { rows } = await db.query(
      `SELECT id, provider, environment, private_key_enc, events_secret_enc, integrity_secret_enc
       FROM store_payment_accounts
       WHERE admin_id = $1 AND is_active = true
       LIMIT 1`,
      [adminId]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: "No tienes cuenta de pago configurada. Guárdala primero." });
    }

    const acct = rows[0];
    const { private_key } = decryptCredentials(acct);

    const ok     = await verifyWompiCredentials(private_key, acct.environment);
    const status = ok ? "connected" : "error";
    const now    = new Date();

    await db.query(
      `UPDATE store_payment_accounts
       SET status = $1, last_verified_at = $2, updated_at = $2
       WHERE id = $3`,
      [status, now, acct.id]
    );

    return res.json({
      success: true,
      message: ok
        ? "Credenciales verificadas correctamente. Tu cuenta está conectada."
        : "Las credenciales no son válidas en Wompi. Revísalas y vuelve a intentarlo.",
      data: { status, last_verified_at: now },
    });
  } catch (err) {
    console.error("[paymentAccounts] verify:", err.message);
    return res.status(500).json({ success: false, message: "Error al verificar credenciales con Wompi" });
  }
};

// ── DELETE /api/payment-accounts ──────────────────────────────────────────
exports.deactivate = async (req, res) => {
  const adminId = req.user.owner_admin_id ?? req.user.id;

  try {
    const { rowCount } = await db.query(
      `UPDATE store_payment_accounts
       SET is_active = false, updated_at = now()
       WHERE admin_id = $1 AND is_active = true`,
      [adminId]
    );

    if (!rowCount) {
      return res.status(404).json({ success: false, message: "No hay cuenta de pago activa para desactivar" });
    }

    return res.json({ success: true, message: "Cuenta de pago desactivada correctamente" });
  } catch (err) {
    console.error("[paymentAccounts] deactivate:", err.message);
    return res.status(500).json({ success: false, message: "Error al desactivar la cuenta de pago" });
  }
};