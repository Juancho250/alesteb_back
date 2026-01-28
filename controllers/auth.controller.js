// controllers/auth.controller.js
const db = require("../config/db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

exports.register = async (req, res) => {
  const { name, email, password } = req.body;
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // 1. Verificar si el usuario ya existe
    const existing = await client.query("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.rowCount > 0) {
      return res.status(400).json({ message: "El correo ya está registrado" });
    }

    // 2. Crear código de verificación (6 dígitos)
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
    const hashedPassword = await bcrypt.hash(password, 10);

    // 3. Insertar usuario (Inactivo hasta verificar)
    const userRes = await client.query(
      `INSERT INTO users (name, email, password, verification_code, is_verified) 
       VALUES ($1, $2, $3, $4, false) RETURNING id`,
      [name, email, hashedPassword, verificationCode]
    );
    const userId = userRes.rows[0].id;

    // 4. Asignar ROL CUSTOMER (ID 3)
    await client.query(
      "INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)",
      [userId, 3] // ID 3 según tu tabla de roles
    );

    // 5. Enviar Correo con Resend
    await resend.emails.send({
      from: 'ALESTEB <onboarding@resend.dev>',
      to: [email],
      subject: 'Código de Verificación - ALESTEB',
      html: `<div style="font-family:sans-serif; text-align:center;">
              <h1>Hola, ${name}</h1>
              <p>Tu código de seguridad es:</p>
              <h2 style="color:#2563eb; font-size:32px;">${verificationCode}</h2>
            </div>`
    });

    await client.query('COMMIT');
    res.status(201).json({ message: "Código enviado al correo", email });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("REGISTER ERROR:", error);
    res.status(500).json({ message: "Error al registrarse" });
  } finally {
    client.release();
  }
};

// Nueva función para verificar el código
exports.verifyCode = async (req, res) => {
  const { email, code } = req.body;
  try {
    const result = await db.query(
      "UPDATE users SET is_verified = true, verification_code = NULL WHERE email = $1 AND verification_code = $2 RETURNING id",
      [email, code]
    );

    if (result.rowCount === 0) {
      return res.status(400).json({ message: "Código incorrecto o expirado" });
    }

    res.json({ message: "Cuenta verificada con éxito. Ya puedes iniciar sesión." });
  } catch (error) {
    res.status(500).json({ message: "Error en verificación" });
  }
};