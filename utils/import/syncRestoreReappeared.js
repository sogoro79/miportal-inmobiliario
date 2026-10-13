import crypto from "node:crypto";
import Propiedad from "../../models/Propiedad.js";
import Usuario from "../../models/Usuario.js";
import ImportSource from "../../models/ImportSource.js";
import ImportSyncRun from "../../models/ImportSyncRun.js";
import ImportReconciliation from "../../models/ImportReconciliation.js";
import { fetchFeedXml } from "./feedFetcher.js";
import { buildSyncSnapshot } from "./syncSnapshot.js";
import { snapshotDigest, runVersions } from "./syncPlan.js";
import { safeReappearedEligibility, prepareReappearedEligibility } from "./reappearedEligibility.js";
import { safeRestoreCode, safeRestoreSummary, restoreSelectionHash, validRestoreExternalId,
  REAPPEARED_RESTORE_CODES } from "./reappearedRestoreState.js";
import { getPublicationAvailability } from "../propertyCreation.js";
import { fencePublicationUser } from "../publicationCapacity.js";
import { managedChangedFields, suppliedNonPhotoDifferences } from "./syncBaseline.js";
import { acquireSyncLock } from "./syncLock.js";
import { createImportBudget } from "./importBudget.js";

const id = value => String(value ?? "").toLowerCase();
const validId = value => /^[a-f0-9]{24}$/.test(id(value));
const date = value => value == null ? NaN : new Date(value).getTime();
export const restoreError = (code, status = 409) => Object.assign(new Error("No se pudo confirmar la republicación CRM."), { code, status });
function reject(code, status) { throw restoreError(code, status); }
const safeResult = run => ({ runId: String(run._id), ...safeRestoreSummary(run.reappearedRestore) });

