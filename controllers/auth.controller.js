const db = require("../config/db");
const bcrypt = require('bcryptjs');
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { generateVerificationCode, sendVerificationEmail } = require("../config/emailConfig");

// ============================================
// 🔐 CONFIGURACIÓN DE SEGURIDAD
// ============================================

const SALT_ROUNDS = 12;
const JWT_ACCESS_EXPIRY = "15m";
const JWT_REFRESH_EXPIRY = "7d";
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_TIME = 15 * 60 * 1000;
const VERIFICATION_CODE_EXPIRY = 10 * 60 * 1000; // 10 minutos

const isValidEmail = (email) => {
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regex.test(email);
};

const isStrongPassword = (password) => {
  return password.length >= 8 && 
         /[A-Z]/.test(password) && 
         /[a-z]/.test(password) && 
         /[0-9]/.test(password);
};

// ============================================
// 🎫 GENERACIÓN DE TOKENS
// ============================================

const generateAccessToken = (payload) => {
  return jwt.sign(payload, process.env.JWT_SECRET, { 
    expiresIn: JWT_ACCESS_EXPIRY,
    issuer: 'alesteb-api',
    audience: 'alesteb-client'
  });
};

const generateRefreshToken = (payload) => {
  return jwt.sign(payload, process.env.JWT_REFRESH_SECRET, { 
    expiresIn: JWT_REFRESH_EXPIRY,
    issuer: 'alesteb-api',
    audience: 'alesteb-client'
  });
};

// ============================================
// 📊 OBTENCIÓN DE DATOS DE USUARIO
// ============================================

const getUserRoles = async (userId) => {
  const client = await db.connect();
  try {
    const rolesRes = await client.query(
      `SELECT r.name, r.id
       FROM roles r 
       JOIN user_roles ur ON ur.role_id = r.id 
       WHERE ur.user_id = $1`,
      [userId]
    );
    const roles = rolesRes.rows.map(r => r.name);
    const roleIds = rolesRes.rows.map(r => r.id);

    return { roles, roleIds };
  } finally {
    client.release();
  }
};

// ============================================
// 🔓 LOGIN
// ============================================

