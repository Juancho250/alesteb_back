const db = require("../config/db");

// Obtener categorías con estructura jerárquica
exports.getAll = async (req, res) => {
  try {
    const result = await db.query(`
      WITH RECURSIVE category_tree AS (
        -- Categorías raíz (sin padre)
        SELECT 
          id, 
          name, 
          slug, 
          description, 
          image_url, 
          parent_id,
          name as full_path,
          1 as level
        FROM categories 
        WHERE parent_id IS NULL AND is_active = true
        
        UNION ALL
        
        -- Subcategorías recursivas
        SELECT 
          c.id, 
          c.name, 
          c.slug, 
          c.description, 
          c.image_url, 
          c.parent_id,
          ct.full_path || ' > ' || c.name as full_path,
          ct.level + 1
        FROM categories c
        INNER JOIN category_tree ct ON c.parent_id = ct.id
        WHERE c.is_active = true
      )
      SELECT * FROM category_tree ORDER BY full_path
    `);
    
    res.json(result.rows);
  } catch (error) {
    console.error("GET CATEGORIES ERROR:", error);
    res.status(500).json({ message: "Error al obtener categorías" });
  }
};

// 🆕 ENDPOINT FLAT - Lista plana para selects
exports.getFlat = async (req, res) => {
  try {
    const result = await db.query(`
      WITH RECURSIVE category_paths AS (
        -- Nivel raíz
        SELECT 
          id, 
          name, 
          slug, 
          parent_id,
          name as full_path,
          1 as level
        FROM categories 
        WHERE parent_id IS NULL AND is_active = true
        
        UNION ALL
        
        -- Niveles descendientes
        SELECT 
          c.id, 
          c.name, 
          c.slug, 
          c.parent_id,
          cp.full_path || ' > ' || c.name,
          cp.level + 1
        FROM categories c
        INNER JOIN category_paths cp ON c.parent_id = cp.id
        WHERE c.is_active = true
      )
      SELECT 
        id, 
        name, 
        slug, 
        parent_id,
        full_path,
        level
      FROM category_paths 
      ORDER BY full_path
    `);
    
    res.json(result.rows);
  } catch (error) {
    console.error("GET FLAT CATEGORIES ERROR:", error);
    res.status(500).json({ message: "Error al obtener categorías planas" });
  }
};

// Crear categoría
exports.create = async (req, res) => {
  const { name, slug, description, image_url, parent_id } = req.body;

  try {
    const result = await db.query(
      `INSERT INTO categories (name, slug, description, image_url, parent_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name, slug, description, image_url, parent_id]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("CREATE CATEGORY ERROR:", error);
    if (error.code === '23505') {
      return res.status(400).json({ message: "El slug ya existe" });
    }
    res.status(500).json({ message: "Error al crear categoría" });
  }
};

// Actualizar categoría
exports.update = async (req, res) => {
  const { id } = req.params;
  const { name, slug, description, image_url, parent_id, is_active } = req.body;

  try {
    const result = await db.query(
      `UPDATE categories 
       SET name = $1, slug = $2, description = $3, image_url = $4, 
           parent_id = $5, is_active = $6, updated_at = CURRENT_TIMESTAMP
       WHERE id = $7
       RETURNING *`,
      [name, slug, description, image_url, parent_id, is_active, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Categoría no encontrada" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("UPDATE CATEGORY ERROR:", error);
    res.status(500).json({ message: "Error al actualizar categoría" });
  }
};

// Eliminar categoría
exports.remove = async (req, res) => {
  const { id } = req.params;

  try {
    const result = await db.query("DELETE FROM categories WHERE id = $1", [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Categoría no encontrada" });
    }

    res.json({ message: "Categoría eliminada correctamente" });
  } catch (error) {
    console.error("DELETE CATEGORY ERROR:", error);
    res.status(500).json({ message: "Error al eliminar categoría" });
  }
};