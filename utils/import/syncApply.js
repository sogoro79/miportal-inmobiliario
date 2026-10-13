import { isDeepStrictEqual } from "node:util";
import Propiedad from "../../models/Propiedad.js";
import ImportSource from "../../models/ImportSource.js";
import ImportSyncRun from "../../models/ImportSyncRun.js";
import { fetchFeedXml } from "./feedFetcher.js";
import { buildSyncSnapshot } from "./syncSnapshot.js";
import { acquireSyncLock } from "./syncLock.js";
import { createImportBudget } from "./importBudget.js";
import { evaluateRunApplyEligibility, snapshotDigest, prepareSyncPlan, runVersions } from "./syncPlan.js";
import { SYNC_APPLY_V1_FIELDS, normalizedManagedValue } from "./syncBaseline.js";

export function applyError(code, status = 409) {
  return Object.assign(new Error("No se pudo aplicar la simulacion CRM."), { code, status });
}
const identicalSelection = (a, b) => isDeepStrictEqual([...a].sort(), [...b].sort());
export function safeApplyResult(run, alreadyApplied = false) {
  return { ok: true, alreadyApplied, runId: String(run._id), appliedCount: run.appliedCount,
    blockedCount: run.blockedCount || 0, appliedAt: run.appliedAt,
    selectedExternalIds: run.selectedExternalIds, resultCodes: ["UPDATE_APPLIED"] };
}

