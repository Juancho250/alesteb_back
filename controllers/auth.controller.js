const db = require("../config/db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { Resend } = require('resend');
const { logSecurityEvent } = require('../middleware/auth.middleware');

const resend = new Resend(process.env.RESEND_API_KEY);

if (!process.env.RESEND_API_KEY) {
  console.error("CRÍTICO: Falta RESEND_API_KEY en el .env");
}

// ===============================
// UTILIDADES
// ===============================

const generateVerificationCode = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

const sanitizeUserResponse = (user) => {
  const { password, verification_code, ...safeUser } = user;
  return safeUser;
};

// ===============================
// LOGIN
// ===============================

exports.login = async (req, res) => {
  const { email, password } = req.body;
  
  try {
    const userRes = await db.query(
      `SELECT u.id, u.name, u.email, u.password, u.is_verified, r.name as role 
       FROM users u
       JOIN user_roles ur ON u.id = ur.user_id
       JOIN roles r ON ur.role_id = r.id
       WHERE u.email = $1`,
      [email]
    );

    // Log intento de login fallido
    if (userRes.rowCount === 0) {
      await logSecurityEvent({
        type: 'failed_login_attempt',
        email,
        ip: req.ip,
        reason: 'user_not_found'
      });
      
      return res.status(401).json({ message: "Credenciales inválidas" });
    }

    const user = userRes.rows[0];

    // Verificar que el usuario esté verificado
    if (!user.is_verified) {
      await logSecurityEvent({
        type: 'login_unverified_user',
        userId: user.id,
        email: user.email,
        ip: req.ip
      });
      
      return res.status(403).json({ 
        message: "Por favor, verifica tu correo antes de iniciar sesión." 
      });
    }

    // Verificar contraseña
    const passwordMatch = await bcrypt.compare(password, user.password);
    
    if (!passwordMatch) {
      await logSecurityEvent({
        type: 'failed_login_attempt',
        userId: user.id,
        email: user.email,
        ip: req.ip,
        reason: 'invalid_password'
      });
      
      return res.status(401).json({ message: "Credenciales inválidas" });
    }

    // Login exitoso - generar token
    const token = jwt.sign(
      { id: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );

    // Log login exitoso
    await logSecurityEvent({
      type: 'successful_login',
      userId: user.id,
      email: user.email,
      ip: req.ip,
      userAgent: req.get('user-agent')
    });

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    console.error("LOGIN ERROR:", {
      message: error.message,
      email: email,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
    
    res.status(500).json({ message: "Error en el login" });
  }
};

// ===============================
// REGISTER
// ===============================

exports.register = async (req, res) => {
  const { name, email, password, phone } = req.body;
  const client = await db.connect();
  
  try {
    await client.query('BEGIN');

    // 1. Verificar si el usuario ya existe
    const existing = await client.query(
      "SELECT id, email FROM users WHERE email = $1",
      [email]
    );

    if (existing.rowCount > 0) {
      await client.query('ROLLBACK');
      
      // Log intento de registro duplicado
      await logSecurityEvent({
        type: 'duplicate_registration_attempt',
        email,
        ip: req.ip
      });
      
      return res.status(400).json({ message: "El correo ya existe" });
    }

    // 2. Generar código de verificación
    const verificationCode = generateVerificationCode();
    
    // 3. Hashear contraseña con salt rounds configurables
    const saltRounds = parseInt(process.env.BCRYPT_ROUNDS) || 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // 4. Insertar usuario
    const userRes = await client.query(
      `INSERT INTO users (name, email, password, phone, verification_code, is_verified) 
       VALUES ($1, $2, $3, $4, $5, false) 
       RETURNING id, name, email`,
      [name, email, hashedPassword, phone || null, verificationCode]
    );

    const newUser = userRes.rows[0];

    // 5. Asignar rol de Customer (3)
    await client.query(
      "INSERT INTO user_roles (user_id, role_id) VALUES ($1, 3)",
      [newUser.id]
    );

    // 6. Enviar correo de verificación
    try {
      await resend.emails.send({
        from: process.env.RESEND_FROM || 'Alesteb System <onboarding@resend.dev>',
        to: [email],
        subject: 'Tu Código de Verificación - Alesteb',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center;">
              <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 600;">Bienvenido a Alesteb</h1>
            </div>
            
            <div style="padding: 40px 30px;">
              <h2 style="color: #333; margin: 0 0 20px 0; font-size: 24px;">¡Hola ${name}! 👋</h2>
              
              <p style="color: #666; font-size: 16px; line-height: 1.6; margin: 0 0 20px 0;">
                Gracias por registrarte. Para activar tu cuenta, usa el siguiente código de verificación:
              </p>
              
              <div style="background: #f8f9fa; border-left: 4px solid #667eea; padding: 20px; margin: 30px 0; border-radius: 4px;">
                <div style="text-align: center; font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #667eea; font-family: 'Courier New', monospace;">
                  ${verificationCode}
                </div>
              </div>
              
              <p style="color: #666; font-size: 14px; line-height: 1.6; margin: 20px 0 0 0;">
                <strong>Este código expira en 15 minutos.</strong><br>
                Si no solicitaste este registro, puedes ignorar este correo de forma segura.
              </p>
            </div>
            
            <div style="background: #f8f9fa; padding: 20px 30px; border-top: 1px solid #e0e0e0;">
              <p style="color: #999; font-size: 12px; margin: 0; text-align: center;">
                © ${new Date().getFullYear()} Alesteb. Todos los derechos reservados.
              </p>
            </div>
          </div>`
      });
    } catch (mailError) {
      console.error("RESEND ERROR:", {
        message: mailError.message,
        userId: newUser.id,
        email: email
      });
      
      // Rollback si el email falla (opcional - puedes comentar esto si prefieres que continúe)
      await client.query('ROLLBACK');
      return res.status(500).json({ 
        message: "Error al enviar el correo de verificación. Intenta nuevamente." 
      });
    }

    await client.query('COMMIT');

    // Log registro exitoso
    await logSecurityEvent({
      type: 'successful_registration',
      userId: newUser.id,
      email: email,
      ip: req.ip
    });

    res.status(201).json({
      message: "Código enviado con éxito",
      email: email
    });

  } catch (error) {
    await client.query('ROLLBACK');
    
    console.error("REGISTER ERROR:", {
      message: error.message,
      email: email,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
    
    res.status(500).json({ message: "Error interno en el servidor" });
  } finally {
    client.release();
  }
};

// ===============================
// VERIFY CODE
// ===============================

exports.verifyCode = async (req, res) => {
  const { email, code } = req.body;
  
  try {
    const result = await db.query(
      `UPDATE users 
       SET is_verified = true, 
           verification_code = NULL,
           email_verified_at = CURRENT_TIMESTAMP
       WHERE email = $1 
         AND verification_code = $2 
         AND is_verified = false
       RETURNING id, name, email`,
      [email, code]
    );

    if (result.rowCount === 0) {
      // Log intento fallido de verificación
      await logSecurityEvent({
        type: 'failed_verification_attempt',
        email,
        code: code.substring(0, 2) + '****', // Log parcial del código por seguridad
        ip: req.ip
      });
      
      return res.status(400).json({ 
        message: "Código incorrecto o cuenta ya verificada" 
      });
    }

    const user = result.rows[0];

    // Log verificación exitosa
    await logSecurityEvent({
      type: 'successful_verification',
      userId: user.id,
      email: user.email,
      ip: req.ip
    });

    res.json({ 
      message: "Cuenta verificada con éxito",
      user: {
        id: user.id,
        name: user.name,
        email: user.email
      }
    });
  } catch (error) {
    console.error("VERIFY CODE ERROR:", {
      message: error.message,
      email: email,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
    
    res.status(500).json({ message: "Error en verificación" });
  }
};

// ===============================
// RESEND VERIFICATION CODE (Nuevo endpoint opcional)
// ===============================

exports.resendCode = async (req, res) => {
  const { email } = req.body;
  
  try {
    // Verificar que el usuario existe y no está verificado
    const userRes = await db.query(
      "SELECT id, name, email, is_verified FROM users WHERE email = $1",
      [email]
    );

    if (userRes.rowCount === 0) {
      return res.status(404).json({ message: "Usuario no encontrado" });
    }

    const user = userRes.rows[0];

    if (user.is_verified) {
      return res.status(400).json({ message: "La cuenta ya está verificada" });
    }

    // Generar nuevo código
    const newCode = generateVerificationCode();

    // Actualizar código en la base de datos
    await db.query(
      "UPDATE users SET verification_code = $1 WHERE id = $2",
      [newCode, user.id]
    );

    // Enviar correo
    try {
      await resend.emails.send({
        from: process.env.RESEND_FROM || 'Alesteb System <onboarding@resend.dev>',
        to: [email],
        subject: 'Nuevo Código de Verificación - Alesteb',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
            <h2 style="color: #333;">Hola ${user.name},</h2>
            <p style="color: #666; font-size: 16px; line-height: 1.6;">
              Solicitaste un nuevo código de verificación. Aquí está:
            </p>
            <div style="background: #f4f4f4; padding: 20px; text-align: center; font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #667eea; border-radius: 8px; margin: 30px 0;">
              ${newCode}
            </div>
            <p style="color: #999; font-size: 14px;">
              Este código expira en 15 minutos.
            </p>
          </div>`
      });
    } catch (mailError) {
      console.error("RESEND CODE EMAIL ERROR:", mailError);
      return res.status(500).json({ message: "Error al enviar el correo" });
    }

    // Log reenvío de código
    await logSecurityEvent({
      type: 'verification_code_resent',
      userId: user.id,
      email: email,
      ip: req.ip
    });

    res.json({ message: "Código reenviado con éxito" });

  } catch (error) {
    console.error("RESEND CODE ERROR:", {
      message: error.message,
      email: email
    });
    
    res.status(500).json({ message: "Error al reenviar código" });
  }
};