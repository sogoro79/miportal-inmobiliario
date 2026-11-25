import mongoose from "mongoose";
import { pathToFileURL } from "node:url";
import {
  PROVIDER_SNAPSHOT_COLLECTION as collection,
  PROVIDER_SNAPSHOT_TTL_INDEX as indexName,
  PROVIDER_SNAPSHOT_TTL_SECONDS as targetTTL
} from "../utils/import/providerSnapshotRetention.js";

const messages = {
  TTL_CONFIG_REQUIRED: "Falta la configuración Mongo existente.",
  TTL_INDEX_REVIEW_REQUIRED: "Índice TTL ausente o inesperado. Requiere revisión manual; no se ha creado ni eliminado ningún índice.",
  TTL_LIST_FAILED: "No se pudieron consultar los índices. Revisa conexión y permisos.",
  TTL_COLLMOD_UNSUPPORTED: "collMod no está disponible con esta configuración. Requiere revisión administrativa de compatibilidad; no hay fallback automático.",
  TTL_COLLMOD_FORBIDDEN: "Sin permiso para collMod. Requiere una cuenta administrativa autorizada.",
  TTL_COLLMOD_FAILED: "No se pudo confirmar collMod. Verifica el índice antes de repetir; no se ha intentado drop/recreate.",
  TTL_VERIFY_FAILED: "La verificación posterior no coincide con el TTL objetivo. Requiere revisión manual.",
  TTL_OPERATION_FAILED: "No se pudo completar la operación administrativa. Revisa conexión y configuración.",
  TTL_CLOSE_FAILED: "No se pudo confirmar el cierre de la conexión administrativa."
};
const failure = code => Object.assign(new Error(messages[code]), { code });
function expectedIndex(indexes) {
  if (!Array.isArray(indexes)) throw failure("TTL_INDEX_REVIEW_REQUIRED");
  const matches = indexes.filter(index => index.name === indexName || Object.hasOwn(index.key || {}, "expiresAt"));
  if (matches.length !== 1) throw failure("TTL_INDEX_REVIEW_REQUIRED");
  const index = matches[0];
  if (index.name !== indexName || Object.keys(index.key || {}).length !== 1 || index.key.expiresAt !== 1 ||
      ![0, 1500, targetTTL].includes(index.expireAfterSeconds) ||
      index.partialFilterExpression || index.sparse || index.unique || index.hidden) throw failure("TTL_INDEX_REVIEW_REQUIRED");
  return index;
}
async function readIndex(db) {
  let indexes;
  try { indexes = await db.collection(collection).listIndexes().toArray(); }
  catch (error) { throw failure(error?.code === 26 ? "TTL_INDEX_REVIEW_REQUIRED" : "TTL_LIST_FAILED"); }
  return expectedIndex(indexes);
}
const metadata = index => ({ collection, index: indexName, currentTTL: index.expireAfterSeconds, targetTTL });

// Native driver only: no model import/init, autoIndex, collection creation,
// document access, or implicit execution when imported by tests/tools.
export async function updateProviderSnapshotTtl({ db, logger = console }) {
  const before = await readIndex(db);
  logger.log("ProviderSnapshot TTL: inspección", metadata(before));
  if (before.expireAfterSeconds === targetTTL) {
    logger.log("ProviderSnapshot TTL: correcto, sin cambios", metadata(before));
    return { changed: false, ...metadata(before) };
  }
  try {
    const result = await db.command({ collMod: collection, index: { name: indexName, expireAfterSeconds: targetTTL } });
    if (result?.ok !== 1) throw failure("TTL_COLLMOD_FAILED");
  } catch (error) {
    const code = [59, 72, 115].includes(error?.code) ? "TTL_COLLMOD_UNSUPPORTED"
      : error?.code === 13 ? "TTL_COLLMOD_FORBIDDEN" : "TTL_COLLMOD_FAILED";
    throw failure(code);
  }
  let after;
  try { after = await readIndex(db); }
  catch { throw failure("TTL_VERIFY_FAILED"); }
  if (after.expireAfterSeconds !== targetTTL) throw failure("TTL_VERIFY_FAILED");
  logger.log("ProviderSnapshot TTL: cambio verificado", metadata(after));
  return { changed: true, ...metadata(after) };
}

export async function main({ env = process.env, logger = console, runtime = process,
  createClient = uri => new mongoose.mongo.MongoClient(uri, { serverSelectionTimeoutMS: 10000 }) } = {}) {
  let client;
  try {
    if (!env.MONGODB_URI) throw failure("TTL_CONFIG_REQUIRED");
    client = createClient(env.MONGODB_URI);
    await client.connect();
    return await updateProviderSnapshotTtl({ db: client.db(), logger });
  } catch (error) {
    const safeCode = Object.hasOwn(messages, error?.code) ? error.code : "TTL_OPERATION_FAILED";
    logger.error(messages[safeCode]); // Static allowlisted text; no raw error/URI/index document.
    runtime.exitCode = 1;
  } finally {
    if (client) {
      try { await client.close(); }
      catch { logger.error(messages.TTL_CLOSE_FAILED); runtime.exitCode = 1; }
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await import("dotenv/config");
  await main();
}
