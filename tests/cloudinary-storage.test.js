import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Readable, Writable } from "node:stream";
import { CloudinaryServiceError } from "../utils/cloudinaryService.js";
import { createCloudinaryStreamStorage } from "../utils/cloudinaryStorage.js";

const cloudinaryUrl = "https://res.cloudinary.com/demo/image/upload/v1700000000/miportal_inmobiliario/storage-1.jpg";

function runHandleFile(storage, file) {
  return new Promise(resolve => {
    let calls = 0;
    storage._handleFile({}, file, (error, info) => {
      calls += 1;
      setImmediate(() => resolve({ error, info, calls }));
    });
  });
}

function runRemoveFile(storage, file) {
  return new Promise(resolve => {
    let calls = 0;
    storage._removeFile({}, file, error => {
      calls += 1;
      setImmediate(() => resolve({ error, calls }));
    });
  });
}

function createUploadClient({
  response = {
    secure_url: cloudinaryUrl,
    public_id: "miportal_inmobiliario/storage-1",
    bytes: 321
  },
  error,
  throwSync = false,
  captureOptions,
  onChunk
} = {}) {
  return {
    uploader: {
      upload_stream(options, callback) {
        if (throwSync) throw new Error("CLOUDINARY_API_SECRET=hidden");
        captureOptions?.(options);
        return new Writable({
          write(chunk, encoding, done) {
            onChunk?.(chunk);
            done();
          },
          final(done) {
            callback(error || null, response);
            done();
          }
        });
      },
      destroy: async () => ({ result: "ok" })
    }
  };
}

test("_handleFile sube el stream a Cloudinary y conserva el contrato req.files", async () => {
  const chunks = [];
  let optionsReceived;
  const storage = createCloudinaryStreamStorage({
    client: createUploadClient({
      captureOptions: options => {
        optionsReceived = options;
      },
      onChunk: chunk => chunks.push(chunk)
    })
  });

  const result = await runHandleFile(storage, {
    stream: Readable.from([Buffer.from("a"), Buffer.from("b")])
  });

  assert.equal(result.error, null);
  assert.equal(result.calls, 1);
  assert.deepEqual(chunks.map(chunk => chunk.toString()), ["a", "b"]);
  assert.deepEqual(result.info, {
    path: cloudinaryUrl,
    filename: "miportal_inmobiliario/storage-1",
    public_id: "miportal_inmobiliario/storage-1",
    secure_url: cloudinaryUrl,
    size: 321
  });
  assert.equal(optionsReceived.folder, "miportal_inmobiliario");
  assert.equal(optionsReceived.resource_type, "image");
  assert.deepEqual(optionsReceived.allowed_formats, ["jpg", "jpeg", "png", "webp"]);
  assert.equal(optionsReceived.public_id, undefined);
  assert.equal(optionsReceived.overwrite, undefined);
});

test("_handleFile no usa storage local ni buffers completos", () => {
  const source = fs.readFileSync(new URL("../utils/cloudinaryStorage.js", import.meta.url), "utf8");
  const forbiddenTerms = [
    "memory" + "Storage",
    "disk" + "Storage",
    "Buffer" + ".concat",
    "array" + "Buffer"
  ];

  for (const term of forbiddenTerms) {
    assert.equal(source.includes(term), false);
  }
  assert.match(source, /file\.stream/);
  assert.match(source, /upload_stream/);
});

test("_handleFile devuelve errores genéricos y llama al callback una sola vez", async () => {
  const remoteError = await runHandleFile(
    createCloudinaryStreamStorage({
      client: createUploadClient({
        error: new Error("CLOUDINARY_API_KEY=hidden")
      })
    }),
    { stream: Readable.from(["x"]) }
  );

  assert.equal(remoteError.calls, 1);
  assert.equal(remoteError.error instanceof CloudinaryServiceError, true);
  assert.equal(remoteError.error.message.includes("CLOUDINARY_API_KEY"), false);

  const syncError = await runHandleFile(
    createCloudinaryStreamStorage({
      client: createUploadClient({ throwSync: true })
    }),
    { stream: Readable.from(["x"]) }
  );

  assert.equal(syncError.calls, 1);
  assert.equal(syncError.error instanceof CloudinaryServiceError, true);
  assert.equal(syncError.error.message.includes("CLOUDINARY_API_SECRET"), false);
});

test("_handleFile controla stream abortado y respuesta incompleta", async () => {
  const aborted = await runHandleFile(
    createCloudinaryStreamStorage({
      client: createUploadClient()
    }),
    {
      stream: new Readable({
        read() {
          this.destroy(new Error("multipart aborted"));
        }
      })
    }
  );

  assert.equal(aborted.calls, 1);
  assert.equal(aborted.error instanceof CloudinaryServiceError, true);

  const incomplete = await runHandleFile(
    createCloudinaryStreamStorage({
      client: createUploadClient({
        response: { secure_url: cloudinaryUrl }
      })
    }),
    { stream: Readable.from(["x"]) }
  );

  assert.equal(incomplete.calls, 1);
  assert.equal(incomplete.error instanceof CloudinaryServiceError, true);
  assert.match(incomplete.error.message, /incompleta/);
});

test("_removeFile limpia solo public_id válido y no acepta URLs ni traversal", async () => {
  const destroyed = [];
  const storage = createCloudinaryStreamStorage({
    client: {
      uploader: {
        destroy: async (publicId, options) => {
          destroyed.push({ publicId, options });
          return { result: "not found" };
        }
      }
    }
  });

  const valid = await runRemoveFile(storage, {
    public_id: "miportal_inmobiliario/storage-1",
    path: cloudinaryUrl
  });
  const urlAsFilename = await runRemoveFile(storage, {
    filename: cloudinaryUrl
  });
  const traversal = await runRemoveFile(storage, {
    filename: "miportal_inmobiliario/../secret"
  });
  const absent = await runRemoveFile(storage, {});

  assert.equal(valid.error, null);
  assert.equal(urlAsFilename.error, null);
  assert.equal(traversal.error, null);
  assert.equal(absent.error, null);
  assert.equal(valid.calls, 1);
  assert.equal(urlAsFilename.calls, 1);
  assert.equal(traversal.calls, 1);
  assert.equal(absent.calls, 1);
  assert.deepEqual(destroyed, [{
    publicId: "miportal_inmobiliario/storage-1",
    options: { resource_type: "image" }
  }]);
});

test("_removeFile mantiene limpieza best effort si Cloudinary falla", async () => {
  const storage = createCloudinaryStreamStorage({
    client: {
      uploader: {
        destroy: async () => {
          throw new Error("cloudinary unavailable");
        }
      }
    }
  });

  const result = await runRemoveFile(storage, {
    filename: "miportal_inmobiliario/storage-1"
  });

  assert.equal(result.error, null);
  assert.equal(result.calls, 1);
});
