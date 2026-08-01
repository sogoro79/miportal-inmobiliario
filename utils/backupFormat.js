import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, stat } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { createGunzip } from "node:zlib";

export const DEFAULT_BACKUP_LIMITS = Object.freeze({
  maxCompressedBytes: 50 * 1024 * 1024,
  maxUncompressedBytes: 250 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxCollectionNameLength: 120,
  maxDepth: 40,
  maxInspectedProperties: 1_000_000,
  maxTotalDocuments: 1_000_000,
  maxDocumentsPerCollection: 500_000,
});

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const COLLECTION_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
const BACKUP_FILE_NAME_PATTERN = /^[A-Za-z0-9._-]+\.json\.gz$/;

export class BackupValidationError extends Error {
  constructor(message, { code = "BACKUP_INVALID" } = {}) {
    super(message);
    this.name = "BackupValidationError";
    this.code = code;
  }
}

function backupError(message, code) {
  return new BackupValidationError(message, { code });
}

function mergeLimits(limits = {}) {
  return { ...DEFAULT_BACKUP_LIMITS, ...limits };
}

function isPlainObject(value) {
  if (value === null || Array.isArray(value) || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function formatBytes(bytes) {
  return `${bytes} bytes`;
}

export function assertSafeCollectionName(name, { maxLength = DEFAULT_BACKUP_LIMITS.maxCollectionNameLength } = {}) {
  if (typeof name !== "string" || name.length === 0) {
    throw backupError("El nombre de colección no puede estar vacío.", "INVALID_COLLECTION");
  }
  if (name.length > maxLength) {
    throw backupError(`El nombre de colección supera ${maxLength} caracteres.`, "INVALID_COLLECTION");
  }
  if (DANGEROUS_KEYS.has(name)) {
    throw backupError(`Nombre de colección no permitido: ${name}.`, "DANGEROUS_KEY");
  }
  if (name.startsWith("system.")) {
    throw backupError(`No se permite validar colecciones internas: ${name}.`, "INVALID_COLLECTION");
  }
  if (/[\u0000-\u001F\u007F]/u.test(name)) {
    throw backupError("El nombre de colección contiene caracteres de control.", "INVALID_COLLECTION");
  }
  if (!COLLECTION_NAME_PATTERN.test(name)) {
    throw backupError(`Nombre de colección no seguro: ${name}.`, "INVALID_COLLECTION");
  }
  return name;
}

export function parseExpectedCollections(value, { limits = {} } = {}) {
  if (value === undefined || value === null) return [];
  if (typeof value !== "string") {
    throw backupError("La lista --expect debe ser texto separado por comas.", "INVALID_EXPECTED_COLLECTIONS");
  }

  const parts = value.split(",").map(part => part.trim());
  if (parts.some(part => part.length === 0)) {
    throw backupError("--expect no puede contener valores vacíos.", "INVALID_EXPECTED_COLLECTIONS");
  }

  const parsed = [];
  const seen = new Set();
  const activeLimits = mergeLimits(limits);
  for (const part of parts) {
    assertSafeCollectionName(part, { maxLength: activeLimits.maxCollectionNameLength });
    if (seen.has(part)) {
      throw backupError(`Colección duplicada en --expect: ${part}.`, "INVALID_EXPECTED_COLLECTIONS");
    }
    seen.add(part);
    parsed.push(part);
  }
  return parsed;
}

async function validateBackupPath(filePath, limits) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw backupError("Debes indicar la ruta del archivo de backup.", "FILE_NOT_FOUND");
  }

  const resolvedPath = path.resolve(filePath);
  const baseName = path.basename(resolvedPath);
  if (!baseName.endsWith(".json.gz")) {
    throw backupError("El archivo debe terminar exactamente en .json.gz.", "INVALID_EXTENSION");
  }
  if (baseName.length > 180 || !BACKUP_FILE_NAME_PATTERN.test(baseName)) {
    throw backupError("El nombre del archivo de backup no es seguro.", "INVALID_EXTENSION");
  }

  let linkStats;
  try {
    linkStats = await lstat(resolvedPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw backupError("El archivo de backup no existe.", "FILE_NOT_FOUND");
    }
    throw error;
  }

  if (linkStats.isSymbolicLink()) {
    throw backupError("No se aceptan enlaces simbólicos para validar backups.", "INVALID_FILE_TYPE");
  }
  if (!linkStats.isFile()) {
    throw backupError("La ruta indicada no es un archivo regular.", "INVALID_FILE_TYPE");
  }

  const fileStats = await stat(resolvedPath);
  if (fileStats.size === 0) {
    throw backupError("El archivo de backup está vacío.", "FILE_TOO_LARGE");
  }
  if (fileStats.size > limits.maxCompressedBytes) {
    throw backupError(
      `El archivo comprimido supera el máximo permitido (${formatBytes(limits.maxCompressedBytes)}).`,
      "FILE_TOO_LARGE"
    );
  }

  return {
    path: resolvedPath,
    name: baseName,
    compressedBytes: fileStats.size,
  };
}

