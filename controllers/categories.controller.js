const db = require("../config/db");

// Función auxiliar para convertir lista plana en árbol (Recursiva)
const buildTree = (items, parentId = null) => {
  return items
    .filter(item => item.parent_id === parentId)
    .map(item => ({
      ...item,
      children: buildTree(items, item.id)
    }));
};

// Obtiene las categorías en estructura de árbol para menús
exports.getTree = async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM categories ORDER BY name ASC");
    const tree = buildTree(result.rows);
    res.json(tree);
  } catch (error) {
    console.error("GET CATEGORIES TREE ERROR:", error);
    res.status(500).json({ message: "Error al obtener el árbol de categorías" });
  }
};

// Obtiene una lista plana pero con prefijos para selectores del Admin
// Ejemplo: "Electrónica", "  -- Celulares"
exports.getFlatList = async (req, res) => {
  try {
    const result = await db.query(`
      WITH RECURSIVE category_path AS (
        SELECT id, name, parent_id, name::text AS full_path, 0 AS level
        FROM categories
        WHERE parent_id IS NULL
        UNION ALL
        SELECT c.id, c.name, c.parent_id, cp.full_path || ' > ' || c.name, cp.level + 1
        FROM categories c
        JOIN category_path cp ON c.parent_id = cp.id
      )
      SELECT * FROM category_path ORDER BY full_path;
    `);
    res.json(result.rows);
  } catch (error) {
    console.error("GET FLAT CATEGORIES ERROR:", error);
    res.status(500).json({ message: "Error al obtener lista de categorías" });
  }
};

exports.create = async (req, res) => {
  const { name, parent_id, description } = req.body;
  
  // Generamos un slug profesional
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  try {
    const result = await db.query(
      "INSERT INTO categories (name, slug, parent_id, description) VALUES ($1, $2, $3, $4) RETURNING *",
      [name, slug, parent_id || null, description]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') { // Error de duplicado en PostgreSQL
      return res.status(400).json({ message: "Ya existe una categoría con ese nombre o slug" });
    }
    console.error("CREATE CATEGORY ERROR:", error);
    res.status(500).json({ message: "Error al crear categoría" });
  }
};

exports.remove = async (req, res) => {
  const { id } = req.params;
  
  try {
    // 1. Verificar si tiene subcategorías
    const subCats = await db.query("SELECT id FROM categories WHERE parent_id = $1 LIMIT 1", [id]);
    if (subCats.rows.length > 0) {
      return res.status(400).json({ 
        message: "No se puede eliminar: Esta categoría tiene subcategorías asociadas." 
      });
    }

    // 2. Verificar si tiene productos
    const products = await db.query("SELECT id FROM products WHERE category_id = $1 LIMIT 1", [id]);
    if (products.rows.length > 0) {
      return res.status(400).json({ 
        message: "No se puede eliminar: Hay productos que pertenecen a esta categoría." 
      });
    }

    const result = await db.query("DELETE FROM categories WHERE id = $1", [id]);
    
    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Categoría no encontrada" });
    }

    res.json({ message: "Categoría eliminada con éxito" });
  } catch (error) {
    console.error("DELETE CATEGORY ERROR:", error);
    res.status(500).json({ message: "Error interno al eliminar la categoría" });
  }
};