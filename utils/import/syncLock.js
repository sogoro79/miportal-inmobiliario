import crypto from "node:crypto";
import { decryptFeedUrl } from "./feedUrlCrypto.js";

const LEASE_MS = 15 * 60 * 1000;
export function syncError(code, status = 409) {
  return Object.assign(new Error("No se pudo completar la operacion de sincronizacion."), { code, status });
}
export async function acquireSyncLock({ ImportSourceModel, usuarioId, importSourceId, env, now }) {
  let query = ImportSourceModel.findOne({ _id: importSourceId, usuarioId, activo: true });
  if (query?.select) query = query.select("+encryptedFeedUrl");
  const original = await query;
  if (!original) throw syncError("SYNC_SOURCE_NOT_FOUND", 404);
  const feedUrl = decryptFeedUrl(original, env);
  if (original.feedType !== "generic_xml") throw syncError("SYNC_SOURCE_NOT_CONFIGURED");
  const token = crypto.randomUUID();
  const until = new Date(now().getTime() + LEASE_MS);
  const locked = await ImportSourceModel.findOneAndUpdate({ _id: importSourceId, usuarioId, activo: true,
    feedUrlHash: original.feedUrlHash,
    $or: [{ importLockUntil: { $exists: false } }, { importLockUntil: null }, { importLockUntil: { $lte: now() } }]
  }, { $set: { importLockToken: token, importLockUntil: until } }, { new: true });
  if (!locked) throw syncError("SYNC_SOURCE_BUSY");
  const filter = () => ({ _id: importSourceId, usuarioId, activo: true, feedUrlHash: original.feedUrlHash,
    importLockToken: token, importLockUntil: { $gt: now() } });
  return {
    source: original, feedUrl, token,
    async assert(session) {
      let check = ImportSourceModel.findOne(filter());
      if (session && check?.session) check = check.session(session);
      if (!await check) throw syncError("SYNC_SOURCE_BUSY");
    },
    async fence(session) {
      // A real write to the same lease document fences concurrent configuration/import.
      const renewedUntil = new Date(Math.max(until.getTime() + 1, now().getTime() + LEASE_MS));
      const result = await ImportSourceModel.updateOne(filter(), { $set: { importLockUntil: renewedUntil } }, { session });
      if (!result.matchedCount) throw syncError("SYNC_SOURCE_BUSY");
    },
    async release() {
      await ImportSourceModel.updateOne({ _id: importSourceId, usuarioId, importLockToken: token },
        { $unset: { importLockToken: "", importLockUntil: "" } }).catch(() => console.warn("[CRM Sync]", { code: "SOURCE_UNLOCK_FAILED" }));
    }
  };
}
