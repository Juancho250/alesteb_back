const db = require("../config/db");

exports.createSale = (req, res) => {
  const { items, total } = req.body;

  if (!items || items.length === 0) {
    return res.status(400).json({ message: "Venta vacía" });
  }

  db.serialize(() => {
    db.run("BEGIN TRANSACTION");

    db.run(
      "INSERT INTO sales (total) VALUES (?)",
      [total],
      function (err) {
        if (err) {
          db.run("ROLLBACK");
          return res.status(500).json(err);
        }

        const saleId = this.lastID;

        const stmtItem = db.prepare(
          "INSERT INTO sale_items (sale_id, product_id, quantity, price) VALUES (?, ?, ?, ?)"
        );

        const stmtStock = db.prepare(
          "UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?"
        );

        for (const item of items) {
          stmtItem.run(
            saleId,
            item.id,
            item.quantity,
            item.price
          );

          stmtStock.run(
            item.quantity,
            item.id,
            item.quantity
          );
        }

        stmtItem.finalize();
        stmtStock.finalize();

        db.run("COMMIT", (err) => {
          if (err) {
            db.run("ROLLBACK");
            return res.status(500).json(err);
          }

          res.json({
            message: "Venta registrada",
            saleId,
          });
        });
      }
    );
  });
};

exports.getSales = (req, res) => {
  db.all(
    `
    SELECT s.id, s.total, s.created_at,
           COUNT(si.id) as items
    FROM sales s
    LEFT JOIN sale_items si ON si.sale_id = s.id
    GROUP BY s.id
    ORDER BY s.created_at DESC
    `,
    [],
    (err, rows) => {
      if (err) return res.status(500).json(err);
      res.json(rows);
    }
  );
};

exports.getSaleById = (req, res) => {
  const { id } = req.params;

  db.all(
    `
    SELECT 
      p.name,
      si.quantity,
      si.price
    FROM sale_items si
    JOIN products p ON p.id = si.product_id
    WHERE si.sale_id = ?
    `,
    [id],
    (err, rows) => {
      if (err) {
        return res.status(500).json(err);
      }

      res.json(rows);
    }
  );
};

