const CLOUDINARY_HOST = "res.cloudinary.com";
export const CLOUDINARY_IMAGE_FOLDER = "miportal_inmobiliario";
// Límite técnico por petición multipart; los límites comerciales se calculan por plan.
export const MAX_FILES_PER_REQUEST = 50;
const ALLOWED_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);

export class InvalidExistingImagesError extends Error {
  constructor(message = "Imágenes existentes no válidas") {
    super(message);
    this.name = "InvalidExistingImagesError";
    this.statusCode = 400;
  }
}

function normalizeIncomingExistingImages(value, { absentValue = [] } = {}) {
  if (value === undefined) return absentValue;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      throw new InvalidExistingImagesError();
    }
  }
  return value;
}

export function parseImagenesExistentes(value, options = {}) {
  const parsed = normalizeIncomingExistingImages(value, options);
  if (!Array.isArray(parsed)) throw new InvalidExistingImagesError();

  const deduped = [];
  const seen = new Set();
  for (const item of parsed) {
    if (typeof item !== "string" || !item) throw new InvalidExistingImagesError();
    if (seen.has(item)) continue;
    seen.add(item);
    deduped.push(item);
  }
  return deduped;
}

export function validateExistingImageOwnership(imagenesExistentes = [], imagenesOriginales = []) {
  const originales = new Set(imagenesOriginales);
  for (const url of imagenesExistentes) {
    if (!originales.has(url)) {
      throw new InvalidExistingImagesError("No se pueden conservar imágenes no autorizadas");
    }
  }
  return imagenesExistentes;
}

export function getUploadedImageUrls(files = []) {
  return (files || [])
    .map(file => file?.path)
    .filter(path => typeof path === "string" && path);
}

function isSafeCloudinaryPathSegment(segment) {
  return Boolean(segment) &&
    segment !== "." &&
    segment !== ".." &&
    !segment.includes("/") &&
    !segment.includes("\\");
}

export function getCloudinaryPublicIdFromUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:" || parsed.hostname !== CLOUDINARY_HOST) return null;

  const parts = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map(part => {
      try {
        return decodeURIComponent(part);
      } catch {
        return "";
      }
    });

  const uploadIndex = parts.indexOf("upload");
  if (uploadIndex < 2 || parts[uploadIndex - 1] !== "image") return null;

  const folderIndex = parts.indexOf(CLOUDINARY_IMAGE_FOLDER, uploadIndex + 1);
  if (folderIndex === -1 || folderIndex === parts.length - 1) return null;

  const publicPathParts = parts.slice(folderIndex);
  if (!publicPathParts.every(isSafeCloudinaryPathSegment)) return null;

  const fileName = publicPathParts[publicPathParts.length - 1];
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0) return null;

  const extension = fileName.slice(dotIndex + 1).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) return null;

  publicPathParts[publicPathParts.length - 1] = fileName.slice(0, dotIndex);
  if (!publicPathParts[publicPathParts.length - 1]) return null;

  return publicPathParts.join("/");
}

export async function deleteCloudinaryImages(urls = [], destroyFn) {
  const destroy = destroyFn || (async () => {});
  const publicIds = [...new Set(
    (urls || [])
      .map(getCloudinaryPublicIdFromUrl)
      .filter(Boolean)
  )];

  const results = await Promise.allSettled(publicIds.map(publicId => destroy(publicId)));
  const failed = results.filter(result => result.status === "rejected").length;
  if (failed > 0) {
    console.warn("No se pudieron limpiar algunas imágenes de Cloudinary:", { total: publicIds.length, failed });
  }

  return { attempted: publicIds.length, failed, results };
}

export async function cleanupUploadedImages(filesOrUrls = [], destroyFn) {
  const urls = Array.isArray(filesOrUrls) && filesOrUrls.some(item => typeof item !== "string")
    ? getUploadedImageUrls(filesOrUrls)
    : filesOrUrls;
  return deleteCloudinaryImages(urls, destroyFn);
}

export function getImageUploadErrorResponse(err, { isMulterError = false, maxFiles = MAX_FILES_PER_REQUEST } = {}) {
  const status = err?.code === "LIMIT_FILE_SIZE" ? 413 : (err?.statusCode || 400);
  let message = err?.message || "No se han podido subir las imágenes. Revisa el formato y vuelve a intentarlo.";

  if (isMulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      message = "Una o varias imágenes superan el tamaño máximo permitido de 15 MB.";
    } else if (err.code === "LIMIT_FILE_COUNT") {
      message = `No puedes subir más de ${maxFiles} imágenes nuevas por petición.`;
    } else if (err.code === "LIMIT_UNEXPECTED_FILE" && err.field === "imagenes") {
      message = `No puedes subir más de ${maxFiles} imágenes nuevas por petición.`;
    } else if (err.code === "LIMIT_UNEXPECTED_FILE") {
      message = "El campo de subida de imágenes no es válido.";
    } else {
      message = "No se han podido procesar las imágenes.";
    }
  }

  return { status, message };
}
