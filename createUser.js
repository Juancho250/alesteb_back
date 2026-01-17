const db = require("./config/db");
const bcrypt = require("bcrypt");

async function createUser() {
  const email = "admin@alesteb.com";
  const password = "alesteb2026";
  const role = "admin";

  const hash = await bcrypt.hash(password, 10);

  db.run(
    "INSERT INTO users (email, password, role) VALUES (?, ?, ?)",
    [email, hash, role],
    (err) => {
      if (err) {
        console.error("❌ Error:", err.message);
      } else {
        console.log("✅ Usuario admin creado");
        console.log("📧 Email:", email);
        console.log("🔑 Password:", password);
      }
    }
  );
}

createUser();
