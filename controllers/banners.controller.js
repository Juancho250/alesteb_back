const db = require("../config/db");
const { z } = require("zod");

// ===============================
// ESQUEMAS DE VALIDACIÓN
// ===============================

const bannerCreateSchema = z.object({
  title: z.string()
    .min(1, "El título es requerido")
    .max(100, "El título no puede exceder 100 caracteres")
    .trim(),
  description: z.string()
    .min(1, "La descripción es requerida")
    .max(500, "La descripción no puede exceder 500 caracteres")
    .trim(),
  button_text: z.string()
    .max(50, "El texto del botón no puede exceder 50 caracteres")
    .trim()
    .optional(),
  button_link: z.string()
    .url("Debe ser una URL válida")
    .max(255, "El link no puede exceder 255 caracteres")
    .optional()
    .or(z.literal(""))
});

const bannerUpdateSchema = z.object({
  title: z.string()
    .min(1, "El título es requerido")
    .max(100, "El título no puede exceder 100 caracteres")
    .trim()
    .optional(),
  description: z.string()
    .min(1, "La descripción es requerida")
    .max(500, "La descripción no puede exceder 500 caracteres")
    .trim()
    .optional(),
  button_text: z.string()
    .max(50, "El texto del botón no puede exceder 50 caracteres")
    .trim()
    .optional(),
  button_link: z.string()
    .url("Debe ser una URL válida")
    .max(255, "El link no puede exceder 255 caracteres")
    .optional()
    .or(z.literal("")),
  is_active: z.boolean()
    .optional()
});

// ===============================
// CONTROLADOR DE BANNERS
// ===============================

const bannerController = {
  // Obtener todos los banners
  getAll: async (req, res) => {
    try {
      const result = await db.query(
        "SELECT id, title, description, image_url, button_text, button_link, is_active, created_at FROM banners ORDER BY id DESC"
      );
      res.json(result.rows);
    } catch (error) {
      console.error("GET BANNERS ERROR:", {
        message: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
      res.status(500).json({ message: "Error al obtener banners" });
    }
  },

  // Obtener banner por ID
  getById: async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      
      if (isNaN(id) || id <= 0) {
        return res.status(400).json({ message: "ID inválido" });
      }

      const result = await db.query(
        "SELECT id, title, description, image_url, button_text, button_link, is_active, created_at FROM banners WHERE id = $1",
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ message: "Banner no encontrado" });
      }

      res.json(result.rows[0]);
    } catch (error) {
      console.error("GET BANNER ERROR:", {
        message: error.message,
        bannerId: req.params.id
      });
      res.status(500).json({ message: "Error al obtener el banner" });
    }
  },

  // Crear banner
  create: async (req, res) => {
    try {
      // Validar datos de entrada
      const validatedData = bannerCreateSchema.parse(req.body);
      
      // Validar que se haya subido una imagen
      if (!req.file) {
        return res.status(400).json({ message: "La imagen es requerida" });
      }

      const image_url = req.file.path;

      const result = await db.query(
        `INSERT INTO banners (title, description, image_url, button_text, button_link, is_active)
         VALUES ($1, $2, $3, $4, $5, true)
         RETURNING id, title, description, image_url, button_text, button_link, is_active, created_at`,
        [
          validatedData.title,
          validatedData.description,
          image_url,
          validatedData.button_text || null,
          validatedData.button_link || null
        ]
      );

      res.status(201).json({
        message: "Banner creado con éxito",
        banner: result.rows[0]
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          message: "Datos de entrada inválidos",
          errors: error.errors.map(e => ({
            field: e.path.join('.'),
            message: e.message
          }))
        });
      }

      console.error("CREATE BANNER ERROR:", {
        message: error.message,
        userId: req.user?.id
      });
      res.status(500).json({ message: "Error al crear banner" });
    }
  },

  // Actualizar banner
  update: async (req, res) => {
    const client = await db.connect();
    
    try {
      const id = parseInt(req.params.id);
      
      if (isNaN(id) || id <= 0) {
        return res.status(400).json({ message: "ID inválido" });
      }

      // Validar datos de entrada
      const validatedData = bannerUpdateSchema.parse(req.body);

      await client.query('BEGIN');

      // Verificar que el banner existe
      const existingBanner = await client.query(
        "SELECT id, image_url FROM banners WHERE id = $1",
        [id]
      );

      if (existingBanner.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ message: "Banner no encontrado" });
      }

      // Construir la consulta de actualización dinámicamente
      const updates = [];
      const values = [];
      let paramIndex = 1;

      if (validatedData.title !== undefined) {
        updates.push(`title = $${paramIndex++}`);
        values.push(validatedData.title);
      }

      if (validatedData.description !== undefined) {
        updates.push(`description = $${paramIndex++}`);
        values.push(validatedData.description);
      }

      if (validatedData.button_text !== undefined) {
        updates.push(`button_text = $${paramIndex++}`);
        values.push(validatedData.button_text || null);
      }

      if (validatedData.button_link !== undefined) {
        updates.push(`button_link = $${paramIndex++}`);
        values.push(validatedData.button_link || null);
      }

      if (validatedData.is_active !== undefined) {
        updates.push(`is_active = $${paramIndex++}`);
        values.push(validatedData.is_active);
      }

      if (req.file) {
        updates.push(`image_url = $${paramIndex++}`);
        values.push(req.file.path);
      }

      // Si no hay campos para actualizar
      if (updates.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: "No hay campos para actualizar" });
      }

      // Agregar el ID al final
      values.push(id);

      const query = `
        UPDATE banners
        SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
        WHERE id = $${paramIndex}
        RETURNING id, title, description, image_url, button_text, button_link, is_active, created_at, updated_at
      `;

      const result = await client.query(query, values);
      
      await client.query('COMMIT');

      res.json({
        message: "Banner actualizado con éxito",
        banner: result.rows[0]
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

      console.error("UPDATE BANNER ERROR:", {
        message: error.message,
        bannerId: req.params.id,
        userId: req.user?.id
      });
      res.status(500).json({ message: "Error al actualizar banner" });
    } finally {
      client.release();
    }
  },

  // Eliminar banner
  delete: async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      
      if (isNaN(id) || id <= 0) {
        return res.status(400).json({ message: "ID inválido" });
      }

      const result = await db.query(
        "DELETE FROM banners WHERE id = $1 RETURNING id",
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ message: "Banner no encontrado" });
      }

      res.json({ 
        message: "Banner eliminado con éxito",
        id: result.rows[0].id
      });
    } catch (error) {
      console.error("DELETE BANNER ERROR:", {
        message: error.message,
        bannerId: req.params.id,
        userId: req.user?.id
      });
      res.status(500).json({ message: "Error al eliminar banner" });
    }
  },

  // Activar/Desactivar banner
  toggleActive: async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      
      if (isNaN(id) || id <= 0) {
        return res.status(400).json({ message: "ID inválido" });
      }

      const result = await db.query(
        `UPDATE banners 
         SET is_active = NOT is_active, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING id, is_active`,
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ message: "Banner no encontrado" });
      }

      res.json({
        message: "Estado del banner actualizado",
        banner: result.rows[0]
      });
    } catch (error) {
      console.error("TOGGLE BANNER ERROR:", {
        message: error.message,
        bannerId: req.params.id,
        userId: req.user?.id
      });
      res.status(500).json({ message: "Error al cambiar estado del banner" });
    }
  }
};

module.exports = bannerController;