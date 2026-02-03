const db = require("../config/db");
const { z } = require("zod");

// ===============================
// ESQUEMAS DE VALIDACIÓN
// ===============================

const categoryCreateSchema = z.object({
  name: z.string()
    .min(2, "El nombre debe tener al menos 2 caracteres")
    .max(100, "El nombre no puede exceder 100 caracteres")
    .trim(),
  parent_id: z.number()
    .int()
    .positive()
    .nullable()
    .optional(),
  description: z.string()
    .max(500, "La descripción no puede exceder 500 caracteres")
    .trim()
    .nullable()
    .optional()
});

const categoryUpdateSchema = z.object({
  name: z.string()
    .min(2, "El nombre debe tener al menos 2 caracteres")
    .max(100, "El nombre no puede exceder 100 caracteres")
    .trim()
    .optional(),
  parent_id: z.number()
    .int()
    .positive()
    .nullable()
    .optional(),
  description: z.string()
    .max(500, "La descripción no puede exceder 500 caracteres")
    .trim()
    .nullable()
    .optional()
});

// ===============================
// UTILIDADES
// ===============================

const generateSlug = (name) => {
  return name
    .toLowerCase()
    .trim()
    .normalize("NFD") // Normalizar caracteres especiales
    .replace(/[\u0300-\u036f]/g, "") // Remover acentos
    .replace(/[^\w\s-]/g, "") // Remover caracteres especiales
    .replace(/[\s_-]+/g, "-") // Reemplazar espacios y guiones múltiples
    .replace(/^-+|-+$/g, ""); // Remover guiones al inicio/final
};

const buildTree = (items, parentId = null) => {
  return items
    .filter(item => item.parent_id === parentId)
    .map(item => ({
      ...item,
      children: buildTree(items, item.id)
    }));
};

// ===============================
// CONTROLADORES
// ===============================

exports.getTree = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, parent_id, slug, description, created_at 
       FROM categories 
       ORDER BY name ASC`
    );

    const tree = buildTree(result.rows);
    res.json(tree);
  } catch (error) {
    console.error("GET CATEGORIES TREE ERROR:", {
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
    res.status(500).json({ message: "Error al obtener el árbol de categorías" });
  }
};

exports.getFlatList = async (req, res) => {
  try {
    const result = await db.query(`
      WITH RECURSIVE category_path AS (
        SELECT 
          id, 
          name, 
          parent_id, 
          slug,
          description,
          name::text AS full_path, 
          0 AS level
        FROM categories
        WHERE parent_id IS NULL

        UNION ALL

        SELECT 
          c.id, 
          c.name, 
          c.parent_id, 
          c.slug,
          c.description,
          cp.full_path || ' > ' || c.name, 
          cp.level + 1
        FROM categories c
        JOIN category_path cp ON c.parent_id = cp.id
      )
      SELECT 
        id,
        name,
        parent_id,
        slug,
        description,
        full_path,
        level
      FROM category_path 
      ORDER BY full_path ASC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("GET FLAT CATEGORIES ERROR:", {
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
    res.status(500).json({ message: "Error al obtener lista de categorías" });
  }
};

