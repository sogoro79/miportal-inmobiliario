import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanupUploadedImages,
  deleteCloudinaryImages,
  getCloudinaryPublicIdFromUrl,
  getImageUploadErrorResponse,
  getUploadedImageUrls,
  InvalidExistingImagesError,
  MAX_FILES_PER_REQUEST,
  parseImagenesExistentes,
  validateExistingImageOwnership
} from "../utils/imageSecurity.js";

const ownUrlA = "https://res.cloudinary.com/demo/image/upload/v1700000000/miportal_inmobiliario/casa-a.jpg";
const ownUrlB = "https://res.cloudinary.com/demo/image/upload/c_limit,w_1200/miportal_inmobiliario/casa-b.webp";
const foreignUrl = "https://res.cloudinary.com/demo/image/upload/v1700000000/miportal_inmobiliario/otra-propiedad.jpg";

test("imagenesExistentes permite conservar URLs originales y elimina duplicados", () => {
  const parsed = parseImagenesExistentes(JSON.stringify([ownUrlA, ownUrlA, ownUrlB]));
  const valid = validateExistingImageOwnership(parsed, [ownUrlA, ownUrlB]);

  assert.deepEqual(valid, [ownUrlA, ownUrlB]);
});

test("imagenesExistentes ausente conserva las URLs originales por defecto", () => {
  const parsed = parseImagenesExistentes(undefined, { absentValue: [ownUrlA] });

  assert.deepEqual(parsed, [ownUrlA]);
});

test("imagenesExistentes permite arrays reales solo si contienen strings", () => {
  assert.deepEqual(parseImagenesExistentes([ownUrlA]), [ownUrlA]);
  assert.throws(() => parseImagenesExistentes([ownUrlA, 7]), InvalidExistingImagesError);
  assert.throws(() => parseImagenesExistentes([[ownUrlA]]), InvalidExistingImagesError);
  assert.throws(() => parseImagenesExistentes([{ url: ownUrlA }]), InvalidExistingImagesError);
});

test("imagenesExistentes rechaza JSON inválido y URLs no pertenecientes a la propiedad", () => {
  assert.throws(() => parseImagenesExistentes("{no-json"), InvalidExistingImagesError);
  assert.throws(() => parseImagenesExistentes(null), InvalidExistingImagesError);
  assert.throws(() => parseImagenesExistentes(""), InvalidExistingImagesError);
  assert.throws(() => parseImagenesExistentes("null"), InvalidExistingImagesError);
  assert.throws(() => parseImagenesExistentes("{}"), InvalidExistingImagesError);
  assert.throws(() => parseImagenesExistentes("\"texto\""), InvalidExistingImagesError);
  assert.throws(
    () => validateExistingImageOwnership([foreignUrl], [ownUrlA, ownUrlB]),
    InvalidExistingImagesError
  );
});

test("getUploadedImageUrls extrae únicamente rutas nuevas válidas", () => {
  assert.deepEqual(getUploadedImageUrls([{ path: ownUrlA }, {}, { path: "" }, { path: ownUrlB }]), [ownUrlA, ownUrlB]);
});

test("deriva public_id solo para URLs Cloudinary HTTPS de la carpeta esperada", () => {
  assert.equal(getCloudinaryPublicIdFromUrl(ownUrlA), "miportal_inmobiliario/casa-a");
  assert.equal(
    getCloudinaryPublicIdFromUrl("https://res.cloudinary.com/demo/image/upload/c_fill,w_1200,h_630,g_auto,q_auto,f_auto/v1700000000/miportal_inmobiliario/casa-a.jpg"),
    "miportal_inmobiliario/casa-a"
  );
  assert.equal(getCloudinaryPublicIdFromUrl("http://res.cloudinary.com/demo/image/upload/v1/miportal_inmobiliario/a.jpg"), null);
  assert.equal(getCloudinaryPublicIdFromUrl("https://example.com/demo/image/upload/v1/miportal_inmobiliario/a.jpg"), null);
  assert.equal(getCloudinaryPublicIdFromUrl("https://res.cloudinary.com/demo/image/upload/v1/otra_carpeta/a.jpg"), null);
  assert.equal(getCloudinaryPublicIdFromUrl("https://res.cloudinary.com/demo/image/upload/v1/miportal_inmobiliario/..%2Fa.jpg"), null);
  assert.equal(getCloudinaryPublicIdFromUrl("https://res.cloudinary.com/demo/raw/upload/v1/miportal_inmobiliario/a.jpg"), null);
});

test("deleteCloudinaryImages borra solo public_id válidos y no duplica llamadas", async () => {
  const destroyed = [];
  const result = await deleteCloudinaryImages([ownUrlA, ownUrlA, "https://example.com/a.jpg"], async publicId => {
    destroyed.push(publicId);
  });

  assert.deepEqual(destroyed, ["miportal_inmobiliario/casa-a"]);
  assert.equal(result.attempted, 1);
  assert.equal(result.failed, 0);
});

test("cleanup de subidas nuevas no sustituye el error original si falla Cloudinary", async () => {
  const originalError = new Error("validacion original");
  const result = await cleanupUploadedImages([ownUrlA], async () => {
    throw new Error("cloudinary no disponible");
  });

  assert.equal(result.attempted, 1);
  assert.equal(result.failed, 1);
  assert.equal(originalError.message, "validacion original");
});

test("las imágenes retiradas se calculan desde originales y se borran tras guardado correcto", async () => {
  const originales = [ownUrlA, ownUrlB];
  const conservadas = validateExistingImageOwnership(parseImagenesExistentes([ownUrlA]), originales);
  const retiradas = originales.filter(url => !new Set(conservadas).has(url));
  const destroyed = [];

  await deleteCloudinaryImages(retiradas, async publicId => destroyed.push(publicId));

  assert.deepEqual(retiradas, [ownUrlB]);
  assert.deepEqual(destroyed, ["miportal_inmobiliario/casa-b"]);
});

test("MAX_FILES_PER_REQUEST fija un límite técnico razonable", () => {
  assert.equal(MAX_FILES_PER_REQUEST, 30);
});

test("MulterError se traduce a códigos y mensajes controlados", () => {
  assert.deepEqual(
    getImageUploadErrorResponse({ code: "LIMIT_FILE_SIZE" }, { isMulterError: true }),
    { status: 413, message: "Una o varias imágenes superan el tamaño máximo permitido de 15 MB." }
  );
  assert.deepEqual(
    getImageUploadErrorResponse({ code: "LIMIT_FILE_COUNT" }, { isMulterError: true, maxFiles: 30 }),
    { status: 400, message: "No puedes subir más de 30 imágenes nuevas por petición." }
  );
  assert.deepEqual(
    getImageUploadErrorResponse({ code: "LIMIT_UNEXPECTED_FILE" }, { isMulterError: true }),
    { status: 400, message: "El campo de subida de imágenes no es válido." }
  );
  assert.deepEqual(
    getImageUploadErrorResponse({ code: "LIMIT_UNEXPECTED_FILE", field: "imagenes" }, { isMulterError: true, maxFiles: 30 }),
    { status: 400, message: "No puedes subir más de 30 imágenes nuevas por petición." }
  );
  assert.deepEqual(
    getImageUploadErrorResponse({ statusCode: 400, message: "Formato de imagen no permitido." }),
    { status: 400, message: "Formato de imagen no permitido." }
  );
});
