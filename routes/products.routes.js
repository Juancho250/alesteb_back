const express = require("express");
const { auth, requireRole, optionalAuth } = require("../middleware/auth.middleware");
const upload = require("../middleware/upload.middleware");
const ctrl = require("../controllers/products.controller");

const router = express.Router();

// ============================================
// 🌐 RUTAS PÚBLICAS (No requieren autenticación)
// ============================================

/**
 * @route   GET /api/products
 * @desc    Obtener todos los productos (con filtros opcionales)
 * @access  Public
 * @query   categoria - Filtrar por slug de categoría
 * @example /api/products?categoria=ropa-mujer
 */
router.get("/", ctrl.getAll);

/**
 * @route   GET /api/products/:id
 * @desc    Obtener un producto específico por ID
 * @access  Public
 * @params  id - ID del producto
 */
router.get("/:id", ctrl.getById);

// ============================================
// 🔐 RUTAS PROTEGIDAS (Requieren autenticación ADMIN)
// ============================================

/**
 * @route   POST /api/products
 * @desc    Crear un nuevo producto
 * @access  Private (Solo Admin)
 * @body    { name, price, stock, category_id, description }
 * @files   images[] - Máximo 6 imágenes
 */
router.post(
  "/",
  auth,
  requireRole(["admin", "super_admin"]),
  upload.array("images", 6),
  ctrl.create
);

/**
 * @route   PUT /api/products/:id
 * @desc    Actualizar un producto existente
 * @access  Private (Solo Admin)
 * @params  id - ID del producto a actualizar
 * @body    { name, price, stock, category_id, description, deleted_image_ids }
 * @files   images[] - Nuevas imágenes (opcional, máximo 6)
 */
router.put(
  "/:id",
  auth,
  requireRole(["admin", "super_admin"]),
  upload.array("images", 6),
  ctrl.update
);

/**
 * @route   DELETE /api/products/:id
 * @desc    Eliminar un producto
 * @access  Private (Solo Admin)
 * @params  id - ID del producto a eliminar
 */
router.delete(
  "/:id",
  auth,
  requireRole(["admin", "super_admin"]),
  ctrl.remove
);

// ============================================
// 📊 RUTAS ADICIONALES (Opcionales - para futuro)
// ============================================

/**
 * @route   PATCH /api/products/:id/stock
 * @desc    Actualizar solo el stock de un producto
 * @access  Private (Solo Admin)
 * @params  id - ID del producto
 * @body    { stock }
 */
router.patch(
  "/:id/stock",
  auth,
  requireRole(["admin", "super_admin"]),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { stock } = req.body;

      if (stock === undefined || stock < 0) {
        return res.status(400).json({
          success: false,
          message: "Stock debe ser un número positivo"
        });
      }

      const db = require("../config/db");
      await db.query("UPDATE products SET stock = $1 WHERE id = $2", [stock, id]);

      res.json({
        success: true,
        message: "Stock actualizado correctamente"
      });
    } catch (error) {
      console.error("UPDATE STOCK ERROR:", error);
      res.status(500).json({
        success: false,
        message: "Error al actualizar stock"
      });
    }
  }
);

/**
 * @route   PATCH /api/products/:id/main-image
 * @desc    Cambiar la imagen principal de un producto
 * @access  Private (Solo Admin)
 * @params  id - ID del producto
 * @body    { image_id } - ID de la imagen a marcar como principal
 */
router.patch(
  "/:id/main-image",
  auth,
  requireRole(["admin", "super_admin"]),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { image_id } = req.body;

      if (!image_id) {
        return res.status(400).json({
          success: false,
          message: "image_id es requerido"
        });
      }

      const db = require("../config/db");
      const client = await db.connect();

      try {
        await client.query("BEGIN");

        // Quitar is_main de todas las imágenes del producto
        await client.query(
          "UPDATE product_images SET is_main = false WHERE product_id = $1",
          [id]
        );

        // Marcar la nueva como principal
        const result = await client.query(
          "UPDATE product_images SET is_main = true WHERE id = $1 AND product_id = $2",
          [image_id, id]
        );

        if (result.rowCount === 0) {
          throw new Error("Imagen no encontrada o no pertenece al producto");
        }

        await client.query("COMMIT");

        res.json({
          success: true,
          message: "Imagen principal actualizada"
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("UPDATE MAIN IMAGE ERROR:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Error al actualizar imagen principal"
      });
    }
  }
);

module.exports = router;