const db = require("../config/db");
const { emitDataUpdate } = require("../config/socket");

// ============================================
// 🌳 OBTENER CATEGORÍAS CON ESTRUCTURA JERÁRQUICA
// ============================================
exports.getAll = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, name, slug, description, image_url, parent_id, is_active, created_at, updated_at
      FROM categories
      WHERE is_active = true
      ORDER BY name
    `);

    // Normalizar parent_id a número o null para evitar problemas de tipo
    const rows = result.rows.map(r => ({
      ...r,
      id: Number(r.id),
      parent_id: r.parent_id != null ? Number(r.parent_id) : null,
    }));

    const buildTree = (items, parentId = null) =>
      items
        .filter(item => item.parent_id === parentId)
        .map(item => ({ ...item, children: buildTree(items, item.id) }));

    res.json(buildTree(rows));
  } catch (error) {
    console.error("GET CATEGORIES ERROR:", error);
    res.status(500).json({ success: false, message: "Error al obtener categorías" });
  }
};

// ============================================
// 📋 ENDPOINT FLAT — Lista plana para selects
// ============================================
exports.getFlat = async (req, res) => {
  try {
    const result = await db.query(`
      WITH RECURSIVE category_paths AS (
        SELECT id, name, slug, parent_id,
               CAST(name AS TEXT) AS full_path,
               1 AS level
        FROM categories
        WHERE parent_id IS NULL AND is_active = true

        UNION ALL

        SELECT c.id, c.name, c.slug, c.parent_id,
               CAST(cp.full_path || ' > ' || c.name AS TEXT),
               cp.level + 1
        FROM categories c
        INNER JOIN category_paths cp ON c.parent_id = cp.id
        WHERE c.is_active = true
      )
      SELECT id, name, slug, parent_id, full_path, level
      FROM category_paths
      ORDER BY full_path
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("GET FLAT CATEGORIES ERROR:", error);
    res.status(500).json({ success: false, message: "Error al obtener categorías planas" });
  }
};

// ============================================
// ➕ CREAR CATEGORÍA
// ============================================
exports.create = async (req, res) => {
  const { name, slug, description, image_url, parent_id } = req.body;

  if (!name?.trim()) {
    return res.status(400).json({ success: false, message: "El nombre es obligatorio" });
  }

  try {
    const finalSlug = slug?.trim() || name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

    const result = await db.query(
      `INSERT INTO categories (name, slug, description, image_url, parent_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name.trim(), finalSlug, description || null, image_url || null, parent_id || null]
    );

    const newCategory = result.rows[0];
    emitDataUpdate("categories", "created", newCategory);

    res.status(201).json(newCategory);
  } catch (error) {
    console.error("CREATE CATEGORY ERROR:", error);
    if (error.code === "23505") {
      return res.status(400).json({ success: false, message: "El slug ya existe. Elige uno diferente." });
    }
    res.status(500).json({ success: false, message: "Error al crear categoría" });
  }
};

// ============================================
// ✏️ ACTUALIZAR CATEGORÍA
// ============================================
exports.update = async (req, res) => {
  const { id } = req.params;
  const { name, slug, description, image_url, parent_id, is_active } = req.body;
  const categoryId = Number(id);
  const newParentId = parent_id ? Number(parent_id) : null;

  try {
    // Evitar que sea padre de sí misma
    if (newParentId && newParentId === categoryId) {
      return res.status(400).json({
        success: false,
        message: "Una categoría no puede ser padre de sí misma",
      });
    }

    // ✅ Detectar ciclos: el nuevo padre no puede ser descendiente de esta categoría
    if (newParentId) {
      const cycleCheck = await db.query(`
        WITH RECURSIVE descendants AS (
          SELECT id FROM categories WHERE parent_id = $1
          UNION ALL
          SELECT c.id FROM categories c
          INNER JOIN descendants d ON c.parent_id = d.id
        )
        SELECT 1 FROM descendants WHERE id = $2
      `, [categoryId, newParentId]);

      if (cycleCheck.rowCount > 0) {
        return res.status(400).json({
          success: false,
          message: "No se puede asignar un descendiente como categoría superior (referencia circular)",
        });
      }
    }

    const result = await db.query(
      `UPDATE categories
       SET name=$1, slug=$2, description=$3, image_url=$4,
           parent_id=$5, is_active=$6, updated_at=CURRENT_TIMESTAMP
       WHERE id=$7
       RETURNING *`,
      [name, slug, description || null, image_url || null, newParentId, is_active ?? true, categoryId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Categoría no encontrada" });
    }

    const updated = result.rows[0];
    emitDataUpdate("categories", "updated", updated);

    res.json(updated);
  } catch (error) {
    console.error("UPDATE CATEGORY ERROR:", error);
    if (error.code === "23505") {
      return res.status(400).json({ success: false, message: "El slug ya existe. Elige uno diferente." });
    }
    res.status(500).json({ success: false, message: "Error al actualizar categoría" });
  }
};

// ============================================
// 🗑️ ELIMINAR CATEGORÍA
// ============================================
exports.remove = async (req, res) => {
  const { id } = req.params;

  try {
    const checkChildren = await db.query(
      "SELECT COUNT(*) AS count FROM categories WHERE parent_id = $1 AND is_active = true",
      [id]
    );
    if (parseInt(checkChildren.rows[0].count) > 0) {
      return res.status(400).json({
        success: false,
        message: "No se puede eliminar. Esta categoría tiene subcategorías asociadas",
      });
    }

    const checkProducts = await db.query(
      "SELECT COUNT(*) AS count FROM products WHERE category_id = $1",
      [id]
    );
    if (parseInt(checkProducts.rows[0].count) > 0) {
      return res.status(400).json({
        success: false,
        message: "No se puede eliminar. Esta categoría tiene productos asociados",
      });
    }

    const result = await db.query(
      "DELETE FROM categories WHERE id = $1 RETURNING id",
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Categoría no encontrada" });
    }

    emitDataUpdate("categories", "deleted", { id: parseInt(id) });

    res.json({ success: true, message: "Categoría eliminada correctamente" });
  } catch (error) {
    console.error("DELETE CATEGORY ERROR:", error);
    res.status(500).json({ success: false, message: "Error al eliminar categoría" });
  }
};