export async function calculateFileSha256(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const input = createReadStream(filePath);
    input.on("data", chunk => hash.update(chunk));
    input.on("error", reject);
    input.on("end", resolve);
  });
  return hash.digest("hex");
}

async function readGzipJsonText(fileInfo, limits) {
  const chunks = [];
  let uncompressedBytes = 0;

  await new Promise((resolve, reject) => {
    let settled = false;
    const input = createReadStream(fileInfo.path);
    const gunzip = createGunzip();

    const finish = error => {
      if (settled) return;
      settled = true;
      input.destroy();
      gunzip.destroy();
      if (error) reject(error);
      else resolve();
    };

    input.on("error", error => finish(error));
    gunzip.on("error", () => finish(backupError("El gzip no se pudo descomprimir.", "INVALID_GZIP")));
    gunzip.on("data", chunk => {
      uncompressedBytes += chunk.length;
      if (uncompressedBytes > limits.maxUncompressedBytes) {
        finish(backupError(
          `El backup descomprimido supera el máximo permitido (${formatBytes(limits.maxUncompressedBytes)}).`,
          "UNCOMPRESSED_LIMIT_EXCEEDED"
        ));
        return;
      }

      const ratio = uncompressedBytes / fileInfo.compressedBytes;
      if (ratio > limits.maxCompressionRatio) {
        finish(backupError("El ratio de descompresión supera el límite permitido.", "COMPRESSION_RATIO_EXCEEDED"));
        return;
      }

      chunks.push(chunk);
    });
    gunzip.on("end", () => finish());

    input.pipe(gunzip);
  });

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text;
  try {
    text = decoder.decode(Buffer.concat(chunks, uncompressedBytes));
  } catch {
    throw backupError("El JSON descomprimido no es UTF-8 válido.", "INVALID_JSON");
  }

  return { text, uncompressedBytes };
}

