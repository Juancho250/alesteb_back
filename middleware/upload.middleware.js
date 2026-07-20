const multer = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const cloudinary = require("../config/cloudinary");

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

const sanitizeFileName = (value = "image") =>
  String(value)
    .replace(/\.[^/.]+$/, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "image";

function createUpload(folder = "general", maxSizeMB = 5) {
  const safeFolder = String(folder)
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "") || "general";

  const storage = new CloudinaryStorage({
    cloudinary,
    params: async (_req, file) => ({
      folder: `alesteb/${safeFolder}`,
      resource_type: "image",
      format: "webp",
      transformation: [
        { quality: "auto:good", fetch_format: "auto" },
      ],
      public_id: `${Date.now()}-${sanitizeFileName(file.originalname)}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,
    }),
  });

  return multer({
    storage,
    limits: {
      fileSize: maxSizeMB * 1024 * 1024,
      files: 1,
    },
    fileFilter: (_req, file, cb) => {
      if (ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
        cb(null, true);
        return;
      }

      cb(
        new Error(
          `Formato no soportado: ${file.mimetype}. Usa JPG, PNG, WebP, GIF o AVIF.`
        )
      );
    },
  });
}

const uploadProduct = createUpload("products");
const uploadBanner = createUpload("banners", 10);
const uploadBundle = createUpload("bundles");
const uploadAvatar = createUpload("avatars", 2);
const upload = createUpload("misc");

module.exports = {
  createUpload,
  upload,
  uploadProduct,
  uploadBanner,
  uploadBundle,
  uploadAvatar,
};