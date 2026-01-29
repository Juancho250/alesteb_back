const db = require("../config/db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

if (!process.env.RESEND_API_KEY) {
    console.error("CRÍTICO: Faltan la RESEND_API_KEY en el .env");
}

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

// Asegúrate de que esta variable esté en tu archivo .env


exports.register = async (req, res) => {
  const { name, email, password, phone } = req.body; 
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    
    // 1. Verificar si el usuario ya existe
    const existing = await client.query("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.rowCount > 0) {
      return res.status(400).json({ message: "El correo ya existe" });
    }

    // 2. Generar código y Hashear password
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
    const hashedPassword = await bcrypt.hash(password, 10);

    // 3. Insertar usuario
    const userRes = await client.query(
      `INSERT INTO users (name, email, password, phone, verification_code, is_verified) 
       VALUES ($1, $2, $3, $4, $5, false) RETURNING id`,
      [name, email, hashedPassword, phone, verificationCode]
    );
    
    // 4. Asignar rol (3 = Customer)
    await client.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, 3)", [userRes.rows[0].id]);

    // 5. ENVIAR CORREO (Punto crítico)
    try {
      await resend.emails.send({
        from: 'Alesteb System <onboarding@resend.dev>', // No cambies esto si no tienes dominio verificado
        to: [email],
        subject: 'Tu Código de Verificación',
        html: `
          <div style="font-family: sans-serif; max-width: 400px; margin: auto; border: 1px solid #eee; padding: 20px; border-radius: 10px;">
            <h2 style="color: #333; text-align: center;">Verificación de Cuenta</h2>
            <p>Hola <strong>${name}</strong>,</p>
            <p>Usa el siguiente código para activar tu cuenta:</p>
            <div style="background: #f4f4f4; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #0071e3; border-radius: 8px;">
              ${verificationCode}
            </div>
            <p style="font-size: 12px; color: #777; margin-top: 20px;">Si no solicitaste este código, puedes ignorar este correo.</p>
          </div>`
      });
    } catch (mailError) {
      console.error("ERROR EN RESEND:", mailError);
      // Opcional: podrías lanzar un error aquí si quieres que el registro falle si el mail no sale
    }

    await client.query('COMMIT');
    res.status(201).json({ message: "Código enviado con éxito", email });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("ERROR EN REGISTRO:", error);
    res.status(500).json({ message: "Error interno en el servidor" });
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