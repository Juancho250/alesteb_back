const db = require("../config/db");

// Obtener todos los productos
exports.getAll = (req, res) => {
  const sql = `
    SELECT 
      p.*,
      (
        SELECT url 
        FROM product_images 
        WHERE product_id = p.id AND is_main = 1
        LIMIT 1
      ) AS main_image
    FROM products p
    ORDER BY p.created_at DESC
  `;

  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json(err);
    res.json(rows);
  });
};


// Crear producto
exports.create = (req, res) => {
  const { name, price, stock, category } = req.body;
  const images = Array.isArray(req.files) ? req.files : [];

  db.run(
    `INSERT INTO products (name, price, stock, category)
     VALUES (?, ?, ?, ?)`,
    [name, price, stock, category],
    function (err) {
      if (err) {
        console.error("INSERT PRODUCT ERROR:", err);
        return res.status(500).json(err);
      }

      const productId = this.lastID;

      if (images.length === 0) {
        return res.json({ id: productId });
      }

      const stmt = db.prepare(
        `INSERT INTO product_images (product_id, url, is_main)
         VALUES (?, ?, ?)`
      );

      images.forEach((img, index) => {
        const imageUrl = img.path || img.secure_url;
        stmt.run(productId, imageUrl, index === 0 ? 1 : 0);
      });

      stmt.finalize(() => {
        res.json({ id: productId });
      });
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

  db.get("SELECT * FROM products WHERE id = ?", [id], (err, product) => {
    if (err) return res.status(500).json(err);
    if (!product) return res.status(404).json({ message: "No encontrado" });

    db.all(
      "SELECT id, url, is_main FROM product_images WHERE product_id = ?",
      [id],
      (err, images) => {
        if (err) return res.status(500).json(err);
        res.json({ ...product, images });
      }
    );
  });
};

