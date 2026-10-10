import ImportSource from "../../models/ImportSource.js";
import Propiedad from "../../models/Propiedad.js";
import crypto from "node:crypto";
import { assertPublicFeedTarget, parseAndValidateFeedUrl, maskFeedUrl, DEFAULT_FEED_TIMEOUT_MS } from "./feedSecurity.js";
import { encryptFeedUrl } from "./feedUrlCrypto.js";

export function safeSourceStatus(source) {
  if (!source) return { configured: false, syncEnabled: false, lastSuccessfulSyncAt: null, lastSyncStatus: null };
  return {
    importSourceId: String(source._id),
    configured: Boolean(source.encryptedFeedUrl && source.feedUrlKeyVersion && source.activo !== false),
    feedUrlMasked: maskFeedUrl(source.feedUrlMasked),
    syncEnabled: false,
    lastSuccessfulSyncAt: source.lastSuccessfulSyncAt || null,
    lastSyncStatus: ["completed", "incomplete", "failed", "running"].includes(source.lastSyncStatus) ? source.lastSyncStatus : null
  };
}

export function createSyncSourceManager({ ImportSourceModel = ImportSource, PropiedadModel = Propiedad, env = process.env, validateTarget = assertPublicFeedTarget, now = () => new Date() } = {}) {
  return {
    async get(usuarioId) {
      let query = ImportSourceModel.findOne({ usuarioId });
      if (query?.select) query = query.select("_id activo feedUrlMasked feedUrlKeyVersion +encryptedFeedUrl lastSuccessfulSyncAt lastSyncStatus");
      return safeSourceStatus(await query);
    },
    async configure(usuarioId, feedUrl) {
      const parsed = parseAndValidateFeedUrl(feedUrl);
      // Validate the key before DNS or writes; configuration never downloads the feed.
      const encrypted = encryptFeedUrl(parsed.toString(), env);
      let timer;
      try {
        await Promise.race([
          validateTarget(parsed),
          new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("DNS timeout"), { code: "FEED_TIMEOUT" })), DEFAULT_FEED_TIMEOUT_MS); })
        ]);
      } finally { clearTimeout(timer); }
      await ImportSourceModel.init?.();
      const lockToken = crypto.randomUUID();
      const start = now();
      let lockedSource;
      try {
        // Share Phase 2's source lock before checking associations or changing identity.
        let query = ImportSourceModel.findOneAndUpdate({ usuarioId,
          $or: [{ importLockUntil: { $exists: false } }, { importLockUntil: null }, { importLockUntil: { $lte: start } }]
        }, { $set: { importLockToken: lockToken, importLockUntil: new Date(start.getTime() + 15 * 60 * 1000) },
          $setOnInsert: { usuarioId, feedType: "generic_xml", ...encrypted, activo: true }
        }, { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true });
        if (query?.select) query = query.select("+encryptedFeedUrl");
        lockedSource = await query;
        if (!lockedSource) throw Object.assign(new Error("Source busy"), { code: "SYNC_SOURCE_BUSY" });
        if (lockedSource.feedUrlHash !== encrypted.feedUrlHash) {
          const associated = await PropiedadModel.exists({ usuarioId, importSourceId: lockedSource._id, source: "crm" });
          if (associated) throw Object.assign(new Error("Source URL mismatch"), { code: "SYNC_SOURCE_URL_MISMATCH" });
        }
        query = ImportSourceModel.findOneAndUpdate({ _id: lockedSource._id, usuarioId, importLockToken: lockToken,
          importLockUntil: { $gt: now() }
        }, { $set: { ...encrypted, syncEnabled: false, activo: true } }, { new: true, runValidators: true });
        if (query?.select) query = query.select("+encryptedFeedUrl");
        const source = await query;
        if (!source) throw Object.assign(new Error("Source busy"), { code: "SYNC_SOURCE_BUSY" });
        return safeSourceStatus(source);
      } catch (error) {
        if (error?.code === 11000) throw Object.assign(new Error("Source busy"), { code: "SYNC_SOURCE_BUSY" });
        throw error;
      } finally {
        if (lockedSource) await ImportSourceModel.updateOne({ _id: lockedSource._id, usuarioId, importLockToken: lockToken },
          { $unset: { importLockToken: "", importLockUntil: "" } }
        ).catch(() => console.warn("[CRM Sync Source]", { code: "SOURCE_UNLOCK_FAILED" }));
      }
    }
  };
}
