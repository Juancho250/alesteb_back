const db = require("../config/db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

// 1. LOGIN con protección de verificación
exports.login = async (req, res) => {
  const { email, password } = req.body;
  try {
    const userRes = await db.query(
      `SELECT u.id, u.email, u.password, u.is_verified, r.name as role 
       FROM users u
       JOIN user_roles ur ON u.id = ur.user_id
       JOIN roles r ON ur.role_id = r.id
       WHERE u.email = $1`,
      [email]
    );

    if (userRes.rowCount === 0) return res.status(401).json({ message: "Credenciales inválidas" });

    const user = userRes.rows[0];

    // BLOQUEO: Si no está verificado, no entra
    if (!user.is_verified) {
      return res.status(403).json({ message: "Por favor, verifica tu correo antes de iniciar sesión." });
    }

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

// 2. REGISTER (Asigna Rol 3 - Customer automáticamente)
// 2. REGISTER (Ajustado con Teléfono)
exports.register = async (req, res) => {
  // Añadimos 'phone' a la petición
  const { name, email, password, phone } = req.body; 
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.rowCount > 0) return res.status(400).json({ message: "El correo ya existe" });

    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insertamos incluyendo el campo 'phone'
    const userRes = await client.query(
      `INSERT INTO users (name, email, password, phone, verification_code, is_verified) 
       VALUES ($1, $2, $3, $4, $5, false) RETURNING id`,
      [name, email, hashedPassword, phone, verificationCode]
    );
    
    await client.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, 3)", [userRes.rows[0].id]);

    await resend.emails.send({
      from: 'ALESTEB <onboarding@resend.dev>',
      to: [email],
      subject: 'Tu Código de Verificación',
      html: `
        <div style="font-family: sans-serif; max-width: 400px; margin: auto; border: 1px solid #eee; padding: 20px; border-radius: 10px;">
          <h2 style="color: #333;">Verificación de Cuenta</h2>
          <p>Hola <strong>${name}</strong>, usa el siguiente código para activar tu cuenta en Alesteb System:</p>
          <div style="background: #f4f4f4; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #0071e3;">
            ${verificationCode}
          </div>
        </div>`
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
// 3. VERIFY CODE
exports.verifyCode = async (req, res) => {
  const { email, code } = req.body;
  try {
    const result = await db.query(
      "UPDATE users SET is_verified = true, verification_code = NULL WHERE email = $1 AND verification_code = $2 RETURNING id",
      [email, code]
    );
    if (result.rowCount === 0) return res.status(400).json({ message: "Código incorrecto o cuenta ya verificada" });
    res.json({ message: "Cuenta verificada con éxito" });
  } catch (error) {
    res.status(500).json({ message: "Error en verificación" });
  }
};