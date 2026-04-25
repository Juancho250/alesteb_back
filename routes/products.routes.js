const express = require("express");
const { auth, requireRole } = require("../middleware/auth.middleware");
const { uploadProduct } = require("../middleware/upload.middleware");
const ctrl = require("../controllers/products.controller");
const db   = require("../config/db");

const router = express.Router();

// ── Públicas ──────────────────────────────────────────────────────────────────
router.get("/", ctrl.getAll);
router.get("/:id", ctrl.getById);

// ── Protegidas ────────────────────────────────────────────────────────────────
router.post(
  "/",
  auth, requireRole(["admin", "gerente"]),
  uploadProduct.array("images", 6),
  ctrl.create
);

router.put(
  "/:id",
  auth, requireRole(["admin", "gerente"]),
  uploadProduct.array("images", 6),
  ctrl.update
);

router.delete(
  "/:id",
  auth, requireRole(["admin", "gerente"]),
  ctrl.remove
);

router.patch(
  "/:id/stock",
  auth, requireRole(["admin", "gerente"]),
  async (req, res) => {
    try {
      const { stock } = req.body;
      if (stock === undefined || stock < 0)
        return res.status(400).json({ success: false, message: "Stock debe ser un número positivo" });

      await db.query("UPDATE products SET stock = $1 WHERE id = $2", [stock, req.params.id]);
      res.json({ success: true, message: "Stock actualizado correctamente" });
    } catch (err) {
      console.error("UPDATE STOCK ERROR:", err);
      res.status(500).json({ success: false, message: "Error al actualizar stock" });
    }
  }
);

router.patch(
  "/:id/main-image",
  auth, requireRole(["admin", "gerente"]),
  async (req, res) => {
    const { image_id } = req.body;
    if (!image_id)
      return res.status(400).json({ success: false, message: "image_id es requerido" });

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE product_images SET is_main = false WHERE product_id = $1", [req.params.id]);
      const result = await client.query(
        "UPDATE product_images SET is_main = true WHERE id = $1 AND product_id = $2",
        [image_id, req.params.id]
      );
      if (!result.rowCount) throw new Error("Imagen no encontrada o no pertenece al producto");
      await client.query("COMMIT");
      res.json({ success: true, message: "Imagen principal actualizada" });
    } catch (err) {
      await client.query("ROLLBACK");
      res.status(500).json({ success: false, message: err.message || "Error al actualizar imagen principal" });
    } finally {
      client.release();
    }
  }
);

module.exports = router;