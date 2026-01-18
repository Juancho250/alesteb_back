// controllers/users.controller.js
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./db/database.sqlite');

exports.getUsers = (req, res) => {
  const sql = `
    SELECT u.id, u.email,
      GROUP_CONCAT(r.name) as roles
    FROM users u
    LEFT JOIN user_roles ur ON ur.user_id = u.id
    LEFT JOIN roles r ON r.id = ur.role_id
    GROUP BY u.id
  `;

  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ message: err.message });
    res.json(rows);
  });
};

exports.createUser = (req, res) => {
  const { email, password } = req.body;

  db.run(
    "INSERT INTO users(email, password) VALUES(?, ?)",
    [email, password],
    function(err) {
      if (err) return res.status(500).json({ message: err.message });
      res.status(201).json({ id: this.lastID, email });
    }
  );
};

exports.assignRole = (req, res) => {
  const { userId, roleId } = req.body;

  db.run(
    "INSERT INTO user_roles(user_id, role_id) VALUES(?, ?)",
    [userId, roleId],
    function(err) {
      if (err) return res.status(500).json({ message: err.message });
      res.json({ message: "Rol asignado correctamente" });
    }
  );
};
