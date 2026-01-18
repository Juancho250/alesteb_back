const db = require("../config/db");

// Obtener todos los productos
exports.getAll = (req, res) => {
  db.all("SELECT * FROM products ORDER BY created_at DESC", [], (err, rows) => {
    if (err) return res.status(500).json(err);
    res.json(rows);
  });
};

// Crear producto
exports.create = (req, res) => {
  const { name, price, stock } = req.body;

  db.run(
    "INSERT INTO products (name, price, stock) VALUES (?, ?, ?)",
    [name, price, stock],
    function (err) {
      if (err) return res.status(500).json(err);
      res.json({ id: this.lastID });
    }
  );
};

// Actualizar producto
exports.update = (req, res) => {
  const { id } = req.params;
  const { name, price, stock } = req.body;

  db.run(
    "UPDATE products SET name=?, price=?, stock=? WHERE id=?",
    [name, price, stock, id],
    function (err) {
      if (err) return res.status(500).json(err);
      res.json({ updated: this.changes });
    }
  );
};

// Eliminar producto
exports.remove = (req, res) => {
  const { id } = req.params;

  db.run("DELETE FROM products WHERE id=?", [id], function (err) {
    if (err) return res.status(500).json(err);
    res.json({ deleted: this.changes });
  });
};


// Obtener producto por ID (WEB)
exports.getById = (req, res) => {
  const { id } = req.params;

  db.get(
    "SELECT * FROM products WHERE id = ?",
    [id],
    (err, row) => {
      if (err) return res.status(500).json(err);
      if (!row) return res.status(404).json({ message: "Producto no encontrado" });

      res.json(row);
    }
  );
};
