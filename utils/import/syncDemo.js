import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import ImportSource from "../../models/ImportSource.js";
import Propiedad from "../../models/Propiedad.js";
import { decryptFeedUrl } from "./feedUrlCrypto.js";
import { fetchFeedXml } from "./feedFetcher.js";
import { buildSyncSnapshot, syncFingerprint, SYNC_FINGERPRINT_VERSION } from "./syncSnapshot.js";
import { createSyncSimulator } from "./syncSimulation.js";

// TEMPORAL: retirar tras la prueba 3A. Desactivado salvo cuenta de prueba explicita.
export const DEMO_V1_URL = "https://www.homeclick24.com/test-sync/homeclick24-sync-simulation.xml";
export const DEMO_V2_URL = "https://www.homeclick24.com/test-sync/homeclick24-sync-simulation-v2.xml";
const references = ["SYNC-DEMO-001", "SYNC-DEMO-002", "SYNC-DEMO-003", "SYNC-DEMO-004"];
export function demoAllowed(userId, env = process.env) {
  return env.CRM_SYNC_TEST_ENABLED === "true" && /^[a-fA-F0-9]{24}$/.test(env.CRM_SYNC_TEST_USER_ID || "")
    && String(userId) === env.CRM_SYNC_TEST_USER_ID;
}
function rejected() { return Object.assign(new Error("Escenario de prueba no disponible o baseline incompatible."), { code: "SYNC_DEMO_REJECTED", status: 409 }); }

export function createSyncDemo({ ImportSourceModel = ImportSource, PropiedadModel = Propiedad, ImportSyncRunModel,
  fetchXml = fetchFeedXml, env = process.env, now = () => new Date()
} = {}) {
  async function sourceFor(usuarioId, importSourceId) {
    if (!demoAllowed(usuarioId, env)) throw rejected();
    let query = ImportSourceModel.findOne({ usuarioId, _id: importSourceId, activo: true });
    if (query?.select) query = query.select("+encryptedFeedUrl");
    const source = await query;
    if (!source || source.feedType !== "generic_xml" || source.syncEnabled === true || decryptFeedUrl(source, env) !== DEMO_V1_URL) throw rejected();
    return source;
  }
  return {
    async enroll({ usuarioId, importSourceId }) {
      const source = await sourceFor(usuarioId, importSourceId);
      const snapshot = buildSyncSnapshot((await fetchXml(DEMO_V1_URL)).xml);
      if (!snapshot.snapshotComplete || snapshot.snapshotCount !== 4 || references.some(id => !snapshot.properties.some(item => item.data.externalId === id))) throw rejected();
      const token = crypto.randomUUID();
      const start = now();
      const locked = await ImportSourceModel.findOneAndUpdate({ _id: source._id, usuarioId, feedUrlHash: source.feedUrlHash,
        $or: [{ importLockUntil: { $exists: false } }, { importLockUntil: null }, { importLockUntil: { $lte: start } }]
      }, { $set: { importLockToken: token, importLockUntil: new Date(start.getTime() + 15 * 60 * 1000) } }, { new: true });
      if (!locked) throw rejected();
      let session;
      try {
        session = await PropiedadModel.db.startSession();
        await session.withTransaction(async () => {
          const owned = await PropiedadModel.find({ usuarioId, importSourceId, source: "crm" }).limit(5).session(session).lean();
          if (owned.length !== 4 || new Set(owned.map(item => item.externalId)).size !== 4) throw rejected();
          for (const item of owned) {
            const baseline = snapshot.properties.find(record => record.data.externalId === item.externalId)?.data;
            if (!baseline || item.syncEnabled === true || Object.values(item.syncOverrides || {}).some(Boolean)
              || Object.entries(baseline).some(([field, value]) => !isDeepStrictEqual(item[field], value))) throw rejected();
          }
          const lockCheck = await ImportSourceModel.findOne({ _id: source._id, usuarioId, importLockToken: token, importLockUntil: { $gt: now() } }).session(session);
          if (!lockCheck) throw rejected();
          for (const item of owned) {
            const baseline = snapshot.properties.find(record => record.data.externalId === item.externalId).data;
            const result = await PropiedadModel.updateOne({ _id: item._id, usuarioId, importSourceId, source: "crm",
              syncEnabled: { $ne: true }, contentRevision: item.contentRevision ?? 0
            }, { $set: { syncEnabled: true, syncFingerprint: syncFingerprint(baseline), syncFingerprintVersion: SYNC_FINGERPRINT_VERSION } }, { session });
            if (result.matchedCount !== 1) throw rejected();
          }
        });
        return { ok: true, enrolled: 4, syncEnabled: false, message: "Cuatro anuncios de prueba vinculados para simulación. La sincronización automática permanece desactivada." };
      } finally {
        try { if (session) await session.endSession(); }
        finally { await ImportSourceModel.updateOne({ _id: source._id, usuarioId, importLockToken: token }, { $unset: { importLockToken: "", importLockUntil: "" } })
          .catch(() => console.warn("[CRM Sync Demo]", { code: "SOURCE_UNLOCK_FAILED" })); }
      }
    },
    async simulateV2(input) {
      await sourceFor(input.usuarioId, input.importSourceId);
      const simulate = createSyncSimulator({ ImportSourceModel, PropiedadModel, ImportSyncRunModel, env,
        fetchXml: async (url, options) => {
          if (url !== DEMO_V1_URL) throw rejected();
          return fetchXml(DEMO_V2_URL, options);
        }
      });
      return simulate(input);
    }
  };
}
