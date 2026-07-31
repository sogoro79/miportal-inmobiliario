import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Writable } from "node:stream";
import {
  CLOUDINARY_UPLOAD_OPTIONS,
  CloudinaryServiceError,
  configureCloudinary,
  destroyByPublicId,
  destroyImagesByUrls,
  normalizeUploadedFile,
  normalizeUploadedFiles,
  uploadBuffer
} from "../utils/cloudinaryService.js";

const cloudinaryUrl = "https://res.cloudinary.com/demo/image/upload/v1700000000/miportal_inmobiliario/casa-1.jpg";
const limpiarCloudinaryJs = fs.readFileSync(new URL("../limpiar-cloudinary.js", import.meta.url), "utf8");

function createUploadClient({ response, error, captureOptions }) {
  return {
    uploader: {
      upload_stream(options, callback) {
        captureOptions?.(options);
        return new Writable({
          write(chunk, encoding, done) {
            done();
          },
          final(done) {
            callback(error || null, response);
            done();
          }
        });
      }
    }
  };
}

test("normalizeUploadedFile soporta el objeto actual de CloudinaryStorage", () => {
  assert.deepEqual(
    normalizeUploadedFile({
      path: cloudinaryUrl,
      filename: "miportal_inmobiliario/casa-1"
    }),
    {
      url: cloudinaryUrl,
      publicId: "miportal_inmobiliario/casa-1"
    }
  );
});

test("configureCloudinary usa solo variables Cloudinary y es idempotente por cliente", () => {
  const llamadas = [];
  const client = {
    config(options) {
      llamadas.push(options);
    }
  };

  const env = {
    CLOUDINARY_CLOUD_NAME: "cloud",
    CLOUDINARY_API_KEY: "key",
    CLOUDINARY_API_SECRET: "secret",
    OTRA_VARIABLE: "no"
  };

  assert.equal(configureCloudinary({ client, env }), client);
  assert.equal(configureCloudinary({ client, env }), client);

  assert.deepEqual(llamadas, [{
    cloud_name: "cloud",
    api_key: "key",
    api_secret: "secret"
  }]);
});

test("normalizeUploadedFile rechaza archivos sin URL segura", () => {
  assert.throws(
    () => normalizeUploadedFile({ filename: "miportal_inmobiliario/casa-1" }),
    CloudinaryServiceError
  );
  assert.throws(
    () => normalizeUploadedFile({
      path: "http://res.cloudinary.com/demo/image/upload/v1/miportal_inmobiliario/casa-1.jpg",
      filename: "miportal_inmobiliario/casa-1"
    }),
    CloudinaryServiceError
  );
});

test("normalizeUploadedFile conserva file.path aunque filename local no sea public_id", () => {
  assert.deepEqual(
    normalizeUploadedFile({
      path: cloudinaryUrl,
      filename: "foto-local.jpg"
    }),
    {
      url: cloudinaryUrl,
      publicId: "miportal_inmobiliario/casa-1"
    }
  );
});

test("normalizeUploadedFiles normaliza varios archivos", () => {
  const files = normalizeUploadedFiles([
    { path: cloudinaryUrl, filename: "miportal_inmobiliario/casa-1" },
    {
      secure_url: "https://res.cloudinary.com/demo/image/upload/v1700000000/miportal_inmobiliario/casa-2.webp",
      public_id: "miportal_inmobiliario/casa-2"
    }
  ]);

  assert.deepEqual(files.map(file => file.url), [
    cloudinaryUrl,
    "https://res.cloudinary.com/demo/image/upload/v1700000000/miportal_inmobiliario/casa-2.webp"
  ]);
  assert.deepEqual(files.map(file => file.publicId), [
    "miportal_inmobiliario/casa-1",
    "miportal_inmobiliario/casa-2"
  ]);
  assert.deepEqual(normalizeUploadedFiles([]), []);
  assert.throws(() => normalizeUploadedFiles([null]), CloudinaryServiceError);
});

test("uploadBuffer convierte upload_stream en Promise y usa opciones internas", async () => {
  let opcionesRecibidas;
  const client = createUploadClient({
    captureOptions: options => {
      opcionesRecibidas = options;
    },
    response: {
      secure_url: cloudinaryUrl,
      public_id: "miportal_inmobiliario/casa-1"
    }
  });

  const result = await uploadBuffer(Buffer.from("imagen"), {
    client,
    folder: "otra_carpeta",
    transformation: [{ width: 1 }],
    public_id: "inyectado",
    resource_type: "raw"
  });

  assert.deepEqual(result, {
    url: cloudinaryUrl,
    publicId: "miportal_inmobiliario/casa-1"
  });
  assert.equal(opcionesRecibidas.folder, "miportal_inmobiliario");
  assert.equal(opcionesRecibidas.resource_type, "image");
  assert.deepEqual(opcionesRecibidas.allowed_formats, ["jpg", "jpeg", "png", "webp"]);
  assert.deepEqual(opcionesRecibidas.transformation, CLOUDINARY_UPLOAD_OPTIONS.transformation);
  assert.equal(opcionesRecibidas.public_id, undefined);
});

