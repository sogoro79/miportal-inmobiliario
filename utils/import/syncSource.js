import ImportSource from "../../models/ImportSource.js";
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

export function createSyncSourceManager({ ImportSourceModel = ImportSource, env = process.env, validateTarget = assertPublicFeedTarget, now = () => new Date() } = {}) {
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
      try {
        const source = await ImportSourceModel.findOneAndUpdate({ usuarioId,
          $or: [{ importLockUntil: { $exists: false } }, { importLockUntil: null }, { importLockUntil: { $lte: now() } }]
        }, { $set: { ...encrypted, syncEnabled: false, activo: true },
          $setOnInsert: { usuarioId, feedType: "generic_xml" }
        }, { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true });
        if (!source) throw Object.assign(new Error("Source busy"), { code: "SYNC_SOURCE_BUSY" });
        return safeSourceStatus(source);
      } catch (error) {
        if (error?.code === 11000) throw Object.assign(new Error("Source busy"), { code: "SYNC_SOURCE_BUSY" });
        throw error;
      }
    }
  };
}