exports.getById = async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ message: "ID inválido" });
    }

    const result = await db.query(
      `SELECT id, name, parent_id, slug, description, created_at 
       FROM categories 
       WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Categoría no encontrada" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("GET CATEGORY ERROR:", {
      message: error.message,
      categoryId: req.params.id
    });
    res.status(500).json({ message: "Error al obtener categoría" });
  }
};

exports.getBySlug = async (req, res) => {
  try {
    const { slug } = req.params;

    // Validar formato de slug
    if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
      return res.status(400).json({ message: "Slug inválido" });
    }

    const result = await db.query(
      `SELECT id, name, parent_id, slug, description, created_at 
       FROM categories 
       WHERE slug = $1`,
      [slug]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Categoría no encontrada" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("GET CATEGORY BY SLUG ERROR:", {
      message: error.message,
      slug: req.params.slug
    });
    res.status(500).json({ message: "Error al obtener categoría" });
  }
};

exports.create = async (req, res) => {
  const client = await db.connect();

  try {
    // Validar datos de entrada
    const validatedData = categoryCreateSchema.parse(req.body);

    await client.query('BEGIN');

    // Generar slug único
    const slug = generateSlug(validatedData.name);

    // Verificar que el slug no exista
    const existingSlug = await client.query(
      "SELECT id FROM categories WHERE slug = $1",
      [slug]
    );

    if (existingSlug.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        message: "Ya existe una categoría con ese nombre" 
      });
    }

    // Si tiene parent_id, verificar que el padre existe
    if (validatedData.parent_id) {
      const parentExists = await client.query(
        "SELECT id FROM categories WHERE id = $1",
        [validatedData.parent_id]
      );

      if (parentExists.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ 
          message: "La categoría padre no existe" 
        });
      }

      // Verificar que no se cree una relación circular
      const checkCircular = await client.query(`
        WITH RECURSIVE parent_chain AS (
          SELECT id, parent_id
          FROM categories
          WHERE id = $1

          UNION ALL

          SELECT c.id, c.parent_id
          FROM categories c
          JOIN parent_chain pc ON c.id = pc.parent_id
        )
        SELECT COUNT(*) as count
        FROM parent_chain
      `, [validatedData.parent_id]);

      // Límite razonable de niveles de anidación
      if (parseInt(checkCircular.rows[0].count) >= 5) {
        await client.query('ROLLBACK');
        return res.status(400).json({ 
          message: "Nivel máximo de anidación alcanzado (5 niveles)" 
        });
      }
    }

    // Insertar categoría
    const result = await client.query(
      `INSERT INTO categories (name, slug, parent_id, description)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, slug, parent_id, description, created_at`,
      [
        validatedData.name,
        slug,
        validatedData.parent_id || null,
        validatedData.description || null
      ]
    );

    await client.query('COMMIT');

    res.status(201).json({
      message: "Categoría creada con éxito",
      category: result.rows[0]
    });
  } catch (error) {
    await client.query('ROLLBACK');

    if (error instanceof z.ZodError) {
      return res.status(400).json({
        message: "Datos de entrada inválidos",
        errors: error.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message
        }))
      });
    }

    if (error.code === "23505") { // Unique violation
      return res.status(400).json({ message: "Ya existe esa categoría" });
    }

    console.error("CREATE CATEGORY ERROR:", {
      message: error.message,
      userId: req.user?.id,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
    
    res.status(500).json({ message: "Error al crear categoría" });
  } finally {
    client.release();
  }
};

exports.update = async (req, res) => {
  const client = await db.connect();

  try {
    const id = parseInt(req.params.id);

    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ message: "ID inválido" });
    }

    // Validar datos de entrada
    const validatedData = categoryUpdateSchema.parse(req.body);

    await client.query('BEGIN');

    // Verificar que la categoría existe
    const existing = await client.query(
      "SELECT id, name FROM categories WHERE id = $1",
      [id]
    );

    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: "Categoría no encontrada" });
    }

    // Construir query dinámicamente
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (validatedData.name !== undefined) {
      const newSlug = generateSlug(validatedData.name);
      
      // Verificar que el nuevo slug no exista (excepto en la misma categoría)
      const slugCheck = await client.query(
        "SELECT id FROM categories WHERE slug = $1 AND id != $2",
        [newSlug, id]
      );

      if (slugCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ 
          message: "Ya existe una categoría con ese nombre" 
        });
      }

      updates.push(`name = $${paramIndex++}`);
      values.push(validatedData.name);
      updates.push(`slug = $${paramIndex++}`);
      values.push(newSlug);
    }

    if (validatedData.parent_id !== undefined) {
      // Verificar que no se establezca como padre de sí misma
      if (validatedData.parent_id === id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ 
          message: "Una categoría no puede ser padre de sí misma" 
        });
      }

      // Verificar que el padre existe (si no es null)
      if (validatedData.parent_id !== null) {
        const parentExists = await client.query(
          "SELECT id FROM categories WHERE id = $1",
          [validatedData.parent_id]
        );

        if (parentExists.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ 
            message: "La categoría padre no existe" 
          });
        }

        // Verificar que no se cree una relación circular
        const circularCheck = await client.query(`
          WITH RECURSIVE descendants AS (
            SELECT id, parent_id
            FROM categories
            WHERE id = $1

            UNION ALL

            SELECT c.id, c.parent_id
            FROM categories c
            JOIN descendants d ON c.parent_id = d.id
          )
          SELECT COUNT(*) as count
          FROM descendants
          WHERE id = $2
        `, [id, validatedData.parent_id]);

        if (parseInt(circularCheck.rows[0].count) > 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ 
            message: "No se puede crear una relación circular" 
          });
        }
      }

      updates.push(`parent_id = $${paramIndex++}`);
      values.push(validatedData.parent_id);
    }

    if (validatedData.description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      values.push(validatedData.description);
    }

    if (updates.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: "No hay campos para actualizar" });
    }

    values.push(id);

    const result = await client.query(`
      UPDATE categories
      SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE id = $${paramIndex}
      RETURNING id, name, slug, parent_id, description, created_at, updated_at
    `, values);

    await client.query('COMMIT');

    res.json({
      message: "Categoría actualizada con éxito",
      category: result.rows[0]
    });
  } catch (error) {
    await client.query('ROLLBACK');

    if (error instanceof z.ZodError) {
      return res.status(400).json({
        message: "Datos de entrada inválidos",
        errors: error.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message
        }))
      });
    }

    console.error("UPDATE CATEGORY ERROR:", {
      message: error.message,
      categoryId: req.params.id,
      userId: req.user?.id
    });
    
    res.status(500).json({ message: "Error al actualizar categoría" });
  } finally {
    client.release();
  }
};

exports.remove = async (req, res) => {
  const client = await db.connect();

  try {
    const id = parseInt(req.params.id);

    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ message: "ID inválido" });
    }

    await client.query('BEGIN');

    // Verificar que existe
    const exists = await client.query(
      "SELECT id FROM categories WHERE id = $1",
      [id]
    );

    if (exists.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: "Categoría no encontrada" });
    }

    // Verificar que no tenga subcategorías
    const subCats = await client.query(
      "SELECT id FROM categories WHERE parent_id = $1 LIMIT 1",
      [id]
    );

    if (subCats.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        message: "No se puede eliminar: tiene subcategorías asociadas" 
      });
    }

    // Verificar que no tenga productos
    const products = await client.query(
      "SELECT id FROM products WHERE category_id = $1 LIMIT 1",
      [id]
    );

    if (products.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        message: "No se puede eliminar: tiene productos asociados" 
      });
    }

    // Eliminar categoría
    await client.query("DELETE FROM categories WHERE id = $1", [id]);

    await client.query('COMMIT');

    res.json({ 
      message: "Categoría eliminada con éxito",
      id
    });
  } catch (error) {
    await client.query('ROLLBACK');

    console.error("DELETE CATEGORY ERROR:", {
      message: error.message,
      categoryId: req.params.id,
      userId: req.user?.id
    });
    
    res.status(500).json({ message: "Error al eliminar categoría" });
  } finally {
    client.release();
  }
};

// ===============================
// ENDPOINTS ADICIONALES ÚTILES
// ===============================

exports.getProductCount = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        c.id,
        c.name,
        c.slug,
        COUNT(p.id) as product_count
      FROM categories c
      LEFT JOIN products p ON c.id = p.category_id
      GROUP BY c.id, c.name, c.slug
      ORDER BY c.name ASC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("GET PRODUCT COUNT ERROR:", error);
    res.status(500).json({ message: "Error al obtener conteo de productos" });
  }
};