function validateDangerousKeys(value, limits) {
  const stack = [{ value, depth: 0 }];
  let inspectedProperties = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (current.depth > limits.maxDepth) {
      throw backupError(`La estructura supera la profundidad máxima (${limits.maxDepth}).`, "DEPTH_LIMIT_EXCEEDED");
    }

    if (Array.isArray(current.value)) {
      for (const item of current.value) {
        if (item && typeof item === "object") {
          stack.push({ value: item, depth: current.depth + 1 });
        }
      }
      continue;
    }

    if (!current.value || typeof current.value !== "object") continue;

    const keys = Object.keys(current.value);
    inspectedProperties += keys.length;
    if (inspectedProperties > limits.maxInspectedProperties) {
      throw backupError(
        `La estructura supera el máximo de propiedades inspeccionadas (${limits.maxInspectedProperties}).`,
        "PROPERTY_LIMIT_EXCEEDED"
      );
    }

    for (const key of keys) {
      if (DANGEROUS_KEYS.has(key)) {
        throw backupError(`Clave peligrosa detectada: ${key}.`, "DANGEROUS_KEY");
      }
      const child = current.value[key];
      if (child && typeof child === "object") {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
}

export function validateBackupStructure(data, { expectedCollections = [], limits = {}, strictIds = false } = {}) {
  const activeLimits = mergeLimits(limits);

  if (!isPlainObject(data)) {
    throw backupError("La raíz del backup debe ser un objeto JSON plano.", "INVALID_ROOT");
  }

  const names = Object.keys(data);
  if (names.length === 0) {
    throw backupError("El backup no contiene colecciones.", "INVALID_ROOT");
  }

  validateDangerousKeys(data, activeLimits);

  const expected = Array.isArray(expectedCollections)
    ? expectedCollections
    : parseExpectedCollections(expectedCollections, { limits: activeLimits });
  const expectedSet = new Set(expected);
  for (const expectedName of expected) {
    assertSafeCollectionName(expectedName, { maxLength: activeLimits.maxCollectionNameLength });
    if (!Object.prototype.hasOwnProperty.call(data, expectedName)) {
      throw backupError(`Falta la colección esperada: ${expectedName}.`, "MISSING_EXPECTED_COLLECTION");
    }
  }

  let totalDocuments = 0;
  const warnings = [];
  const collections = names
    .sort((a, b) => a.localeCompare(b))
    .map(name => {
      assertSafeCollectionName(name, { maxLength: activeLimits.maxCollectionNameLength });
      const documents = data[name];
      if (!Array.isArray(documents)) {
        throw backupError(`La colección ${name} debe ser un array.`, "INVALID_COLLECTION");
      }
      if (documents.length > activeLimits.maxDocumentsPerCollection) {
        throw backupError(
          `La colección ${name} supera ${activeLimits.maxDocumentsPerCollection} documentos.`,
          "DOCUMENT_LIMIT_EXCEEDED"
        );
      }

      let documentsWithoutId = 0;
      for (const document of documents) {
        if (!isPlainObject(document)) {
          throw backupError(`La colección ${name} contiene un documento no válido.`, "INVALID_DOCUMENT");
        }
        if (!Object.prototype.hasOwnProperty.call(document, "_id")) {
          documentsWithoutId += 1;
        }
      }

      totalDocuments += documents.length;
      if (totalDocuments > activeLimits.maxTotalDocuments) {
        throw backupError(
          `El backup supera ${activeLimits.maxTotalDocuments} documentos en total.`,
          "DOCUMENT_LIMIT_EXCEEDED"
        );
      }
      if (documentsWithoutId > 0) {
        const message = `${name}: ${documentsWithoutId} documento(s) sin _id.`;
        if (strictIds || expectedSet.has(name)) {
          warnings.push(message);
        } else {
          warnings.push(message);
        }
      }

      return {
        name,
        documents: documents.length,
        documentsWithoutId,
      };
    });

  if (strictIds && collections.some(collection => collection.documentsWithoutId > 0)) {
    throw backupError("Hay documentos sin _id y el modo estricto está activo.", "MISSING_DOCUMENT_ID");
  }

  return {
    valid: true,
    collections,
    totalDocuments,
    warnings,
  };
}

export function sanitizeBackupSummary(summary) {
  return {
    valid: summary.valid === true,
    file: summary.file ? {
      name: summary.file.name,
      compressedBytes: summary.file.compressedBytes,
      uncompressedBytes: summary.file.uncompressedBytes,
      compressionRatio: summary.file.compressionRatio,
      sha256: summary.file.sha256,
    } : undefined,
    collections: (summary.collections || []).map(collection => ({
      name: collection.name,
      documents: collection.documents,
      documentsWithoutId: collection.documentsWithoutId,
    })),
    totalDocuments: summary.totalDocuments || 0,
    warnings: [...(summary.warnings || [])],
  };
}

export async function validateBackupFile(filePath, { expectedCollections, limits = {}, strictIds = false } = {}) {
  const activeLimits = mergeLimits(limits);
  const fileInfo = await validateBackupPath(filePath, activeLimits);
  const sha256 = await calculateFileSha256(fileInfo.path);
  const { text, uncompressedBytes } = await readGzipJsonText(fileInfo, activeLimits);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw backupError("El contenido descomprimido no es JSON válido.", "INVALID_JSON");
  }

  const structure = validateBackupStructure(parsed, {
    expectedCollections,
    limits: activeLimits,
    strictIds,
  });
  const compressionRatio = Number((uncompressedBytes / fileInfo.compressedBytes).toFixed(2));

  return sanitizeBackupSummary({
    valid: true,
    file: {
      name: fileInfo.name,
      path: fileInfo.path,
      compressedBytes: fileInfo.compressedBytes,
      uncompressedBytes,
      compressionRatio,
      sha256,
    },
    ...structure,
  });
}
