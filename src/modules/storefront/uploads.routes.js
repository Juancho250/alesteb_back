"use strict";

const { auth } = require("../identity/auth");
const {
  createUpload,
} = require("../../../middleware/upload.middleware");

const uploadStorefront = createUpload(
  "storefront",
  5
);

function uploadStorefrontImage(req, res) {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: "No se recibió ningún archivo",
      code: "NO_FILE",
    });
  }

  return res.json({
    success: true,
    data: {
      url: req.file.path,
      public_id: req.file.filename,
    },
  });
}

function registerUploadRoutes(router) {
  if (
    !router ||
    typeof router.post !== "function"
  ) {
    throw new TypeError(
      "registerUploadRoutes requiere un router Express válido"
    );
  }

  router.post(
    "/upload",
    auth,
    uploadStorefront.single("image"),
    uploadStorefrontImage
  );
}

module.exports = Object.freeze({
  registerUploadRoutes,
  uploadStorefrontImage,
});