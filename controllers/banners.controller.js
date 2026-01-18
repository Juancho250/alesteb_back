const db = require("../config/db");
const cloudinary = require("../config/cloudinary");

const bannerController = {
  // Obtener todos los banners
  getAll: (req, res) => {
    db.all("SELECT * FROM banners ORDER BY id DESC", [], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
  },

  // Crear un nuevo banner con subida a Cloudinary
  create: async (req, res) => {
    const { title, description, button_text, button_link } = req.body;
    let image_url = "";

    try {
      if (req.file) {
        // req.file viene del middleware de upload
        image_url = req.file.path; 
      }

      const sql = `INSERT INTO banners (title, description, image_url, button_text, button_link) 
                   VALUES (?, ?, ?, ?, ?)`;
      
      db.run(sql, [title, description, image_url, button_text, button_link], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID, message: "Banner creado con éxito" });
      });
    } catch (error) {
      res.status(500).json({ error: "Error al procesar la imagen" });
    }
  },

  // Actualizar banner (incluyendo lógica para cambiar imagen)
  update: async (req, res) => {
    const { id } = req.params;
    const { title, description, button_text, button_link, is_active } = req.body;
    
    // Si hay una nueva imagen, se actualiza la URL
    let sql = "UPDATE banners SET title = ?, description = ?, button_text = ?, button_link = ?, is_active = ? WHERE id = ?";
    let params = [title, description, button_text, button_link, is_active, id];

    if (req.file) {
      sql = "UPDATE banners SET title = ?, description = ?, button_text = ?, button_link = ?, is_active = ?, image_url = ? WHERE id = ?";
      params = [title, description, button_text, button_link, is_active, req.file.path, id];
    }

    db.run(sql, params, (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: "Banner actualizado" });
    });
  },

  // Eliminar banner
  delete: (req, res) => {
    const { id } = req.params;
    db.run("DELETE FROM banners WHERE id = ?", id, (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: "Banner eliminado" });
    });
  }
};

module.exports = bannerController;