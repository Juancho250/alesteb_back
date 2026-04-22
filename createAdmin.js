const bcrypt = require('bcryptjs');
const pool = require("./config/db");

async function createAdmin() {
  const email    = "admin@alesteb.com";
  const password = "alesteb2026";
  const name     = "Admin Alesteb";

  try {
    // 1. Hashear contraseña
    const hash = await bcrypt.hash(password, 10);

    // 2. Insertar usuario con is_verified = true e is_active = true
    //    Si el email ya existe, actualiza en lugar de fallar
    const userRes = await pool.query(
      `INSERT INTO users (email, password, cedula, name, is_verified, is_active)
       VALUES ($1, $2, $3, $4, true, true)
       ON CONFLICT (email) DO UPDATE
         SET password    = EXCLUDED.password,
             is_verified = true,
             is_active   = true
       RETURNING id, email, is_verified, is_active`,
      [email, hash, "00000000", name]
    );

    const user = userRes.rows[0];
    console.log("✅ Usuario listo:", user);

    // 3. Buscar rol admin
    const roleRes = await pool.query(
      "SELECT id FROM roles WHERE name = 'admin' LIMIT 1"
    );

    if (roleRes.rowCount === 0) {
      console.error("❌ El rol 'admin' no existe en la tabla roles. Ejecuta tus migraciones primero.");
      process.exit(1);
    }

    const roleId = roleRes.rows[0].id;

    // 4. Asignar rol (sin fallar si ya lo tiene)
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, role_id) DO NOTHING`,
      [user.id, roleId]
    );

    console.log("👑 Rol ADMIN asignado correctamente");
    console.log("🚀 Ya puedes iniciar sesión con:");
    console.log("   Email:    ", email);
    console.log("   Password: ", password);

  } catch (err) {
    console.error("❌ Error:", err.message);
  } finally {
    await pool.end();
  }
}

createAdmin();