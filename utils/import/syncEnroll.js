import Propiedad from "../../models/Propiedad.js";
import ImportSource from "../../models/ImportSource.js";
import { fetchFeedXml } from "./feedFetcher.js";
import { buildSyncSnapshot } from "./syncSnapshot.js";
import { acquireSyncLock, syncError } from "./syncLock.js";
import { managedFingerprint, enrollmentCompatible, baselineValid, SYNC_APPLY_FIELDS_VERSION } from "./syncBaseline.js";
import { createImportBudget } from "./importBudget.js";

export function createSyncEnroller({ ImportSourceModel = ImportSource, PropiedadModel = Propiedad,
  fetchXml = fetchFeedXml, env = process.env, now = () => new Date() } = {}) {
  return async ({ usuarioId, importSourceId, externalIds }) => {
    if (!Array.isArray(externalIds) || externalIds.length < 1 || externalIds.length > 10 ||
      new Set(externalIds).size !== externalIds.length || externalIds.some(value => typeof value !== "string" || !value || value.length > 200)) {
      throw syncError("SYNC_ENROLL_SELECTION_INVALID", 400);
    }
    const budget = createImportBudget();
    let lock;
    let session;
    try {
      lock = await acquireSyncLock({ ImportSourceModel, usuarioId, importSourceId, env, now });
      const fetched = await fetchXml(lock.feedUrl, { budget });
      budget.assertActive();
      const snapshot = buildSyncSnapshot(fetched.xml);
      if (!snapshot.snapshotComplete) throw syncError("SYNC_SNAPSHOT_INCOMPLETE");
      const byId = new Map(snapshot.properties.map(item => [item.data.externalId, item.data]));
      if (externalIds.some(ref => !byId.has(ref))) throw syncError("SYNC_ENROLL_BASELINE_MISMATCH");
      const filter = { usuarioId, importSourceId, source: "crm", externalId: { $in: externalIds } };
      async function checkedProperties(transaction) {
        let query = PropiedadModel.find(filter);
        if (transaction && query?.session) query = query.session(transaction);
        if (query?.lean) query = query.lean();
        const properties = await query;
        if (properties.length !== externalIds.length || externalIds.some(ref => properties.filter(p => p.externalId === ref).length !== 1)) {
          throw syncError("SYNC_ENROLL_BASELINE_MISMATCH");
        }
        for (const property of properties) {
          if (!enrollmentCompatible(property, byId.get(property.externalId)) ||
            (property.syncEnabled === true && !baselineValid(property))) throw syncError("SYNC_ENROLL_BASELINE_MISMATCH");
        }
        return properties;
      }
      await lock.assert();
      const initial = await checkedProperties();
      if (initial.every(p => p.syncEnabled === true)) {
        await lock.assert();
        return { ok: true, alreadyEnrolled: true, enrolled: 0 };
      }
      session = await PropiedadModel.startSession();
      let enrolled = 0;
      await session.withTransaction(async () => {
        budget.assertActive();
        await lock.fence(session);
        const current = await checkedProperties(session);
        enrolled = 0;
        for (const property of current) {
          if (property.syncEnabled === true) continue;
          const revision = property.contentRevision ?? 0;
          const result = await PropiedadModel.updateOne({ _id: property._id, usuarioId, importSourceId, source: "crm",
            externalId: property.externalId, syncEnabled: { $ne: true },
            $or: revision === 0 ? [{ contentRevision: 0 }, { contentRevision: { $exists: false } }] : [{ contentRevision: revision }]
          }, { $set: { syncEnabled: true, syncApplyFingerprint: managedFingerprint(property),
            syncApplyFingerprintVersion: SYNC_APPLY_FIELDS_VERSION } }, { session });
          if (result.matchedCount !== 1) throw syncError("SYNC_ENROLL_BASELINE_MISMATCH");
          enrolled++;
        }
        budget.assertActive();
        await lock.assert(session);
      }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 10000 });
      return { ok: true, alreadyEnrolled: enrolled === 0, enrolled };
    } finally {
      if (session) await session.endSession().catch(() => {});
      if (lock) await lock.release();
      budget.dispose();
    }
  };
}
