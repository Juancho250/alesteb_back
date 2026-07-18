class CloudinaryStorage {
  constructor({ cloudinary, params = {} }) {
    if (!cloudinary?.uploader?.upload_stream) {
      throw new TypeError("cloudinary.uploader.upload_stream es requerido");
    }
    this.cloudinary = cloudinary;
    this.params = params;
  }

  async resolveParams(req, file) {
    const value = typeof this.params === "function"
      ? await this.params(req, file)
      : this.params;
    const options = { ...(value || {}) };
    for (const key of ["folder", "public_id", "format", "resource_type"]) {
      if (options[key] === undefined || options[key] === null) continue;
      const text = String(options[key]);
      if (!/^[A-Za-z0-9_./:-]{1,240}$/.test(text) || text.includes("..")) {
        const err = new Error(`Parametro Cloudinary invalido: ${key}`);
        err.code = "CLOUDINARY_UPLOAD_PARAM_INVALID";
        throw err;
      }
      options[key] = text;
    }
    if (options.allowed_formats) {
      if (!Array.isArray(options.allowed_formats) || options.allowed_formats.some((item) => !/^[a-z0-9]{2,10}$/.test(String(item)))) {
        const err = new Error("allowed_formats de Cloudinary invalido");
        err.code = "CLOUDINARY_UPLOAD_PARAM_INVALID";
        throw err;
      }
    }
    return options;
  }

  _handleFile(req, file, callback) {
    this.resolveParams(req, file)
      .then((options) => {
        const upload = this.cloudinary.uploader.upload_stream(options, (error, result) => {
          if (error) return callback(error);
          return callback(null, {
            path: result.secure_url || result.url,
            filename: result.public_id,
            public_id: result.public_id,
            secure_url: result.secure_url || null,
            bytes: result.bytes || 0,
            format: result.format || null,
            width: result.width || null,
            height: result.height || null,
            resource_type: result.resource_type || options.resource_type || "image",
          });
        });
        file.stream.on("error", (error) => upload.destroy(error));
        file.stream.pipe(upload);
      })
      .catch(callback);
  }

  _removeFile(req, file, callback) {
    const publicId = file.public_id || file.filename;
    if (!publicId) return callback(null);
    this.cloudinary.uploader.destroy(
      publicId,
      { resource_type: file.resource_type || "image" },
      (error) => callback(error || null)
    );
  }
}

module.exports = { CloudinaryStorage };