export function createSyncApplier({ PropiedadModel = Propiedad, ImportSourceModel = ImportSource,
  ImportSyncRunModel = ImportSyncRun, fetchXml = fetchFeedXml, env = process.env, now = () => new Date() } = {}) {
  return async ({ usuarioId, runId, externalIds }) => {
    if (!Array.isArray(externalIds) || !externalIds.length || externalIds.length > 10 ||
      new Set(externalIds).size !== externalIds.length || externalIds.some(id => typeof id !== "string" || !id || id.length > 200)) {
      throw applyError("SYNC_APPLY_SELECTION_INVALID", 400);
    }
    async function readRun(session) {
      let query = ImportSyncRunModel.findOne({ _id: runId, usuarioId });
      if (query?.select) query = query.select("+plan");
      if (session && query?.session) query = query.session(session);
      if (query?.lean) query = query.lean();
      const run = await query;
      if (!run) throw applyError("SYNC_RUN_NOT_FOUND", 404);
      return run;
    }
    function alreadyApplied(run) {
      if (run.status !== "applied") return null;
      if (!Array.isArray(run.selectedExternalIds) || !identicalSelection(run.selectedExternalIds, externalIds)) {
        throw applyError("SYNC_APPLY_SELECTION_MISMATCH");
      }
      return safeApplyResult(run, true);
    }
    function checkRun(run, source, digest) {
      const eligibility = evaluateRunApplyEligibility(run, now());
      if (!eligibility.applyEligible) throw applyError(eligibility.applyBlockedReason);
      if (String(run.importSourceId) !== String(source._id) || run.sourceIdentityHash !== source.feedUrlHash) {
        throw applyError("SYNC_APPLY_SOURCE_CHANGED");
      }
      if (Object.entries(runVersions).some(([key, value]) => run[key] !== value)) throw applyError("SYNC_APPLY_RUN_CHANGED");
      if (digest !== undefined && run.snapshotDigest !== digest) throw applyError("SYNC_APPLY_FEED_CHANGED");
      const entries = externalIds.map(id => {
        const matches = run.plan.filter(entry => entry.externalId === id);
        if (matches.length !== 1) throw applyError("SYNC_APPLY_SELECTION_INVALID");
        const entry = matches[0];
        if (entry.type !== "UPDATE" || entry.blocked !== false || !entry.propiedadId ||
          !Number.isSafeInteger(entry.expectedContentRevision) || entry.expectedContentRevision < 0 ||
          !/^[a-f0-9]{64}$/.test(entry.expectedBaselineFingerprint || "") ||
          !/^[a-f0-9]{64}$/.test(entry.proposedBaselineFingerprint || "") ||
          !Array.isArray(entry.changedFields) || !entry.changedFields.length ||
          new Set(entry.changedFields).size !== entry.changedFields.length ||
          entry.changedFields.some(field => !SYNC_APPLY_V1_FIELDS.includes(field))) throw applyError("SYNC_APPLY_SELECTION_INVALID");
        return entry;
      });
      return entries;
    }
    const initial = await readRun();
    const source = await ImportSourceModel.findOne({ _id: initial.importSourceId, usuarioId, activo: true });
    if (!source) throw applyError("SYNC_SOURCE_NOT_FOUND", 404);
    if (initial.sourceIdentityHash !== source.feedUrlHash) throw applyError("SYNC_APPLY_SOURCE_CHANGED");
    const previous = alreadyApplied(initial);
    if (previous) return previous;
    checkRun(initial, source);
    const budget = createImportBudget();
    let lock, session;
    try {
      lock = await acquireSyncLock({ ImportSourceModel, usuarioId, importSourceId: initial.importSourceId, env, now });
      checkRun(initial, lock.source);
      const fetched = await fetchXml(lock.feedUrl, { budget });
      budget.assertActive();
      const snapshot = buildSyncSnapshot(fetched.xml);
      if (!snapshot.snapshotComplete) throw applyError("RUN_SNAPSHOT_INCOMPLETE");
      const digest = snapshotDigest(snapshot);
      checkRun(initial, lock.source, digest);
      const incoming = new Map(snapshot.properties.map(item => [item.data.externalId, item.data]));
      session = await PropiedadModel.startSession();
      let result;
      await session.withTransaction(async () => {
        budget.assertActive();
        await lock.fence(session);
        const run = await readRun(session);
        const previousResult = alreadyApplied(run);
        if (previousResult) { result = previousResult; return; }
        const entries = checkRun(run, lock.source, digest);
        let query = PropiedadModel.find({ usuarioId, importSourceId: run.importSourceId, source: "crm",
          externalId: { $in: externalIds } });
        if (query?.select) query = query.select("+hiddenByMissingRunId");
        if (query?.session) query = query.session(session);
        if (query?.lean) query = query.lean();
        const properties = await query;
        const currentPlan = prepareSyncPlan({ ...snapshot,
          properties: snapshot.properties.filter(item => externalIds.includes(item.data.externalId)) }, properties).plan;
        const approved = entries.map(entry => {
          const matches = properties.filter(p => p.externalId === entry.externalId);
          const fresh = currentPlan.find(item => item.externalId === entry.externalId);
          if (matches.length !== 1 || !fresh || fresh.type !== "UPDATE" || fresh.blocked !== false ||
            String(matches[0]._id) !== String(entry.propiedadId) ||
            !["expectedContentRevision", "expectedBaselineFingerprint", "proposedBaselineFingerprint"].every(key => fresh[key] === entry[key]) ||
            !isDeepStrictEqual(fresh.changedFields, entry.changedFields)) throw applyError("SYNC_APPLY_PROPERTY_CHANGED");
          return entry;
        });
        const claimed = await ImportSyncRunModel.updateOne({ _id: run._id, usuarioId, importSourceId: run.importSourceId,
          sourceIdentityHash: lock.source.feedUrlHash, status: "simulated", expiresAt: { $gt: now() },
          snapshotComplete: true, planTruncated: { $ne: true } }, { $set: { status: "applying" } }, { session });
        if (claimed.matchedCount !== 1) throw applyError("SYNC_APPLY_RUN_CHANGED");
        for (const entry of approved) {
          const data = incoming.get(entry.externalId);
          const changed = Object.fromEntries(entry.changedFields.map(field => [field, normalizedManagedValue(data[field], field)]));
          const revision = entry.expectedContentRevision;
          const updated = await PropiedadModel.updateOne({ _id: entry.propiedadId, usuarioId,
            importSourceId: run.importSourceId, source: "crm", externalId: entry.externalId, syncEnabled: true,
            syncApplyFingerprint: entry.expectedBaselineFingerprint, syncApplyFingerprintVersion: run.applyFieldsVersion,
            $or: revision === 0 ? [{ contentRevision: 0 }, { contentRevision: { $exists: false } }] : [{ contentRevision: revision }]
          }, { $set: { ...changed, syncApplyFingerprint: entry.proposedBaselineFingerprint,
            syncApplyFingerprintVersion: run.applyFieldsVersion, lastSyncedAt: now(), lastSeenAt: now() },
            $inc: { contentRevision: 1 } }, { session, runValidators: true });
          if (updated.matchedCount !== 1) throw applyError("SYNC_APPLY_PROPERTY_CHANGED");
        }
        budget.assertActive();
        await lock.assert(session);
        // Recheck wall-clock expiry after all writes; an exception rolls back the whole batch.
        checkRun(run, lock.source, digest);
        const final = { status: "applied", selectedExternalIds: externalIds, appliedCount: approved.length,
          blockedCount: 0, appliedAt: now(), resultCodes: ["UPDATE_APPLIED"] };
        const completed = await ImportSyncRunModel.updateOne({ _id: run._id, usuarioId, status: "applying" },
          { $set: final }, { session, runValidators: true });
        if (completed.matchedCount !== 1) throw applyError("SYNC_APPLY_RUN_CHANGED");
        result = safeApplyResult({ ...run, ...final });
      }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 10000 });
      return result;
    } catch (error) {
      if (error?.hasErrorLabel?.("UnknownTransactionCommitResult") || error?.errorLabels?.includes("UnknownTransactionCommitResult")) {
        throw applyError("SYNC_APPLY_UNCONFIRMED", 503);
      }
      throw error;
    } finally {
      if (session) await session.endSession().catch(() => {});
      if (lock) await lock.release();
      budget.dispose();
    }
  };
}
