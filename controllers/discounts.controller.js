const db = require("../config/db");
const { z } = require("zod");

// ===============================
// ESQUEMAS DE VALIDACIÓN
// ===============================

const discountTargetSchema = z.object({
  target_type: z.enum(['product', 'category', 'all'], {
    errorMap: () => ({ message: "Tipo debe ser 'product', 'category' o 'all'" })
  }),
  target_id: z.number()
    .int()
    .positive()
    .optional()
    .nullable()
});

const discountCreateSchema = z.object({
  name: z.string()
    .min(3, "El nombre debe tener al menos 3 caracteres")
    .max(100, "El nombre no puede exceder 100 caracteres")
    .trim(),
  type: z.enum(['percentage', 'fixed'], {
    errorMap: () => ({ message: "Tipo debe ser 'percentage' o 'fixed'" })
  }),
  value: z.number()
    .positive("El valor debe ser mayor a 0")
    .refine((val, ctx) => {
      const type = ctx?.parent?.type;
      if (type === 'percentage' && val > 100) {
        return false;
      }
      if (type === 'fixed' && val > 999999) {
        return false;
      }
      return true;
    }, {
      message: "Valor inválido para el tipo de descuento"
    }),
  starts_at: z.string()
    .datetime({ message: "Formato de fecha inválido" })
    .or(z.date()),
  ends_at: z.string()
    .datetime({ message: "Formato de fecha inválido" })
    .or(z.date()),
  targets: z.array(discountTargetSchema)
    .min(1, "Debe incluir al menos un objetivo")
    .max(100, "Máximo 100 objetivos por descuento")
    .optional()
});

const discountUpdateSchema = discountCreateSchema.partial();

// ===============================
// CREAR DESCUENTO
// ===============================

exports.create = async (req, res) => {
  const client = await db.connect();
  
  try {
    // Validar datos
    const validatedData = discountCreateSchema.parse(req.body);
    
    // Validar fechas
    const startsAt = new Date(validatedData.starts_at);
    const endsAt = new Date(validatedData.ends_at);
    
    if (endsAt <= startsAt) {
      return res.status(400).json({ 
        message: "La fecha de fin debe ser posterior a la fecha de inicio" 
      });
    }

    await client.query("BEGIN");

    // Crear descuento
    const discountRes = await client.query(
      `INSERT INTO discounts (name, type, value, starts_at, ends_at, active, created_at) 
       VALUES ($1, $2, $3, $4, $5, true, NOW()) 
       RETURNING id, name, type, value, starts_at, ends_at, active, created_at`,
      [
        validatedData.name, 
        validatedData.type, 
        validatedData.value, 
        startsAt, 
        endsAt
      ]
    );

    const discountId = discountRes.rows[0].id;

    // Agregar targets si existen
    if (validatedData.targets && validatedData.targets.length > 0) {
      for (const target of validatedData.targets) {
        // Validar que el target existe si no es 'all'
        if (target.target_type === 'product' && target.target_id) {
          const productCheck = await client.query(
            "SELECT id FROM products WHERE id = $1",
            [target.target_id]
          );
          
          if (productCheck.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ 
              message: `Producto con ID ${target.target_id} no encontrado` 
            });
          }
        } else if (target.target_type === 'category' && target.target_id) {
          const categoryCheck = await client.query(
            "SELECT id FROM categories WHERE id = $1",
            [target.target_id]
          );
          
          if (categoryCheck.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ 
              message: `Categoría con ID ${target.target_id} no encontrada` 
            });
          }
        }

        await client.query(
          `INSERT INTO discount_targets (discount_id, target_type, target_id) 
           VALUES ($1, $2, $3)`,
          [discountId, target.target_type, target.target_id || null]
        );
      }
    }

    await client.query("COMMIT");
    
    res.status(201).json({ 
      message: "Descuento creado con éxito",
      discount: discountRes.rows[0]
    });

  } catch (error) {
    await client.query("ROLLBACK");
    
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        message: "Datos de entrada inválidos",
        errors: error.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message
        }))
      });
    }

    console.error("DISCOUNT CREATE ERROR:", {
      message: error.message,
      userId: req.user?.id
    });
    res.status(500).json({ message: "Error al crear el descuento" });
  } finally {
    client.release();
  }
};

// ===============================
// OBTENER TODOS LOS DESCUENTOS
// ===============================

exports.getAll = async (req, res) => {
  try {
    const { active_only } = req.query;
    
    let query = `
      SELECT 
        d.*,
        (SELECT json_agg(
          json_build_object(
            'id', dt.id,
            'target_type', dt.target_type,
            'target_id', dt.target_id
          )
        ) FROM discount_targets dt WHERE dt.discount_id = d.id) as targets
      FROM discounts d
    `;

    if (active_only === 'true') {
      query += ` WHERE d.active = true AND NOW() BETWEEN d.starts_at AND d.ends_at`;
    }

    query += ` ORDER BY d.created_at DESC`;

    const result = await db.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error("GET DISCOUNTS ERROR:", {
      message: error.message
    });
    res.status(500).json({ message: "Error al obtener descuentos" });
  }
};

// ===============================
// OBTENER DESCUENTO POR ID
// ===============================

