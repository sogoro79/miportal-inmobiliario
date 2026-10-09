import { fetchPublicResource, FeedFetchError } from "./feedFetcher.js";

export const MAX_IMPORT_IMAGE_BYTES = 8 * 1024 * 1024;

export function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length > 3 && buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && buffer.toString("ascii", 12, 16) === "IHDR") return "image/png";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

export async function fetchImportImage(url, options = {}) {
  const result = await fetchPublicResource(url, { ...options, binary: true, maxBytes: MAX_IMPORT_IMAGE_BYTES });
  const mime = detectImageMime(result.xml);
  const declared = String(result.headers?.["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (!mime || (declared && declared !== "application/octet-stream" && declared !== mime)) {
    throw new FeedFetchError("Formato de imagen no permitido o imagen dañada.", "IMAGE_INVALID");
  }
  return result.xml;
}
