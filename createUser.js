const bcrypt = require("bcrypt");
const pool = require("./config/db"); // pg pool

async function createAdmin() {
  const email = "admin@alesteb.com";
  const password = "alesteb2026";
  const name = "Admin Alesteb";

  const hash = await bcrypt.hash(password, 10);

  const userRes = await pool.query(
    `INSERT INTO users (email, password, name)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [email, hash, name]
  );

  const userId = userRes.rows[0].id;

  console.log("✅ Usuario creado con ID:", userId);

  // PASO 3 ABAJO 👇
  const roleRes = await pool.query(
  "SELECT id FROM roles WHERE name = 'admin'"
);

const roleId = roleRes.rows[0].id;

await pool.query(
  `INSERT INTO user_roles (user_id, role_id)
   VALUES ($1, $2)`,
  [userId, roleId]
);

console.log("👑 Rol ADMIN asignado correctamente");

}

createAdmin();
