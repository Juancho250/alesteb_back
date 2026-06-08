// controllers/financePin.controller.js
const bcrypt = require("bcryptjs");
const pool   = require("../config/db"); // ajusta si tu conexión se llama diferente

// ─── GET /api/finance-pin/status ─────────────────────────────────────────────
// Devuelve si el admin tiene PIN configurado (true/false)
const getStatus = async (req, res) => {
  try {
    const adminId = req.user.id;

    const { rows } = await pool.query(
      "SELECT finance_pin_hash IS NOT NULL AS has_pin FROM admin_profiles WHERE user_id = $1",
      [adminId]
    );

    return res.json({ hasPin: rows[0]?.has_pin ?? false });
  } catch (err) {
    console.error("[financePin.getStatus]", err);
    return res.status(500).json({ error: "Error interno del servidor." });
  }
};

// ─── POST /api/finance-pin/set ────────────────────────────────────────────────
// Crea o cambia el PIN. Si ya existe uno, exige el PIN actual.
// Body: { newPin: "1234", currentPin?: "0000" }
const setPin = async (req, res) => {
  try {
    const adminId = req.user.id;
    const { newPin, currentPin } = req.body;

    // Validar formato
    if (!newPin || !/^\d{4,6}$/.test(String(newPin))) {
      return res.status(400).json({ error: "El PIN debe tener entre 4 y 6 dígitos numéricos." });
    }

    // Obtener hash actual
    const { rows } = await pool.query(
      "SELECT finance_pin_hash FROM admin_profiles WHERE user_id = $1",
      [adminId]
    );

    const profile = rows[0];

    // Si ya tiene PIN, verificar el actual antes de cambiar
    if (profile?.finance_pin_hash) {
      if (!currentPin) {
        return res.status(400).json({ error: "Debes ingresar el PIN actual para cambiarlo." });
      }
      const valid = await bcrypt.compare(String(currentPin), profile.finance_pin_hash);
      if (!valid) {
        return res.status(401).json({ error: "PIN actual incorrecto." });
      }
    }

    // Hashear y guardar (UPSERT: crea la fila si no existe)
    const hash = await bcrypt.hash(String(newPin), 10);

    await pool.query(
      `INSERT INTO admin_profiles (user_id, finance_pin_hash, updated_at)
       VALUES ($2, $1, NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET finance_pin_hash = EXCLUDED.finance_pin_hash,
             updated_at       = NOW()`,
      [hash, adminId]
    );

    return res.json({ success: true, message: "PIN configurado correctamente." });
  } catch (err) {
    console.error("[financePin.setPin]", err);
    return res.status(500).json({ error: "Error interno del servidor." });
  }
};

// ─── POST /api/finance-pin/verify ────────────────────────────────────────────
// Verifica el PIN ingresado por el admin.
// Body: { pin: "1234" }
const verifyPin = async (req, res) => {
  try {
    const adminId = req.user.id;
    const { pin } = req.body;

    if (!pin) {
      return res.status(400).json({ error: "PIN requerido." });
    }

    const { rows } = await pool.query(
      "SELECT finance_pin_hash FROM admin_profiles WHERE user_id = $1",
      [adminId]
    );

    const profile = rows[0];

    if (!profile?.finance_pin_hash) {
      return res.json({ valid: true, noPinConfigured: true });
    }

    const valid = await bcrypt.compare(String(pin), profile.finance_pin_hash);

    return res.json({ valid });
  } catch (err) {
    console.error("[financePin.verifyPin]", err);
    return res.status(500).json({ error: "Error interno del servidor." });
  }
};

module.exports = { getStatus, setPin, verifyPin };