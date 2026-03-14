// src/middleware/upload_proof.middleware.js
// Middleware separado para comprobantes (carpeta distinta en Cloudinary)
const multer = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const cloudinary = require("../config/cloudinary");

const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder: "payment_proofs",
    allowed_formats: ["jpg", "jpeg", "png", "webp", "pdf"],
    public_id: `proof-${Date.now()}-${file.originalname.split(".")[0]}`
  }),
});

const uploadProof = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB para PDFs también
});

module.exports = uploadProof;