const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable, Writable } = require("node:stream");
const fs = require("node:fs");
const path = require("node:path");

const { CloudinaryStorage } = require("../middleware/cloudinaryStorage");

function fakeCloudinary() {
  const calls = { uploads: [], destroys: [] };
  return {
    calls,
    uploader: {
      upload_stream(options, callback) {
        const chunks = [];
        const stream = new Writable({
          write(chunk, encoding, done) {
            chunks.push(Buffer.from(chunk));
            done();
          },
        });
        stream.on("finish", () => {
          calls.uploads.push({ options, bytes: Buffer.concat(chunks).length });
          callback(null, {
            secure_url: "https://res.cloudinary.com/demo/image/upload/alesteb/test/asset.webp",
            public_id: options.public_id,
            bytes: Buffer.concat(chunks).length,
            format: options.format,
            width: 10,
            height: 10,
            resource_type: "image",
          });
        });
        return stream;
      },
      destroy(publicId, options, callback) {
        calls.destroys.push({ publicId, options });
        callback(null, { result: "ok" });
      },
    },
  };
}

test("local Cloudinary storage preserves Multer fields with validated parameters", async () => {
  const cloudinary = fakeCloudinary();
  const storage = new CloudinaryStorage({
    cloudinary,
    params: async () => ({
      folder: "alesteb/products",
      public_id: "asset-safe",
      format: "webp",
      transformation: [{ quality: "auto:good" }],
    }),
  });
  const file = { stream: Readable.from(Buffer.from("image-bytes")) };
  const result = await new Promise((resolve, reject) => {
    storage._handleFile({}, file, (error, value) => error ? reject(error) : resolve(value));
  });

  assert.equal(result.filename, "asset-safe");
  assert.equal(result.path.startsWith("https://res.cloudinary.com/"), true);
  assert.equal(cloudinary.calls.uploads[0].bytes, 11);
  assert.equal(cloudinary.calls.uploads[0].options.folder, "alesteb/products");
});

test("local Cloudinary storage rejects argument-injection characters", async () => {
  const cloudinary = fakeCloudinary();
  const storage = new CloudinaryStorage({
    cloudinary,
    params: { folder: "alesteb/products&notification_url=https://invalid.test", public_id: "asset" },
  });
  const file = { stream: Readable.from(Buffer.from("image")) };

  await assert.rejects(
    () => new Promise((resolve, reject) => {
      storage._handleFile({}, file, (error, value) => error ? reject(error) : resolve(value));
    }),
    { code: "CLOUDINARY_UPLOAD_PARAM_INVALID" }
  );
  assert.equal(cloudinary.calls.uploads.length, 0);
});

test("chat Cloudinary public id no longer embeds raw originalname", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/modules/chat/chat.controller.js"), "utf8");
  assert.match(source, /safeChatImageBaseName\(file\.originalname\)/);
  assert.doesNotMatch(source, /file\.originalname\.split/);
  assert.doesNotMatch(source, /multer-storage-cloudinary/);
});
