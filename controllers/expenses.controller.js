import db from "../config/db.js";

/* =========================
   OBTENER TODOS LOS GASTOS
========================= */
export const getExpenses = (req, res) => {
  db.all(
    "SELECT * FROM expenses ORDER BY created_at DESC",
    [],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json(rows);
    }
  );
};

/* =========================
   CREAR GASTO / COMPRA
========================= */
export const createExpense = (req, res) => {
  const { type, category, description, amount } = req.body;

  if (!type || !category || !amount) {
    return res.status(400).json({ error: "Datos incompletos" });
  }

  db.run(
    `
    INSERT INTO expenses (type, category, description, amount)
    VALUES (?, ?, ?, ?)
    `,
    [type, category, description, amount],
    function (err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({
        id: this.lastID,
        type,
        category,
        description,
        amount
      });
    }
  );
};

/* =========================
   RESUMEN FINANCIERO
========================= */
export const getFinanceSummary = (req, res) => {
  const query = `
    SELECT
      SUM(CASE WHEN type = 'gasto' THEN amount ELSE 0 END) as totalGastos,
      SUM(CASE WHEN type = 'compra' THEN amount ELSE 0 END) as totalCompras
    FROM expenses
  `;

  db.get(query, [], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    res.json({
      totalGastos: row?.totalGastos || 0,
      totalCompras: row?.totalCompras || 0
    });
  });
};
