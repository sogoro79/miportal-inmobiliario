import mongoose from "mongoose";

import {
  BackupValidationError,
  readValidatedBackupPayload,
} from "./backupFormat.js";

export const DEFAULT_RESTORE_BATCH_SIZE = 500;
export const MAX_RESTORE_BATCH_SIZE = 1000;

const FORBIDDEN_DATABASES = new Set([
  "admin",
  "config",
  "local",
  "production",
  "prod",
  "homeclick24",
  "miportal",
  "miportal-inmobiliario",
  "miportal_inmobiliario",
]);

const TEMPORARY_DATABASE_PREFIXES = [
  "restore_",
  "restore-",
  "test_restore_",
  "test-restore-",
];
const SAFE_DATABASE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export class RestoreSafetyError extends Error {
  constructor(message, { code = "RESTORE_SAFETY_ERROR" } = {}) {
    super(message);
    this.name = "RestoreSafetyError";
    this.code = code;
  }
}

function restoreError(message, code) {
  return new RestoreSafetyError(message, { code });
}

export function normalizeBatchSize(value = DEFAULT_RESTORE_BATCH_SIZE) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_RESTORE_BATCH_SIZE) {
    throw restoreError(`El batch size debe ser un entero entre 1 y ${MAX_RESTORE_BATCH_SIZE}.`, "INVALID_BATCH_SIZE");
  }
  return number;
}

export function parseMongoUri(uri) {
  if (typeof uri !== "string" || uri.trim() === "" || uri !== uri.trim()) {
    throw restoreError("La URI de restauración es obligatoria.", "RESTORE_URI_REQUIRED");
  }

  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw restoreError("La URI de restauración no es válida.", "INVALID_RESTORE_URI");
  }

  if (!["mongodb:", "mongodb+srv:"].includes(parsed.protocol)) {
    throw restoreError("La URI de restauración debe usar mongodb o mongodb+srv.", "INVALID_RESTORE_URI");
  }
  if (parsed.hash) {
    throw restoreError("La URI de restauración no puede incluir fragmentos.", "INVALID_RESTORE_URI");
  }

  const rawPath = parsed.pathname.replace(/^\/+/, "");
  if (!rawPath) {
    throw restoreError("La URI de restauración debe incluir una base de datos explícita.", "DATABASE_NAME_REQUIRED");
  }
  if (rawPath.includes("/")) {
    throw restoreError("La URI de restauración debe incluir solo una base de datos.", "INVALID_RESTORE_URI");
  }

  let databaseName;
  try {
    databaseName = decodeURIComponent(rawPath);
  } catch {
    throw restoreError("La URI de restauración contiene una base de datos no válida.", "INVALID_RESTORE_URI");
  }
  if (!databaseName) {
    throw restoreError("La URI de restauración debe incluir una base de datos explícita.", "DATABASE_NAME_REQUIRED");
  }

  return {
    protocol: parsed.protocol,
    hostname: parsed.hostname.toLowerCase(),
    port: parsed.port || "",
    databaseName,
    searchParams: parsed.searchParams,
  };
}

export function getDatabaseNameFromUri(uri) {
  return parseMongoUri(uri).databaseName;
}

