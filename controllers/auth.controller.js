// controllers/auth.controller.js
const db = require("../config/db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

// 1. LOGIN (Faltaba exportar esta función en tu último código)
exports.login = async (req, res) => {
  const { email, password } = req.body;
  try {
    const userRes = await db.query(
      `SELECT u.id, u.email, u.password, r.name as role 
       FROM users u
       JOIN user_roles ur ON u.id = ur.user_id
       JOIN roles r ON ur.role_id = r.id
       WHERE u.email = $1`,
      [email]
    );

    if (userRes.rowCount === 0) return res.status(401).json({ message: "Credenciales inválidas" });

    const user = userRes.rows[0];
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ message: "Credenciales inválidas" });

    const token = jwt.sign(
      { id: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );

    res.json({
      token,
      user: { id: user.id, email: user.email, role: user.role }
    });
  } catch (error) {
    res.status(500).json({ message: "Error en el login" });
  }
};

// 2. REGISTER
exports.register = async (req, res) => {
  const { name, email, password } = req.body;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.rowCount > 0) return res.status(400).json({ message: "El correo ya existe" });

    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
    const hashedPassword = await bcrypt.hash(password, 10);

    const userRes = await client.query(
      `INSERT INTO users (name, email, password, verification_code, is_verified) 
       VALUES ($1, $2, $3, $4, false) RETURNING id`,
      [name, email, hashedPassword, verificationCode]
    );
    
    await client.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, 3)", [userRes.rows[0].id]);

    await resend.emails.send({
      from: 'ALESTEB <onboarding@resend.dev>',
      to: [email],
      subject: 'Código de Verificación',
      html: `<h1>${verificationCode}</h1>`
    });

    await client.query('COMMIT');
    res.status(201).json({ message: "Código enviado", email });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: "Error en registro" });
  } finally {
    client.release();
  }
};

// 3. VERIFY
exports.verifyCode = async (req, res) => {
  const { email, code } = req.body;
  try {
    const result = await db.query(
      "UPDATE users SET is_verified = true, verification_code = NULL WHERE email = $1 AND verification_code = $2 RETURNING id",
      [email, code]
    );
    if (result.rowCount === 0) return res.status(400).json({ message: "Código incorrecto" });
    res.json({ message: "Verificado" });
  } catch (error) {
    res.status(500).json({ message: "Error" });
  }
};