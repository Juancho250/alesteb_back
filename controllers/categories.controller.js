const db = require("../config/db");

// ============================================
// 🌳 OBTENER CATEGORÍAS CON ESTRUCTURA JERÁRQUICA
// ============================================
exports.getAll = async (req, res) => {
  try {
    // Obtener todas las categorías activas
    const result = await db.query(`
      SELECT 
        id, 
        name, 
        slug, 
        description, 
        image_url, 
        parent_id,
        is_active,
        created_at,
        updated_at
      FROM categories 
      WHERE is_active = true
      ORDER BY name
    `);
    
    // Construir árbol jerárquico en JavaScript
    const buildTree = (items, parentId = null) => {
      return items
        .filter(item => item.parent_id === parentId)
        .map(item => ({
          ...item,
          children: buildTree(items, item.id)
        }));
    };
    
    const tree = buildTree(result.rows);
    
    // ✅ Devolver array directo (sin wrapper)
    res.json(tree);
    
  } catch (error) {
    console.error("GET CATEGORIES ERROR:", error);
    res.status(500).json({ 
      success: false,
      message: "Error al obtener categorías" 
    });
  }
};

// ============================================
// 📋 ENDPOINT FLAT - Lista plana para selects
// ============================================
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
          CAST(name AS TEXT) as full_path,
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
          CAST(cp.full_path || ' > ' || c.name AS TEXT),
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
    
    // ✅ Devolver array directo (sin wrapper)
    res.json(result.rows);
    
  } catch (error) {
    console.error("GET FLAT CATEGORIES ERROR:", error);
    res.status(500).json({ 
      success: false,
      message: "Error al obtener categorías planas" 
    });
  }
};

// ============================================
// ➕ CREAR CATEGORÍA
// ============================================
exports.create = async (req, res) => {
  const { name, slug, description, image_url, parent_id } = req.body;

  try {
    // Generar slug automáticamente si no viene
    const finalSlug = slug || name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

    const result = await db.query(
      `INSERT INTO categories (name, slug, description, image_url, parent_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name, finalSlug, description, image_url, parent_id || null]
    );

    // ✅ Devolver objeto directo (sin wrapper)
    res.status(201).json(result.rows[0]);
    
  } catch (error) {
    console.error("CREATE CATEGORY ERROR:", error);
    if (error.code === '23505') {
      return res.status(400).json({ 
        success: false,
        message: "El slug ya existe" 
      });
    }
    res.status(500).json({ 
      success: false,
      message: "Error al crear categoría" 
    });
  }
};

// ============================================
// ✏️ ACTUALIZAR CATEGORÍA
// ============================================
exports.update = async (req, res) => {
  const { id } = req.params;
  const { name, slug, description, image_url, parent_id, is_active } = req.body;

  try {
    // Validar que no se asigne como padre de sí misma
    if (parent_id && parseInt(parent_id) === parseInt(id)) {
      return res.status(400).json({ 
        success: false,
        message: "Una categoría no puede ser padre de sí misma" 
      });
    }

    const result = await db.query(
      `UPDATE categories 
       SET name = $1, slug = $2, description = $3, image_url = $4, 
           parent_id = $5, is_active = $6, updated_at = CURRENT_TIMESTAMP
       WHERE id = $7
       RETURNING *`,
      [name, slug, description, image_url, parent_id || null, is_active ?? true, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ 
        success: false,
        message: "Categoría no encontrada" 
      });
    }

    // ✅ Devolver objeto directo (sin wrapper)
    res.json(result.rows[0]);
    
  } catch (error) {
    console.error("UPDATE CATEGORY ERROR:", error);
    res.status(500).json({ 
      success: false,
      message: "Error al actualizar categoría" 
    });
  }
};

// ============================================
// 🗑️ ELIMINAR CATEGORÍA
// ============================================
exports.remove = async (req, res) => {
  const { id } = req.params;

  try {
    // Verificar si tiene subcategorías
    const checkChildren = await db.query(
      "SELECT COUNT(*) as count FROM categories WHERE parent_id = $1",
      [id]
    );

    if (parseInt(checkChildren.rows[0].count) > 0) {
      return res.status(400).json({ 
        success: false,
        message: "No se puede eliminar. Esta categoría tiene subcategorías asociadas" 
      });
    }

    // Verificar si tiene productos asociados
    const checkProducts = await db.query(
      "SELECT COUNT(*) as count FROM products WHERE category_id = $1",
      [id]
    );

    if (parseInt(checkProducts.rows[0].count) > 0) {
      return res.status(400).json({ 
        success: false,
        message: "No se puede eliminar. Esta categoría tiene productos asociados" 
      });
    }

    // Eliminar la categoría
    const result = await db.query("DELETE FROM categories WHERE id = $1", [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ 
        success: false,
        message: "Categoría no encontrada" 
      });
    }

    // ✅ Confirmar eliminación
    res.json({ 
      success: true,
      message: "Categoría eliminada correctamente" 
    });
    
  } catch (error) {
    console.error("DELETE CATEGORY ERROR:", error);
    res.status(500).json({ 
      success: false,
      message: "Error al eliminar categoría" 
    });
  }
};