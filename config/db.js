const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");

const dbPath = path.resolve(__dirname, "../db/database.sqlite");
const initPath = path.resolve(__dirname, "../db/init.sql");

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error("❌ Error DB:", err.message);
    return;
  }

  console.log("🟢 SQLite conectado");

  // Ejecutar init.sql automáticamente
  const initSql = fs.readFileSync(initPath, "utf8");
  db.exec(initSql, (err) => {
    if (err) {
      console.error("❌ Error init.sql:", err.message);
    } else {
      console.log("🧱 Tablas verificadas");
    }
  });
});

module.exports = db;
