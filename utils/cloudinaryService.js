import { v2 as defaultCloudinary } from "cloudinary";
import {
  CLOUDINARY_IMAGE_FOLDER,
  getCloudinaryPublicIdFromUrl
} from "./imageSecurity.js";

export const CLOUDINARY_ALLOWED_FORMATS = ["jpg", "jpeg", "png", "webp"];
export const CLOUDINARY_UPLOAD_TRANSFORMATION = [
  { width: 1200, crop: "limit" },
  {
    overlay: "homeclick24_watermark",
    width: 400,
    crop: "scale",
    opacity: 70,
    gravity: "south_east",
    x: 30,
    y: 30,
    flags: "layer_apply"
  }
];

export const CLOUDINARY_UPLOAD_OPTIONS = Object.freeze({
  folder: CLOUDINARY_IMAGE_FOLDER,
  allowed_formats: CLOUDINARY_ALLOWED_FORMATS,
  resource_type: "image",
  transformation: CLOUDINARY_UPLOAD_TRANSFORMATION
});

const configuredClients = new WeakSet();

export class CloudinaryServiceError extends Error {
  constructor(message = "Error procesando imagen") {
    super(message);
    this.name = "CloudinaryServiceError";
  }
}

function getClient(client = defaultCloudinary) {
  return client;
}

function isValidPublicId(publicId) {
  if (typeof publicId !== "string" || !publicId.trim()) return false;
  const value = publicId.trim();
  if (!value.startsWith(`${CLOUDINARY_IMAGE_FOLDER}/`)) return false;
  return value
    .split("/")
    .every(segment => segment && segment !== "." && segment !== ".." && !segment.includes("\\"));
}

function normalizeUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  const trimmed = value.trim();
  return getCloudinaryPublicIdFromUrl(trimmed) ? trimmed : "";
}

export function configureCloudinary({
  client = defaultCloudinary,
  env = process.env
} = {}) {
  const cloudinaryClient = getClient(client);
  if (configuredClients.has(cloudinaryClient)) return cloudinaryClient;

  cloudinaryClient.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET
  });
  configuredClients.add(cloudinaryClient);
  return cloudinaryClient;
}

export function normalizeUploadedFile(file) {
  const url = normalizeUrl(file?.path || file?.secure_url || file?.url);
  if (!url) {
    throw new CloudinaryServiceError("Imagen subida sin URL válida");
  }

  const publicId = [
    file?.publicId,
    file?.public_id,
    file?.filename,
    getCloudinaryPublicIdFromUrl(url)
  ].find(isValidPublicId);

  if (!isValidPublicId(publicId)) {
    throw new CloudinaryServiceError("Imagen subida sin identificador válido");
  }

  return { url, publicId };
}

export function normalizeUploadedFiles(files = []) {
  return (files || []).map(normalizeUploadedFile);
}

export async function destroyByPublicId(publicId, {
  client = defaultCloudinary
} = {}) {
  if (!isValidPublicId(publicId)) {
    throw new CloudinaryServiceError("Identificador de imagen no válido");
  }

  const result = await getClient(client).uploader.destroy(publicId.trim(), {
    resource_type: "image"
  });

  return {
    publicId: publicId.trim(),
    ok: result?.result === "ok" || result?.result === "not found",
    result: result?.result || "unknown"
  };
}

export async function destroyImagesByUrls(urls = [], {
  client = defaultCloudinary
} = {}) {
  const total = Array.isArray(urls) ? urls.length : 0;
  const publicIds = [...new Set(
    (urls || [])
      .map(getCloudinaryPublicIdFromUrl)
      .filter(isValidPublicId)
  )];

  const results = await Promise.allSettled(
    publicIds.map(publicId => destroyByPublicId(publicId, { client }))
  );
  const deleted = results.filter(result =>
    result.status === "fulfilled" && result.value?.result === "ok"
  ).length;
  const failed = results.filter(result =>
    result.status === "rejected" ||
    (result.status === "fulfilled" && result.value?.ok !== true)
  ).length;
  const skipped = Math.max(0, total - publicIds.length);

  if (failed > 0) {
    console.warn("No se pudieron limpiar algunas imágenes de Cloudinary:", {
      total,
      attempted: publicIds.length,
      failed
    });
  }

  return { total, attempted: publicIds.length, deleted, skipped, failed, results };
}

export function uploadBuffer(buffer, {
  client = defaultCloudinary
} = {}) {
  if (!Buffer.isBuffer(buffer)) {
    return Promise.reject(new CloudinaryServiceError("La imagen debe recibirse como Buffer"));
  }
  if (buffer.length === 0) {
    return Promise.reject(new CloudinaryServiceError("La imagen no puede estar vacía"));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const succeed = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let stream;
    try {
      stream = getClient(client).uploader.upload_stream(
        { ...CLOUDINARY_UPLOAD_OPTIONS },
        (error, result) => {
          if (error) {
            fail(new CloudinaryServiceError("No se pudo subir la imagen"));
            return;
          }

          if (!result?.secure_url || !result?.public_id) {
            fail(new CloudinaryServiceError("Cloudinary devolvió una imagen incompleta"));
            return;
          }

          succeed({
            url: result.secure_url,
            publicId: result.public_id
          });
        }
      );
    } catch {
      fail(new CloudinaryServiceError("No se pudo preparar la subida de la imagen"));
      return;
    }

    stream.on?.("error", () => {
      fail(new CloudinaryServiceError("No se pudo subir la imagen"));
    });

    try {
      stream.end(buffer);
    } catch {
      fail(new CloudinaryServiceError("No se pudo subir la imagen"));
    }
  });
}
