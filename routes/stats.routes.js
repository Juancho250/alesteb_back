const express = require("express");
const router = express.Router();
const db = require("../config/db");

router.get("/dashboard", (req, res) => {
  const data = {};

  db.get(
    `SELECT SUM(total) as total FROM sales WHERE DATE(created_at)=DATE('now')`,
    [],
    (err, row) => {
      data.todaySales = row.total || 0;

      db.all(
        `SELECT DATE(created_at) as day, SUM(total) as total
         FROM sales
         GROUP BY day
         ORDER BY day DESC
         LIMIT 7`,
        [],
        (err, rows) => {
          data.salesByDay = rows.reverse();

          db.all(
            `SELECT p.name, SUM(si.quantity) as qty
             FROM sale_items si
             JOIN products p ON p.id = si.product_id
             GROUP BY p.id
             ORDER BY qty DESC
             LIMIT 5`,
            [],
            (err, top) => {
              data.topProducts = top;
              res.json(data);
            }
          );
        }
      );
    }
  );
});

module.exports = router;