export function sanitizeMongoUri(uri) {
  const parsed = parseMongoUri(uri);
  return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}/${parsed.databaseName}`;
}

function normalizedUriDestination(uri) {
  const parsed = parseMongoUri(uri);
  return {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port,
    databaseName: parsed.databaseName,
  };
}

function assertDifferentDestination(restoreUri, productionUri) {
  if (!productionUri) return;

  const restore = normalizedUriDestination(restoreUri);
  const production = normalizedUriDestination(productionUri);
  const sameDestination = restore.protocol === production.protocol
    && restore.hostname === production.hostname
    && restore.port === production.port
    && restore.databaseName === production.databaseName;

  if (sameDestination) {
    throw restoreError("La URI de restauración coincide con la base de producción.", "RESTORE_URI_MATCHES_PRODUCTION");
  }
}

export function assertTemporaryDatabaseName(databaseName) {
  if (typeof databaseName !== "string" || databaseName.length === 0) {
    throw restoreError("La base de destino debe tener nombre.", "DATABASE_NAME_REQUIRED");
  }
  if (/[\u0000-\u001F\u007F]/u.test(databaseName) || databaseName.includes("/") || databaseName.includes("\\")) {
    throw restoreError("La base de destino contiene caracteres no permitidos.", "INVALID_TEMPORARY_DATABASE");
  }
  if (!SAFE_DATABASE_NAME_PATTERN.test(databaseName)) {
    throw restoreError("La base de destino contiene caracteres no permitidos.", "INVALID_TEMPORARY_DATABASE");
  }
  const lowerName = databaseName.toLowerCase();
  if (FORBIDDEN_DATABASES.has(lowerName)) {
    throw restoreError("La base de destino está prohibida.", "FORBIDDEN_DATABASE");
  }
  if (!TEMPORARY_DATABASE_PREFIXES.some(prefix => lowerName.startsWith(prefix))) {
    throw restoreError("La base de destino debe ser temporal y empezar por restore_ o test_restore_.", "INVALID_TEMPORARY_DATABASE");
  }
  return databaseName;
}

export function assertSafeRestoreEnvironment({
  dryRun = false,
  confirmRestore = false,
  env = process.env,
} = {}) {
  if (dryRun && confirmRestore) {
    throw restoreError("No se puede usar --dry-run junto con --confirm-restore.", "CONFLICTING_RESTORE_MODES");
  }
  if (!dryRun && !confirmRestore) {
    throw restoreError("Indica --dry-run o --confirm-restore.", "RESTORE_MODE_REQUIRED");
  }
  if (dryRun) {
    return { mode: "DRY_RUN", sanitizedDestination: null };
  }
  if (env.ALLOW_RESTORE !== "true") {
    throw restoreError("La restauración real exige ALLOW_RESTORE=true.", "RESTORE_NOT_ALLOWED");
  }
  if (!env.RESTORE_MONGODB_URI) {
    throw restoreError("La restauración real exige RESTORE_MONGODB_URI.", "RESTORE_URI_REQUIRED");
  }

  const databaseName = getDatabaseNameFromUri(env.RESTORE_MONGODB_URI);
  assertTemporaryDatabaseName(databaseName);
  assertDifferentDestination(env.RESTORE_MONGODB_URI, env.MONGODB_URI);

  return {
    mode: "RESTORE",
    sanitizedDestination: sanitizeMongoUri(env.RESTORE_MONGODB_URI),
    databaseName,
  };
}

function calculateBatches(documents, batchSize) {
  return Math.ceil(documents / batchSize);
}

export function createRestorePlan(summary, { batchSize = DEFAULT_RESTORE_BATCH_SIZE, mode = "DRY_RUN" } = {}) {
  const normalizedBatchSize = normalizeBatchSize(batchSize);
  return {
    mode,
    valid: true,
    file: { ...summary.file },
    collections: summary.collections.map(collection => ({
      name: collection.name,
      documents: collection.documents,
      documentsWithoutId: collection.documentsWithoutId,
      batches: calculateBatches(collection.documents, normalizedBatchSize),
    })),
    totalDocuments: summary.totalDocuments,
    batchSize: normalizedBatchSize,
    warnings: [...summary.warnings],
    result: mode === "DRY_RUN" ? "plan válido" : "restauración preparada",
  };
}

export function sanitizeRestoreReport(report) {
  return {
    mode: report.mode,
    destination: report.destination,
    file: report.file ? { ...report.file } : undefined,
    totalDocuments: report.totalDocuments || 0,
    batchSize: report.batchSize,
    collections: (report.collections || []).map(collection => ({
      name: collection.name,
      documents: collection.documents,
      inserted: collection.inserted || 0,
      batchesCompleted: collection.batchesCompleted || 0,
      status: collection.status,
      errorCode: collection.errorCode,
    })),
    warnings: [...(report.warnings || [])],
    partial: report.partial === true,
  };
}

export async function assertTargetDatabaseEmpty(db) {
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  if (!Array.isArray(collections)) {
    throw restoreError("No se pudo verificar que la base destino esté vacía.", "TARGET_DATABASE_NOT_EMPTY");
  }
  for (const collectionInfo of collections) {
    if (!collectionInfo || typeof collectionInfo.name !== "string") {
      throw restoreError("No se pudo verificar que la base destino esté vacía.", "TARGET_DATABASE_NOT_EMPTY");
    }
    const count = await db.collection(collectionInfo.name).countDocuments({}, { limit: 1 });
    if (!Number.isInteger(count) || count < 0) {
      throw restoreError("No se pudo verificar que la base destino esté vacía.", "TARGET_DATABASE_NOT_EMPTY");
    }
    if (count > 0) {
      throw restoreError("La base de destino contiene datos y no se modificará.", "TARGET_DATABASE_NOT_EMPTY");
    }
  }
}

function sanitizeInsertErrorCode(error, insertedBeforeFailure) {
  if (insertedBeforeFailure > 0) return "PARTIAL_RESTORE";
  if (error instanceof RestoreSafetyError) return error.code;
  return "RESTORE_INSERT_FAILED";
}

export async function insertCollectionInBatches(collection, documents, {
  batchSize = DEFAULT_RESTORE_BATCH_SIZE,
  insertedBeforeStart = 0,
} = {}) {
  const normalizedBatchSize = normalizeBatchSize(batchSize);
  let inserted = 0;
  let batchesCompleted = 0;

  for (let index = 0; index < documents.length; index += normalizedBatchSize) {
    const batch = documents.slice(index, index + normalizedBatchSize);
    try {
      if (batch.length > 0) {
        const result = await collection.insertMany(batch, { ordered: true });
        if (!result || result.insertedCount !== batch.length) {
          throw restoreError("MongoDB devolvió un resultado de inserción ambiguo.", "RESTORE_INSERT_FAILED");
        }
      }
      inserted += batch.length;
      batchesCompleted += 1;
    } catch (error) {
      const insertedBeforeFailure = insertedBeforeStart + inserted;
      const code = sanitizeInsertErrorCode(error, insertedBeforeFailure);
      throw restoreError("No se pudo insertar un lote de restauración.", code);
    }
  }

  return {
    inserted,
    batchesCompleted,
  };
}

export async function createMongooseRestoreConnection(uri, {
  serverSelectionTimeoutMS = 5000,
} = {}) {
  const connection = mongoose.createConnection(uri, {
    serverSelectionTimeoutMS,
    autoIndex: false,
    maxPoolSize: 3,
  });
  await connection.asPromise();
  return connection;
}

export async function restoreBackupToTemporaryDatabase(filePath, {
  batchSize = DEFAULT_RESTORE_BATCH_SIZE,
  expectedCollections,
  confirmRestore = false,
  dryRun = false,
  env = process.env,
  createConnection = createMongooseRestoreConnection,
} = {}) {
  const normalizedBatchSize = normalizeBatchSize(batchSize);
  const { summary, payload } = await readValidatedBackupPayload(filePath, { expectedCollections });
  const safety = assertSafeRestoreEnvironment({ dryRun, confirmRestore, env });
  const plan = createRestorePlan(summary, {
    batchSize: normalizedBatchSize,
    mode: safety.mode,
  });

  if (dryRun) return plan;

  let connection;
  let insertedSoFar = 0;
  let primaryError = null;
  const report = {
    mode: "RESTORE",
    destination: safety.sanitizedDestination,
    file: plan.file,
    totalDocuments: plan.totalDocuments,
    batchSize: normalizedBatchSize,
    collections: [],
    warnings: plan.warnings,
    partial: false,
  };

  try {
    try {
      connection = await createConnection(env.RESTORE_MONGODB_URI);
    } catch {
      throw restoreError("No se pudo conectar a la base temporal.", "RESTORE_CONNECTION_FAILED");
    }

    await assertTargetDatabaseEmpty(connection.db);

    for (const collectionPlan of plan.collections) {
      const collectionReport = {
        name: collectionPlan.name,
        documents: collectionPlan.documents,
        inserted: 0,
        batchesCompleted: 0,
        status: "pending",
      };
      report.collections.push(collectionReport);

      try {
        const result = await insertCollectionInBatches(
          connection.db.collection(collectionPlan.name),
          payload[collectionPlan.name],
          {
            batchSize: normalizedBatchSize,
            insertedBeforeStart: insertedSoFar,
          }
        );
        collectionReport.inserted = result.inserted;
        collectionReport.batchesCompleted = result.batchesCompleted;
        collectionReport.status = "inserted";
        insertedSoFar += result.inserted;
      } catch (error) {
        collectionReport.status = "failed";
        collectionReport.errorCode = error.code || "RESTORE_INSERT_FAILED";
        report.partial = collectionReport.errorCode === "PARTIAL_RESTORE";
        throw error;
      }
    }

    return sanitizeRestoreReport(report);
  } catch (error) {
    if (error instanceof RestoreSafetyError || error instanceof BackupValidationError) {
      primaryError = error;
      throw error;
    }
    primaryError = restoreError("La restauración falló.", insertedSoFar > 0 ? "PARTIAL_RESTORE" : "RESTORE_INSERT_FAILED");
    throw primaryError;
  } finally {
    if (connection && typeof connection.close === "function") {
      try {
        await connection.close();
      } catch {
        if (!primaryError) {
          throw restoreError("No se pudo cerrar la conexión de restauración.", "RESTORE_CONNECTION_FAILED");
        }
      }
    }
  }
}

export const RESTORE_ERROR_CODES = Object.freeze([
  "RESTORE_MODE_REQUIRED",
  "CONFLICTING_RESTORE_MODES",
  "RESTORE_NOT_ALLOWED",
  "RESTORE_URI_REQUIRED",
  "INVALID_RESTORE_URI",
  "RESTORE_URI_MATCHES_PRODUCTION",
  "DATABASE_NAME_REQUIRED",
  "FORBIDDEN_DATABASE",
  "INVALID_TEMPORARY_DATABASE",
  "INVALID_BATCH_SIZE",
  "TARGET_DATABASE_NOT_EMPTY",
  "RESTORE_CONNECTION_FAILED",
  "RESTORE_INSERT_FAILED",
  "PARTIAL_RESTORE",
]);