export function createReappearedRestorer({ PropiedadModel = Propiedad, UsuarioModel = Usuario,
  ImportSourceModel = ImportSource, ImportSyncRunModel = ImportSyncRun, ReconciliationModel = ImportReconciliation,
  fetchXml = fetchFeedXml, env = process.env, now = () => new Date() } = {}) {
  return async ({ usuarioId, runId, externalIds }) => {
    if (!validId(usuarioId) || !validId(runId) || !Array.isArray(externalIds) || !externalIds.length ||
      externalIds.length > 10 || new Set(externalIds).size !== externalIds.length ||
      !externalIds.every(validRestoreExternalId)) reject("REAPPEARED_SELECTION_INVALID", 400);
    const selectionHash = restoreSelectionHash(externalIds);
    async function query(Model, filter, session, select, many = false, majority = false) {
      let q = many ? Model.find(filter) : Model.findOne(filter);
      if (select && q?.select) q = q.select(select);
      if (session && q?.session) q = q.session(session);
      if (majority && q?.read) q = q.read("primary").readConcern("majority").maxTimeMS(5000);
      if (q?.lean) q = q.lean();
      return q;
    }
    async function readRun(session, majority = false) {
      const run = await query(ImportSyncRunModel, { _id: runId, usuarioId }, session, "+plan", false, majority);
      if (!run) reject("REAPPEARED_RUN_NOT_FOUND", 404);
      return run;
    }
    function previous(run) {
      const r = run.reappearedRestore;
      if (!r) return null;
      if (!Array.isArray(r.selectedExternalIds) || r.selectionHash !== selectionHash ||
        restoreSelectionHash(r.selectedExternalIds) !== selectionHash) reject("REAPPEARED_SELECTION_MISMATCH");
      if (r.status === "completed") {
        if (!Array.isArray(r.results) || r.results.length !== externalIds.length ||
          new Set(r.results.map(e => e.externalId)).size !== externalIds.length ||
          r.results.some(e => !externalIds.includes(e.externalId) || e.status !== "restored") ||
          r.countRestored !== externalIds.length || r.countAlreadyRestored !== 0 || !Number.isFinite(date(r.completedAt)))
          reject("REAPPEARED_INDETERMINATE", 503);
        return safeResult(run);
      }
      reject(r.status === "indeterminate" ? "REAPPEARED_INDETERMINATE" :
        ["preparing", "applying"].includes(r.status) ? "REAPPEARED_IN_PROGRESS" : "REAPPEARED_OPERATION_CONFLICT",
      r.status === "indeterminate" ? 503 : 409);
    }
    function checkRun(run, source) {
      if (run.reappearedRestore || run.status !== "simulated" || run.missingHide ||
        (run.newImport?.status && run.newImport.status !== "idle") || run.appliedAt || run.resultCodes?.length)
        reject("REAPPEARED_OPERATION_CONFLICT");
      if (id(source._id) !== id(run.importSourceId) || id(source.usuarioId) !== id(usuarioId) ||
        source.activo !== true || source.feedType !== "generic_xml" || run.sourceIdentityHash !== source.feedUrlHash)
        reject("REAPPEARED_SOURCE_CHANGED");
      return externalIds.map(ref => {
        const entries = (run.plan || []).filter(e => e.externalId === ref);
        if (entries.length !== 1 || entries[0].type !== "REAPPEARED") reject("REAPPEARED_NOT_ELIGIBLE");
        const eligible = safeReappearedEligibility(entries[0], run, now(), runVersions);
        if (!eligible.restoreEligible) reject(eligible.restoreBlockCode);
        return entries[0];
      });
    }
    const initial = await readRun();
    const completed = previous(initial);
    if (completed) return completed;
    const source = await query(ImportSourceModel, { _id: initial.importSourceId, usuarioId, activo: true });
    if (!source) reject("SYNC_SOURCE_NOT_FOUND", 404);
    checkRun(initial, source);
    const budget = createImportBudget();
    let lock, session, transactionStarted = false;
    const operationId = crypto.randomUUID(), startedAt = now();
    try {
      lock = await acquireSyncLock({ ImportSourceModel, usuarioId, importSourceId: initial.importSourceId, env, now });
      checkRun(initial, lock.source);
      const fetched = await fetchXml(lock.feedUrl, { budget });
      budget.assertActive();
      const snapshot = buildSyncSnapshot(fetched.xml);
      if (!snapshot.snapshotComplete) reject("REAPPEARED_SNAPSHOT_INCOMPLETE");
      for (const ref of externalIds) if (snapshot.properties.filter(e => e.data.externalId === ref).length !== 1)
        reject("REAPPEARED_NO_LONGER_PRESENT");
      if (snapshotDigest(snapshot) !== initial.snapshotDigest) {
        const current = await query(PropiedadModel, { usuarioId, importSourceId: initial.importSourceId,
          source: "crm", externalId: { $in: externalIds } }, undefined, undefined, true);
        for (const ref of externalIds) {
          const properties = current.filter(p => p.externalId === ref);
          const data = snapshot.properties.find(e => e.data.externalId === ref).data;
          if (properties.length === 1 && (managedChangedFields(properties[0], data).length ||
            suppliedNonPhotoDifferences(properties[0], data).length)) reject("REAPPEARED_CONTENT_CHANGED");
        }
        reject("REAPPEARED_FEED_CHANGED");
      }
      session = await UsuarioModel.startSession();
      transactionStarted = true;
      let result;
      await session.withTransaction(async () => {
        budget.assertActive();
        await lock.fence(session);
        const run = await readRun(session);
        const replay = previous(run);
        if (replay) { result = replay; return; }
        const currentSource = await query(ImportSourceModel, { _id: run.importSourceId, usuarioId, activo: true }, session, "+encryptedFeedUrl");
        if (!currentSource) reject("SYNC_SOURCE_NOT_FOUND", 404);
        const entries = checkRun(run, currentSource);
        if (currentSource.encryptedFeedUrl !== lock.source.encryptedFeedUrl ||
          currentSource.feedUrlKeyVersion !== lock.source.feedUrlKeyVersion) reject("REAPPEARED_SOURCE_CHANGED");
        if (run.snapshotDigest !== snapshotDigest(snapshot)) reject("REAPPEARED_FEED_CHANGED");
        const claim = await ImportSyncRunModel.updateOne({ _id: runId, usuarioId, status: "simulated",
          expiresAt: { $gt: now() }, reappearedRestore: { $exists: false }, missingHide: { $exists: false },
          $or: [{ newImport: { $exists: false } }, { "newImport.status": "idle" }] }, { $set: {
          reappearedRestore: { status: "preparing", operationId, selectionHash,
            selectedExternalIds: externalIds, startedAt, results: [] }
        } }, { session, runValidators: true });
        if (claim.matchedCount !== 1) reject("REAPPEARED_OPERATION_CONFLICT");
        // Same write used by manual publication and selected NEW, before any capacity read.
        const fence = await fencePublicationUser(UsuarioModel, usuarioId, session);
        if (fence.matchedCount !== 1) reject("REAPPEARED_PLAN_INACTIVE", 403);
        const user = await query(UsuarioModel, { _id: usuarioId }, session);
        const availability = await getPublicationAvailability(user, { usuarioId, PropiedadModel, session });
        const properties = await query(PropiedadModel, { usuarioId, importSourceId: run.importSourceId,
          source: "crm", externalId: { $in: externalIds } }, session, "+hiddenByMissingRunId", true);
        const causalIds = [...new Set(entries.map(e => id(e.restoreEvidence.expectedHiddenByMissingRunId)))];
        const causalRuns = await query(ImportSyncRunModel, { _id: { $in: causalIds } }, session, "+plan", true);
        const reconciliations = await query(ReconciliationModel, { $or: [
          { propiedadId: { $in: entries.map(e => e.propiedadId) } },
          { usuarioId, importSourceId: run.importSourceId, externalId: { $in: externalIds } }
        ] }, session, undefined, true);
        const context = { usuarioId, importSourceId: run.importSourceId, sourceIdentityHash: currentSource.feedUrlHash,
          snapshotDigest: run.snapshotDigest, versions: runVersions, causalRuns, reconciliations,
          user, visibleCount: availability.anunciosActuales, now: now() };
        function validate(entry) {
          const found = properties.filter(p => p.externalId === entry.externalId);
          if (found.length !== 1) reject(found.length ? "REAPPEARED_IDENTITY_AMBIGUOUS" : "REAPPEARED_PROPERTY_NOT_FOUND");
          const p = found[0], e = entry.restoreEvidence;
          if (id(p._id) !== id(entry.propiedadId)) reject("REAPPEARED_IDENTITY_AMBIGUOUS");
          if (p.visiblePublicamente !== false) reject("REAPPEARED_ALREADY_VISIBLE");
          if (id(p.hiddenByMissingRunId) !== id(e.expectedHiddenByMissingRunId) ||
            date(p.removedFromFeedAt) !== date(e.expectedRemovedFromFeedAt)) reject("REAPPEARED_MARKER_CHANGED");
          if (p.contentRevision !== e.expectedContentRevision) reject("REAPPEARED_REVISION_CHANGED");
          const fresh = prepareReappearedEligibility(snapshot, found, entry.externalId, { ...context, now: now() });
          if (!fresh.restoreEligible) reject(fresh.restoreBlockCode);
          for (const field of ["expectedBaselineFingerprint", "baselineVersion", "expectedManagedFingerprint", "expectedContentFingerprint"])
            if (fresh.restoreEvidence[field] !== e[field]) reject("REAPPEARED_CONTENT_CHANGED");
          return p;
        }
        entries.forEach(validate);
        if (Number.isFinite(availability.limiteAnuncios) &&
          availability.anunciosActuales + entries.length > availability.limiteAnuncios) reject("REAPPEARED_PLAN_LIMIT");
        const applying = await ImportSyncRunModel.updateOne({ _id: runId, usuarioId,
          "reappearedRestore.operationId": operationId, "reappearedRestore.status": "preparing" },
        { $set: { "reappearedRestore.status": "applying" } }, { session, runValidators: true });
        if (applying.matchedCount !== 1) reject("REAPPEARED_OPERATION_CONFLICT");
        const results = [];
        for (const entry of entries) {
          budget.assertActive();
          const e = entry.restoreEvidence;
          const updated = await PropiedadModel.updateOne({ _id: entry.propiedadId, usuarioId,
            importSourceId: run.importSourceId, source: "crm", externalId: entry.externalId,
            visiblePublicamente: false, hiddenByMissingRunId: e.expectedHiddenByMissingRunId,
            removedFromFeedAt: e.expectedRemovedFromFeedAt, contentRevision: e.expectedContentRevision,
            syncEnabled: true, syncApplyFingerprint: e.expectedBaselineFingerprint, syncApplyFingerprintVersion: e.baselineVersion
          }, { $set: { visiblePublicamente: true, hiddenByMissingRunId: null, removedFromFeedAt: null },
            $inc: { contentRevision: 1 } }, { session, runValidators: true });
          if (updated.matchedCount !== 1) reject("REAPPEARED_REVISION_CHANGED");
          results.push({ externalId: entry.externalId, status: "restored" });
        }
        // Validate observed dates again before committing; use pre-write property snapshots.
        entries.forEach(validate);
        checkRun(run, currentSource);
        budget.assertActive(); await lock.assert(session);
        const receipt = { status: "completed", operationId, selectionHash, selectedExternalIds: externalIds,
          results, countRestored: results.length, countAlreadyRestored: 0, startedAt, completedAt: now() };
        const saved = await ImportSyncRunModel.updateOne({ _id: runId, usuarioId,
          "reappearedRestore.operationId": operationId, "reappearedRestore.status": "applying" },
        { $set: { reappearedRestore: receipt } }, { session, runValidators: true });
        if (saved.matchedCount !== 1) reject("REAPPEARED_OPERATION_CONFLICT");
        result = safeResult({ ...run, reappearedRestore: receipt });
      }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 10000 });
      return result;
    } catch (error) {
      const unknown = error?.hasErrorLabel?.("UnknownTransactionCommitResult") ||
        error?.errorLabels?.includes("UnknownTransactionCommitResult") ||
        (transactionStarted && !REAPPEARED_RESTORE_CODES.has(error?.code));
      const code = unknown ? "REAPPEARED_INDETERMINATE" : safeRestoreCode(error);
      if (transactionStarted) {
        // A majority read may prove a late commit; never overwrite its completed receipt.
        try {
          const confirmed = await readRun(undefined, true);
          if (confirmed.reappearedRestore?.status === "completed") return previous(confirmed);
        } catch { /* An unavailable read is not proof of rollback. */ }
        await ImportSyncRunModel.updateOne({ _id: runId, usuarioId, status: "simulated",
          reappearedRestore: { $exists: false }, missingHide: { $exists: false },
          $or: [{ newImport: { $exists: false } }, { "newImport.status": "idle" }] }, { $set: {
          reappearedRestore: { status: unknown ? "indeterminate" : "failed", operationId, selectionHash,
            selectedExternalIds: externalIds, results: unknown ? [] : externalIds.map(externalId => ({ externalId, status: "failed", code })),
            countRestored: 0, countAlreadyRestored: 0, startedAt,
            ...(!unknown ? { completedAt: now() } : {}), errorCode: code }
        } }, { runValidators: true }).catch(() => console.warn("[CRM Reappeared Restore]", { code: "REAPPEARED_INDETERMINATE" }));
      }
      throw restoreError(code, unknown ? 503 : error?.status || 409);
    } finally {
      if (session) await session.endSession().catch(() => {});
      if (lock) await lock.release();
      budget.dispose();
    }
  };
}