exports.getById = async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ message: "ID inválido" });
    }

    const result = await db.query(
      `SELECT 
        d.*,
        (SELECT json_agg(
          json_build_object(
            'id', dt.id,
            'target_type', dt.target_type,
            'target_id', dt.target_id
          )
        ) FROM discount_targets dt WHERE dt.discount_id = d.id) as targets
      FROM discounts d
      WHERE d.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Descuento no encontrado" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("GET DISCOUNT ERROR:", {
      message: error.message,
      discountId: req.params.id
    });
    res.status(500).json({ message: "Error al obtener descuento" });
  }
};

// ===============================
// ACTUALIZAR DESCUENTO
// ===============================

exports.update = async (req, res) => {
  const client = await db.connect();
  
  try {
    const id = parseInt(req.params.id);

    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ message: "ID inválido" });
    }

    // Validar datos
    const validatedData = discountUpdateSchema.parse(req.body);

    await client.query("BEGIN");

    // Verificar que existe
    const existingDiscount = await client.query(
      "SELECT id FROM discounts WHERE id = $1",
      [id]
    );

    if (existingDiscount.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Descuento no encontrado" });
    }

    // Validar fechas si ambas están presentes
    if (validatedData.starts_at && validatedData.ends_at) {
      const startsAt = new Date(validatedData.starts_at);
      const endsAt = new Date(validatedData.ends_at);
      
      if (endsAt <= startsAt) {
        await client.query("ROLLBACK");
        return res.status(400).json({ 
          message: "La fecha de fin debe ser posterior a la fecha de inicio" 
        });
      }
    }

    // Construir query de actualización
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (validatedData.name !== undefined) {
      updates.push(`name = $${paramCount++}`);
      values.push(validatedData.name);
    }

    if (validatedData.type !== undefined) {
      updates.push(`type = $${paramCount++}`);
      values.push(validatedData.type);
    }

    if (validatedData.value !== undefined) {
      updates.push(`value = $${paramCount++}`);
      values.push(validatedData.value);
    }

    if (validatedData.starts_at !== undefined) {
      updates.push(`starts_at = $${paramCount++}`);
      values.push(new Date(validatedData.starts_at));
    }

    if (validatedData.ends_at !== undefined) {
      updates.push(`ends_at = $${paramCount++}`);
      values.push(new Date(validatedData.ends_at));
    }

    // Actualizar datos básicos si hay cambios
    if (updates.length > 0) {
      values.push(id);
      await client.query(
        `UPDATE discounts SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${paramCount}`,
        values
      );
    }

    // Actualizar targets si se enviaron
    if (validatedData.targets !== undefined) {
      // Limpiar targets antiguos
      await client.query(
        "DELETE FROM discount_targets WHERE discount_id = $1",
        [id]
      );

      // Agregar nuevos targets
      if (validatedData.targets.length > 0) {
        for (const target of validatedData.targets) {
          // Validar existencia
          if (target.target_type === 'product' && target.target_id) {
            const productCheck = await client.query(
              "SELECT id FROM products WHERE id = $1",
              [target.target_id]
            );
            
            if (productCheck.rows.length === 0) {
              await client.query("ROLLBACK");
              return res.status(404).json({ 
                message: `Producto con ID ${target.target_id} no encontrado` 
              });
            }
          } else if (target.target_type === 'category' && target.target_id) {
            const categoryCheck = await client.query(
              "SELECT id FROM categories WHERE id = $1",
              [target.target_id]
            );
            
            if (categoryCheck.rows.length === 0) {
              await client.query("ROLLBACK");
              return res.status(404).json({ 
                message: `Categoría con ID ${target.target_id} no encontrada` 
              });
            }
          }

          await client.query(
            `INSERT INTO discount_targets (discount_id, target_type, target_id) 
             VALUES ($1, $2, $3)`,
            [id, target.target_type, target.target_id || null]
          );
        }
      }
    }

    await client.query("COMMIT");
    
    res.json({ message: "Descuento actualizado con éxito" });

  } catch (error) {
    await client.query("ROLLBACK");
    
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        message: "Datos de entrada inválidos",
        errors: error.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message
        }))
      });
    }

    console.error("DISCOUNT UPDATE ERROR:", {
      message: error.message,
      discountId: req.params.id,
      userId: req.user?.id
    });
    res.status(500).json({ message: "Error al actualizar descuento" });
  } finally {
    client.release();
  }
};

// ===============================
// ELIMINAR DESCUENTO
// ===============================

exports.remove = async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ message: "ID inválido" });
    }

    const result = await db.query(
      "DELETE FROM discounts WHERE id = $1 RETURNING id",
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Descuento no encontrado" });
    }

    res.json({ 
      message: "Descuento eliminado con éxito",
      id: result.rows[0].id
    });
  } catch (error) {
    console.error("DELETE DISCOUNT ERROR:", {
      message: error.message,
      discountId: req.params.id,
      userId: req.user?.id
    });
    res.status(500).json({ message: "Error al eliminar descuento" });
  }
};

// ===============================
// ACTIVAR/DESACTIVAR DESCUENTO
// ===============================

exports.toggleActive = async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ message: "ID inválido" });
    }

    const result = await db.query(
      `UPDATE discounts 
       SET active = NOT active, updated_at = NOW()
       WHERE id = $1
       RETURNING id, active`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Descuento no encontrado" });
    }

    res.json({
      message: "Estado del descuento actualizado",
      discount: result.rows[0]
    });
  } catch (error) {
    console.error("TOGGLE DISCOUNT ERROR:", {
      message: error.message,
      discountId: req.params.id,
      userId: req.user?.id
    });
    res.status(500).json({ message: "Error al cambiar estado del descuento" });
  }
};