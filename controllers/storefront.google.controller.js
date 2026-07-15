const db     = require("../config/db");
const jwt    = require("jsonwebtoken");
const crypto = require("crypto");

const JWT_ACCESS_EXPIRY  = "15m";
const JWT_REFRESH_EXPIRY = "7d";

const generateAccessToken  = (payload) =>
  jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: JWT_ACCESS_EXPIRY, issuer: "alesteb-api", audience: "alesteb-client",
  });

const generateRefreshToken = (payload) =>
  jwt.sign(payload, process.env.JWT_REFRESH_SECRET, {
    expiresIn: JWT_REFRESH_EXPIRY, issuer: "alesteb-api", audience: "alesteb-client",
  });

/**
 * POST /public-api/v1/auth/google
 * Body: { token: <access_token de Google> }
 *
 * Verifica el access_token con Google, busca o crea el usuario,
 * y devuelve los mismos tokens que el login normal.
 */
exports.googleAuth = async (req, res) => {
  const client = await db.connect();
  try {
    const { token: googleAccessToken, deviceInfo } = req.body;

    if (!googleAccessToken) {
      return res.status(400).json({
        success: false,
        message: "Token de Google requerido",
        code: "MISSING_TOKEN",
      });
    }

    // 1. Verificar el access_token con Google y obtener el perfil
    const googleRes = await fetch(
      `https://www.googleapis.com/oauth2/v3/userinfo`,
      { headers: { Authorization: `Bearer ${googleAccessToken}` } }
    );

    if (!googleRes.ok) {
      return res.status(401).json({
        success: false,
        message: "Token de Google inválido o expirado",
        code: "INVALID_GOOGLE_TOKEN",
      });
    }

    const googleUser = await googleRes.json();
    // googleUser = { sub, email, name, picture, email_verified, ... }

    if (!googleUser.email || !googleUser.email_verified) {
      return res.status(401).json({
        success: false,
        message: "No se pudo verificar el email de Google",
        code: "EMAIL_NOT_VERIFIED",
      });
    }

    const adminId = req.apiKey.adminId;
    const email   = googleUser.email.toLowerCase().trim();

    await client.query("BEGIN");

    // 2. Buscar usuario existente (scoped al admin de esta API key)
    let userRes = await client.query(
      `SELECT u.id, u.email, u.name, u.phone, u.cedula, u.city, u.address, u.is_active
       FROM users u
       WHERE u.email = $1
         AND u.owner_admin_id = $2`,
      [email, adminId]
    );

    let user;

    if (userRes.rowCount > 0) {
      // Usuario existente — verificar que esté activo
      user = userRes.rows[0];

      if (!user.is_active) {
        await client.query("ROLLBACK");
        return res.status(403).json({
          success: false,
          message: "Cuenta desactivada. Contacta al administrador.",
          code: "USER_INACTIVE",
        });
      }

      // Actualizar nombre si Google tiene uno mejor
      if (googleUser.name && !user.name) {
        await client.query(
          "UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2",
          [googleUser.name, user.id]
        );
        user.name = googleUser.name;
      }

    } else {
      // 3. Crear usuario nuevo (sin contraseña, sin cédula)
      //    La cédula es requerida en el schema como NOT NULL — usamos el sub de Google como fallback temporal.
      //    El admin puede completar la cédula luego desde su panel.
      const roleRes = await client.query(
        "SELECT id FROM roles WHERE name = 'user' LIMIT 1"
      );
      if (roleRes.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(500).json({
          success: false,
          message: "Configuración incompleta en el servidor",
          code: "ROLE_NOT_FOUND",
        });
      }

      // Contraseña aleatoria (el usuario nunca la usará — solo entra por Google)
      const randomPassword = crypto.randomBytes(32).toString("hex");
      const bcrypt = require("bcryptjs");
      const hashedPassword = await bcrypt.hash(randomPassword, 10);

    const cedulaPlaceholder = `G${googleUser.sub.slice(-19)}`;

      const newUserRes = await client.query(
        `INSERT INTO users
           (email, password, name, cedula, is_active, is_verified, owner_admin_id)
         VALUES ($1, $2, $3, $4, true, true, $5)
         RETURNING id, email, name, phone, cedula, city, address`,
        [email, hashedPassword, googleUser.name || email, cedulaPlaceholder, adminId]
      );

      user = newUserRes.rows[0];

      await client.query(
        "INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [user.id, roleRes.rows[0].id]
      );

      console.log(`[GOOGLE AUTH] Usuario creado: ${email} (admin: ${adminId})`);
    }

    // 4. Generar tokens
    const tokenPayload = {
      id:    user.id,
      email: user.email,
      name:  user.name,
      roles: ["user"],
    };

    const accessToken  = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken({ id: user.id, email: user.email });

    // 5. Guardar refresh token
    const tokenHash = crypto.createHash("sha256").update(refreshToken).digest("hex");
    await client.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, device_info, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '7 days')
       ON CONFLICT DO NOTHING`,
      [user.id, tokenHash, deviceInfo || "google-oauth"]
    );

    await client.query("COMMIT");

    console.log(`[GOOGLE AUTH] Login exitoso: ${email}`);

    return res.json({
      success: true,
      message: "Login con Google exitoso",
      user: {
        id:      user.id,
        email:   user.email,
        name:    user.name,
        phone:   user.phone,
        cedula:  user.cedula,
        city:    user.city,
        address: user.address,
        roles:   ["user"],
      },
      token:        accessToken,
      refreshToken,
    });

  } catch (error) {
    await client.query("ROLLBACK");

    // Cédula duplicada (el sub de Google ya existe de otro admin o colisión)
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "Ya existe una cuenta con este email en otro contexto. Contacta al administrador.",
        code: "DUPLICATE_ENTRY",
      });
    }

    console.error("[GOOGLE AUTH ERROR]", error);
    return res.status(500).json({
      success: false,
      message: "Error al autenticar con Google",
      code: "SERVER_ERROR",
    });
  } finally {
    client.release();
  }
};