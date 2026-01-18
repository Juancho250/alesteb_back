// controllers/roles.controller.js
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./db/database.sqlite');

exports.getRoles = (req, res) => {
  db.all("SELECT * FROM roles", [], (err, rows) => {
    if (err) return res.status(500).json({ message: err.message });
    res.json(rows);
  });
};

exports.createRole = (req, res) => {
  const { name } = req.body;

  db.run("INSERT INTO roles(name) VALUES(?)", [name], function(err) {
    if (err) return res.status(500).json({ message: err.message });
    res.status(201).json({ id: this.lastID, name });
  });
};