exports.login = async (req, res) => {
  const client = await db.connect();
  
  try {
    const { email, password, deviceInfo } = req.body;

    if (!email || !password) {
      return res.status(400).json({ 
        success: false,
        message: "Email y contraseña son requeridos" 
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ 
        success: false,
        message: "Formato de email inválido" 
      });
    }

    await client.query('BEGIN');

    const userRes = await client.query(
      `SELECT id, email, password, name, phone, cedula, city, address,
              failed_login_attempts, locked_until, is_active, is_verified
       FROM users 
       WHERE email = $1`,
      [email.toLowerCase().trim()]
    );

    if (userRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(401).json({ 
        success: false,
        message: "Credenciales inválidas" 
      });
    }

    const user = userRes.rows[0];

    // ✅ VERIFICAR QUE EL EMAIL ESTÉ VERIFICADO
    if (!user.is_verified) {
      await client.query('ROLLBACK');
      return res.status(403).json({ 
        success: false,
        message: "Debes verificar tu email antes de iniciar sesión",
        code: "EMAIL_NOT_VERIFIED"
      });
    }

    if (!user.is_active) {
      await client.query('ROLLBACK');
      return res.status(403).json({ 
        success: false,
        message: "Cuenta desactivada. Contacta al administrador" 
      });
    }

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      await client.query('ROLLBACK');
      const minutesLeft = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      return res.status(429).json({ 
        success: false,
        message: `Cuenta bloqueada temporalmente. Intenta en ${minutesLeft} minutos` 
      });
    }

    const isValidPassword = await bcrypt.compare(password, user.password);
    
    if (!isValidPassword) {
      const newAttempts = (user.failed_login_attempts || 0) + 1;
      
      if (newAttempts >= MAX_LOGIN_ATTEMPTS) {
        const lockUntil = new Date(Date.now() + LOCKOUT_TIME);
        await client.query(
          `UPDATE users 
           SET failed_login_attempts = $1, locked_until = $2 
           WHERE id = $3`,
          [newAttempts, lockUntil, user.id]
        );
        await client.query('COMMIT');
        
        return res.status(429).json({ 
          success: false,
          message: "Demasiados intentos fallidos. Cuenta bloqueada por 15 minutos" 
        });
      }
      
      await client.query(
        "UPDATE users SET failed_login_attempts = $1 WHERE id = $2",
        [newAttempts, user.id]
      );
      await client.query('COMMIT');
      
      return res.status(401).json({ 
        success: false,
        message: "Credenciales inválidas",
        attemptsLeft: MAX_LOGIN_ATTEMPTS - newAttempts
      });
    }

    await client.query(
      `UPDATE users 
       SET failed_login_attempts = 0, 
           locked_until = NULL,
           last_login = NOW() 
       WHERE id = $1`,
      [user.id]
    );

    const { roles } = await getUserRoles(user.id);

    const tokenPayload = { 
      id: user.id, 
      email: user.email,
      name: user.name,
      roles
    };

    const accessToken = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken({ id: user.id, email: user.email });

    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    await client.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, device_info, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '7 days')`,
      [user.id, tokenHash, deviceInfo || 'unknown']
    );

    await client.query('COMMIT');

    console.log(`[LOGIN SUCCESS] User ${user.email} (ID: ${user.id}) logged in`);

    // ✅ RESPUESTA ACTUALIZADA (compatible con frontend)
    res.json({
      success: true,
      message: "Login exitoso",
      user: {
        id: user.id,
        email: user.email,
        name: user.name || "Usuario",
        phone: user.phone,
        cedula: user.cedula,
        city: user.city,
        address: user.address,
        roles
      },
      token: accessToken, // ✅ Frontend espera "token"
      refreshToken
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("[LOGIN ERROR]", error);
    
    res.status(500).json({ 
      success: false,
      message: "Error en el servidor. Intenta nuevamente" 
    });
  } finally {
    client.release();
  }
};

// ============================================
// 📝 REGISTRO CON VERIFICACIÓN DE EMAIL
// ============================================

exports.register = async (req, res) => {
  const client = await db.connect();

  try {
    const { email, password, name, cedula, phone } = req.body;

    // ✅ Validaciones
    if (!email || !password || !name || !cedula) {
      return res.status(400).json({ 
        success: false,
        message: "Campos requeridos: email, password, name, cedula" 
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ 
        success: false,
        message: "Formato de email inválido" 
      });
    }

    if (!isStrongPassword(password)) {
      return res.status(400).json({ 
        success: false,
        message: "La contraseña debe tener mínimo 8 caracteres, incluyendo mayúsculas, minúsculas y números" 
      });
    }

    await client.query('BEGIN');

    // Verificar duplicados
    const existingEmail = await client.query(
      "SELECT id FROM users WHERE email = $1",
      [email.toLowerCase().trim()]
    );
    
    if (existingEmail.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ 
        success: false,
        message: "El email ya está registrado" 
      });
    }

    const existingCedula = await client.query(
      "SELECT id FROM users WHERE cedula = $1",
      [cedula.trim()]
    );
    
    if (existingCedula.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ 
        success: false,
        message: "La cédula ya está registrada" 
      });
    }

    // ✅ GENERAR CÓDIGO DE VERIFICACIÓN
    const verificationCode = generateVerificationCode();
    const codeExpiry = new Date(Date.now() + VERIFICATION_CODE_EXPIRY);

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    // ✅ Crear usuario NO VERIFICADO
    const userRes = await client.query(
      `INSERT INTO users (
        email, password, name, cedula, phone, 
        is_active, is_verified, 
        reset_token, reset_expires
      )
       VALUES ($1, $2, $3, $4, $5, true, false, $6, $7) 
       RETURNING id, email, name`,
      [
        email.toLowerCase().trim(), 
        hashedPassword, 
        name.trim(), 
        cedula.trim(), 
        phone?.trim() || null,
        verificationCode, // Usamos reset_token para guardar el código
        codeExpiry // Usamos reset_expires para la expiración
      ]
    );
    
    const newUser = userRes.rows[0];

    // ✅ Asignar rol de CLIENTE (ID 3) por defecto
    await client.query(
      "INSERT INTO user_roles (user_id, role_id) VALUES ($1, 3)",
      [newUser.id]
    );

    await client.query('COMMIT');

    // ✅ ENVIAR EMAIL DE VERIFICACIÓN
    try {
      await sendVerificationEmail(newUser.email, verificationCode, newUser.name);
      console.log(`[REGISTER SUCCESS] Verification email sent to ${newUser.email}`);
    } catch (emailError) {
      console.error('[EMAIL ERROR]', emailError);
      // No fallar el registro si el email no se envía
    }

    res.status(201).json({ 
      success: true,
      message: "Usuario registrado. Revisa tu email para verificar tu cuenta",
      data: {
        id: newUser.id,
        email: newUser.email,
        name: newUser.name,
        requiresVerification: true
      }
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("[REGISTER ERROR]", error);
    
    res.status(500).json({ 
      success: false,
      message: "Error al registrar usuario" 
    });
  } finally {
    client.release();
  }
};

// ============================================
// ✅ VERIFICAR CÓDIGO DE EMAIL
// ============================================

exports.verifyEmail = async (req, res) => {
  const client = await db.connect();

  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ 
        success: false,
        message: "Email y código son requeridos" 
      });
    }

    await client.query('BEGIN');

    // Buscar usuario con código válido
    const userRes = await client.query(
      `SELECT id, name, reset_token, reset_expires, is_verified
       FROM users 
       WHERE email = $1`,
      [email.toLowerCase().trim()]
    );

    if (userRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ 
        success: false,
        message: "Usuario no encontrado" 
      });
    }

    const user = userRes.rows[0];

    // Verificar si ya está verificado
    if (user.is_verified) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        success: false,
        message: "Email ya verificado. Puedes iniciar sesión" 
      });
    }

    // Verificar código
    if (user.reset_token !== code) {
      await client.query('ROLLBACK');
      return res.status(401).json({ 
        success: false,
        message: "Código de verificación inválido" 
      });
    }

    // Verificar expiración
    if (new Date() > new Date(user.reset_expires)) {
      await client.query('ROLLBACK');
      return res.status(401).json({ 
        success: false,
        message: "Código expirado. Solicita uno nuevo",
        code: "CODE_EXPIRED"
      });
    }

    // ✅ MARCAR COMO VERIFICADO
    await client.query(
      `UPDATE users 
       SET is_verified = true, 
           reset_token = NULL, 
           reset_expires = NULL 
       WHERE id = $1`,
      [user.id]
    );

    await client.query('COMMIT');

    console.log(`[EMAIL VERIFIED] User ${email} verified successfully`);

    res.json({ 
      success: true,
      message: "Email verificado correctamente. Ya puedes iniciar sesión" 
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("[VERIFY EMAIL ERROR]", error);
    
    res.status(500).json({ 
      success: false,
      message: "Error al verificar email" 
    });
  } finally {
    client.release();
  }
};

// ============================================
// 🔄 REENVIAR CÓDIGO DE VERIFICACIÓN
// ============================================

exports.resendVerificationCode = async (req, res) => {
  const client = await db.connect();

  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ 
        success: false,
        message: "Email es requerido" 
      });
    }

    await client.query('BEGIN');

    const userRes = await client.query(
      "SELECT id, name, is_verified FROM users WHERE email = $1",
      [email.toLowerCase().trim()]
    );

    if (userRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ 
        success: false,
        message: "Usuario no encontrado" 
      });
    }

    const user = userRes.rows[0];

    if (user.is_verified) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        success: false,
        message: "Email ya verificado" 
      });
    }

    // Generar nuevo código
    const verificationCode = generateVerificationCode();
    const codeExpiry = new Date(Date.now() + VERIFICATION_CODE_EXPIRY);

    await client.query(
      `UPDATE users 
       SET reset_token = $1, reset_expires = $2 
       WHERE id = $3`,
      [verificationCode, codeExpiry, user.id]
    );

    await client.query('COMMIT');

    // Enviar email
    await sendVerificationEmail(email, verificationCode, user.name);

    res.json({ 
      success: true,
      message: "Nuevo código enviado a tu email" 
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("[RESEND CODE ERROR]", error);
    
    res.status(500).json({ 
      success: false,
      message: "Error al reenviar código" 
    });
  } finally {
    client.release();
  }
};

// ============================================
// 🔄 REFRESH TOKEN
// ============================================

exports.refreshToken = async (req, res) => {
  const client = await db.connect();
  
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ 
        success: false,
        message: "Refresh token requerido" 
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET, {
        issuer: 'alesteb-api',
        audience: 'alesteb-client'
      });
    } catch (error) {
      return res.status(401).json({ 
        success: false,
        message: "Refresh token inválido o expirado" 
      });
    }

    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const tokenRes = await client.query(
      `SELECT id FROM refresh_tokens 
       WHERE user_id = $1 AND token_hash = $2 AND revoked = false AND expires_at > NOW()`,
      [decoded.id, tokenHash]
    );

    if (tokenRes.rowCount === 0) {
      return res.status(401).json({ 
        success: false,
        message: "Refresh token inválido o revocado" 
      });
    }

    const userRes = await client.query(
      "SELECT id, email, name, is_active FROM users WHERE id = $1",
      [decoded.id]
    );

    if (userRes.rowCount === 0 || !userRes.rows[0].is_active) {
      return res.status(401).json({ 
        success: false,
        message: "Usuario no encontrado o inactivo" 
      });
    }

    const user = userRes.rows[0];
    const { roles } = await getUserRoles(user.id);

    const newAccessToken = generateAccessToken({ 
      id: user.id, 
      email: user.email,
      name: user.name,
      roles
    });

    res.json({
      success: true,
      data: {
        accessToken: newAccessToken
      }
    });

  } catch (error) {
    console.error("[REFRESH TOKEN ERROR]", error);
    res.status(500).json({ 
      success: false,
      message: "Error en el servidor" 
    });
  } finally {
    client.release();
  }
};

// ============================================
// 🚪 LOGOUT
// ============================================

exports.logout = async (req, res) => {
  const client = await db.connect();
  
  try {
    const { refreshToken } = req.body;
    const userId = req.user?.id;

    if (refreshToken) {
      const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
      
      await client.query(
        `UPDATE refresh_tokens 
         SET revoked = true, revoked_at = NOW() 
         WHERE token_hash = $1`,
        [tokenHash]
      );
    }

    if (userId) {
      await client.query(
        `UPDATE refresh_tokens 
         SET revoked = true, revoked_at = NOW() 
         WHERE user_id = $1 AND revoked = false`,
        [userId]
      );
    }

    res.json({
      success: true,
      message: "Logout exitoso"
    });

  } catch (error) {
    console.error("[LOGOUT ERROR]", error);
    res.status(500).json({ 
      success: false,
      message: "Error al cerrar sesión" 
    });
  } finally {
    client.release();
  }
};

// ============================================
// 👤 OBTENER PERFIL ACTUAL
// ============================================

exports.getProfile = async (req, res) => {
  try {
    const userId = req.user.id;

    const userRes = await db.query(
      `SELECT id, email, name, phone, cedula, city, address, created_at, last_login
       FROM users WHERE id = $1`,
      [userId]
    );

    if (userRes.rowCount === 0) {
      return res.status(404).json({ 
        success: false,
        message: "Usuario no encontrado" 
      });
    }

    const user = userRes.rows[0];
    const { roles } = await getUserRoles(userId);

    res.json({
      success: true,
      data: { ...user, roles }
    });

  } catch (error) {
    console.error("[GET PROFILE ERROR]", error);
    res.status(500).json({ 
      success: false,
      message: "Error al obtener perfil" 
    });
  }
};

// ============================================
// ✏️ ACTUALIZAR PERFIL PROPIO
// ============================================

exports.updateProfile = async (req, res) => {
  const client = await db.connect();
  try {
    const userId = req.user.id;
    const { name, phone, city, address } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ success: false, message: "El nombre es requerido" });
    }

    await client.query(
      `UPDATE users 
       SET name = $1, phone = $2, city = $3, address = $4, updated_at = NOW()
       WHERE id = $5`,
      [name.trim(), phone?.trim() || null, city?.trim() || null, address?.trim() || null, userId]
    );

    const updated = await client.query(
      `SELECT id, email, name, phone, cedula, city, address FROM users WHERE id = $1`,
      [userId]
    );

    res.json({ 
      success: true, 
      message: "Perfil actualizado correctamente", 
      data: updated.rows[0] 
    });

  } catch (error) {
    console.error("[UPDATE PROFILE ERROR]", error);
    res.status(500).json({ success: false, message: "Error al actualizar perfil" });
  } finally {
    client.release();
  }
};