test("uploadBuffer rechaza respuestas incompletas y errores sin exponer secretos", async () => {
  await assert.rejects(
    uploadBuffer("imagen"),
    /Buffer/
  );
  await assert.rejects(
    uploadBuffer(Buffer.alloc(0)),
    /vacía/
  );
  await assert.rejects(
    uploadBuffer(Buffer.from("imagen"), {
      client: createUploadClient({ response: { secure_url: cloudinaryUrl } })
    }),
    /Cloudinary devolvió una imagen incompleta/
  );

  await assert.rejects(
    uploadBuffer(Buffer.from("imagen"), {
      client: createUploadClient({
        error: new Error("CLOUDINARY_API_KEY=abc CLOUDINARY_API_SECRET=def")
      })
    }),
    error => {
      assert.equal(error instanceof CloudinaryServiceError, true);
      assert.equal(error.message.includes("CLOUDINARY_API_KEY"), false);
      assert.equal(error.message.includes("CLOUDINARY_API_SECRET"), false);
      return true;
    }
  );
});

test("uploadBuffer controla errores síncronos al crear el stream", async () => {
  await assert.rejects(
    uploadBuffer(Buffer.from("imagen"), {
      client: {
        uploader: {
          upload_stream() {
            throw new Error("CLOUDINARY_API_SECRET=def");
          }
        }
      }
    }),
    error => {
      assert.equal(error instanceof CloudinaryServiceError, true);
      assert.equal(error.message.includes("CLOUDINARY_API_SECRET"), false);
      return true;
    }
  );
});

test("destroyByPublicId solo acepta public_id válido y usa resource_type image", async () => {
  let recibido;
  const client = {
    uploader: {
      destroy: async (publicId, options) => {
        recibido = { publicId, options };
        return { result: "not found" };
      }
    }
  };

  await assert.rejects(
    destroyByPublicId("../secreto", { client }),
    CloudinaryServiceError
  );

  const result = await destroyByPublicId("miportal_inmobiliario/casa-1", { client });

  assert.equal(result.ok, true);
  assert.equal(result.result, "not found");
  assert.deepEqual(recibido, {
    publicId: "miportal_inmobiliario/casa-1",
    options: { resource_type: "image" }
  });
});

test("destroyByPublicId distingue ok, error remoto y resultado inesperado", async () => {
  const okClient = {
    uploader: {
      destroy: async () => ({ result: "ok" })
    }
  };
  const unexpectedClient = {
    uploader: {
      destroy: async () => ({ result: "queued" })
    }
  };
  const failingClient = {
    uploader: {
      destroy: async () => {
        throw new Error("fallo remoto");
      }
    }
  };

  assert.deepEqual(
    await destroyByPublicId("miportal_inmobiliario/casa-1", { client: okClient }),
    { publicId: "miportal_inmobiliario/casa-1", ok: true, result: "ok" }
  );
  assert.deepEqual(
    await destroyByPublicId("miportal_inmobiliario/casa-1", { client: unexpectedClient }),
    { publicId: "miportal_inmobiliario/casa-1", ok: false, result: "queued" }
  );
  await assert.rejects(
    destroyByPublicId("miportal_inmobiliario/casa-1", { client: failingClient }),
    /fallo remoto/
  );
});

test("destroyImagesByUrls usa allSettled y no lanza por fallo parcial", async () => {
  const destruidos = [];
  const client = {
    uploader: {
      destroy: async publicId => {
        destruidos.push(publicId);
        if (publicId.endsWith("casa-2")) throw new Error("fallo remoto");
        return { result: "ok" };
      }
    }
  };

  const resumen = await destroyImagesByUrls([
    cloudinaryUrl,
    "https://res.cloudinary.com/demo/image/upload/v1700000000/miportal_inmobiliario/casa-2.webp",
    "https://example.com/no.jpg"
  ], { client });

  assert.deepEqual(destruidos, [
    "miportal_inmobiliario/casa-1",
    "miportal_inmobiliario/casa-2"
  ]);
  assert.equal(resumen.attempted, 2);
  assert.equal(resumen.deleted, 1);
  assert.equal(resumen.skipped, 1);
  assert.equal(resumen.failed, 1);
  assert.equal(resumen.results.some(result => result.status === "rejected"), true);
});

test("limpiar-cloudinary requiere ejecución explícita y usa public_id directo para destruir", () => {
  assert.match(limpiarCloudinaryJs, /export async function limpiarCloudinary/);
  assert.match(limpiarCloudinaryJs, /fileURLToPath\(import\.meta\.url\) === process\.argv\[1\]/);
  assert.match(limpiarCloudinaryJs, /getCloudinaryPublicIdFromUrl\(url\)/);
  assert.match(limpiarCloudinaryJs, /destroyByPublicId\(recurso\.public_id/);
});
