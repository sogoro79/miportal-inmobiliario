import { isDeepStrictEqual } from "node:util";
import Propiedad from "../../models/Propiedad.js";
import Usuario from "../../models/Usuario.js";
import ImportSource from "../../models/ImportSource.js";
import ImportSyncRun from "../../models/ImportSyncRun.js";
import ImportReconciliation from "../../models/ImportReconciliation.js";
import { createSelectedImporter } from "./selectedImport.js";
import { analyzeGenericPropertyNodes, parseGenericPropertyNodes } from "../importers/genericXmlImporter.js";
import { fetchFeedXml } from "./feedFetcher.js";
import { buildSyncSnapshot, MAX_SYNC_PROPERTIES } from "./syncSnapshot.js";
import { compareSyncSnapshot } from "./syncDiff.js";
import { evaluateRunNewImportEligibility, snapshotDigest } from "./syncPlan.js";
import { acquireSyncLock } from "./syncLock.js";
import { createImportBudget, MAX_BATCH_PROPERTIES } from "./importBudget.js";
import { safeNewResult, safeNewImportSummary, newImportCounts, NEW_IMPORT_FAILURE_CODES } from "./newImportState.js";

export function newImportError(code, status = 409) {
  return Object.assign(new Error("No se pudo completar la importacion NEW CRM."), { code, status });
}
const validRef = id => typeof id === "string" && id.trim() === id && id.length > 0 && id.length <= 200 &&
  !/https?:\/\/|[<>&?=\u0000-\u001f]/i.test(id);
const sameSelection = (a, b) => Array.isArray(a) && isDeepStrictEqual([...a].sort(), [...b].sort());
export const safeNewFailureCode = error => NEW_IMPORT_FAILURE_CODES.has(error?.code) ? error.code : "SYNC_NEW_FAILED";

export function createSyncNewImporter({ PropiedadModel = Propiedad, UsuarioModel = Usuario, ImportSourceModel = ImportSource,
  ImportSyncRunModel = ImportSyncRun, ReconciliationModel = ImportReconciliation,
  fetchXml = fetchFeedXml, importSelected, env = process.env, now = () => new Date(), budgetFactory = createImportBudget } = {}) {
  const runImport = importSelected || createSelectedImporter({ PropiedadModel, UsuarioModel, ImportSourceModel, ReconciliationModel, now });
  return async ({ usuarioId, runId, externalIds }) => {
    if (!/^[a-fA-F0-9]{24}$/.test(String(runId)) || !Array.isArray(externalIds) || externalIds.length < 1 ||
        externalIds.length > MAX_BATCH_PROPERTIES || new Set(externalIds).size !== externalIds.length || !externalIds.every(validRef)) {
      throw newImportError("SYNC_NEW_SELECTION_INVALID", 400);
    }
    const selected = [...externalIds].sort();
    const budget = budgetFactory();
    let lock, started = false, runFilter;
    async function readRun(session) {
      let query = ImportSyncRunModel.findOne({ _id: runId, usuarioId });
      if (query?.select) query = query.select("+plan");
      if (session && query?.session) query = query.session(session);
      if (query?.lean) query = query.lean();
      const run = await query;
      if (!run) throw newImportError("SYNC_RUN_NOT_FOUND", 404);
      return run;
    }
    function checkRun(run, source, operationStarted = false) {
      const eligibility = evaluateRunNewImportEligibility(operationStarted ? { ...run, newImport: undefined } : run, now(), usuarioId);
      if (!eligibility.newImportEligible) throw newImportError(eligibility.newImportBlockedReason);
      if (String(run.importSourceId) !== String(source._id) || run.sourceIdentityHash !== source.feedUrlHash) {
        throw newImportError("SYNC_NEW_SOURCE_CHANGED");
      }
      for (const id of selected) {
        const entries = run.plan.filter(item => item.externalId === id);
        if (entries.length !== 1 || entries[0].type !== "NEW") throw newImportError("SYNC_NEW_SELECTION_INVALID", 400);
      }
      if (operationStarted && (run.newImport?.status !== "importing" || !sameSelection(run.newImport.selectedExternalIds, selected))) {
        throw newImportError("SYNC_NEW_RUN_CHANGED");
      }
    }
    try {
      const initial = await budget.run(() => readRun());
      const source = await budget.run(() => ImportSourceModel.findOne({ _id: initial.importSourceId, usuarioId, activo: true }));
      if (!source) throw newImportError("SYNC_SOURCE_NOT_FOUND", 404);
      if (initial.sourceIdentityHash !== source.feedUrlHash) throw newImportError("SYNC_NEW_SOURCE_CHANGED");
      if (initial.newImport && initial.newImport.status !== "idle") {
        if (!sameSelection(initial.newImport.selectedExternalIds, selected)) throw newImportError("SYNC_NEW_SELECTION_MISMATCH");
        if (initial.newImport.status === "completed") {
          const results = initial.newImport.results || [];
          if (results.length !== selected.length || !sameSelection(results.map(r => r.externalId), selected) ||
              results.some(r => !["imported", "already_exists", "skipped"].includes(r.status) ||
                (r.status === "imported" && !/^[a-fA-F0-9]{24}$/.test(String(r.propertyId))))) {
            throw newImportError("SYNC_NEW_UNCONFIRMED", 503);
          }
          return { ok: true, runId: String(runId), alreadyImported: true, newImport: safeNewImportSummary(initial.newImport) };
        }
        throw newImportError(initial.newImport.status === "importing" ? "SYNC_NEW_IN_PROGRESS"
          : initial.newImport.status === "indeterminate" ? "SYNC_NEW_UNCONFIRMED" : "SYNC_NEW_ALREADY_ATTEMPTED",
        initial.newImport.status === "indeterminate" ? 503 : 409);
      }
      checkRun(initial, source);
      runFilter = { _id: runId, usuarioId, importSourceId: source._id, sourceIdentityHash: source.feedUrlHash,
        status: "simulated", "newImport.status": "importing", "newImport.selectedExternalIds": selected };
      lock = await budget.run(() => acquireSyncLock({ ImportSourceModel, usuarioId, importSourceId: source._id, env, now }),
        { onLateResult: result => result.release() });
      const freshRun = await budget.run(() => readRun());
      checkRun(freshRun, lock.source);
      const fetched = await fetchXml(lock.feedUrl, { budget });
      budget.assertActive();
      const snapshot = buildSyncSnapshot(fetched.xml);
      if (!snapshot.snapshotComplete) throw newImportError("RUN_SNAPSHOT_INCOMPLETE");
      if (snapshotDigest(snapshot) !== freshRun.snapshotDigest) throw newImportError("SYNC_NEW_FEED_CHANGED");
      let query = PropiedadModel.find({ usuarioId, importSourceId: source._id, source: "crm" });
      if (query?.limit) query = query.limit(MAX_SYNC_PROPERTIES + 1);
      if (query?.lean) query = query.lean();
      const existing = await budget.run(() => query);
      if (existing.length > MAX_SYNC_PROPERTIES) throw newImportError("RUN_SNAPSHOT_INCOMPLETE");
      const current = compareSyncSnapshot(snapshot, existing).results;
      const alreadyExists = [];
      for (const id of selected) {
        if (await budget.run(() => ReconciliationModel.findOne({ usuarioId, importSourceId: source._id, externalId: id }))) {
          throw newImportError("SYNC_NEW_RECONCILIATION_PENDING");
        }
        const matches = existing.filter(p => p.externalId === id);
        if (matches.length > 1) throw newImportError("SYNC_NEW_NOT_NEW");
        if (matches.length === 1) { alreadyExists.push(safeNewResult({ externalId: id, status: "already_exists", reason: "ALREADY_EXISTS", propertyId: String(matches[0]._id) })); continue; }
        const entries = current.filter(item => item.externalId === id);
        if (entries.length !== 1 || entries[0].type !== "NEW") throw newImportError("SYNC_NEW_NOT_NEW");
        if (!entries[0].publishableByData) throw newImportError("SYNC_NEW_INVALID_DATA");
      }
      // Use Phase 2's actual parser, with the full validated snapshot ceiling rather than preview's 500.
      const { nodes, warnings } = parseGenericPropertyNodes(fetched.xml, MAX_SYNC_PROPERTIES + 1);
      if (warnings.length || nodes.length > MAX_SYNC_PROPERTIES) throw newImportError("RUN_SNAPSHOT_INCOMPLETE");
      const analyzed = { feedType: "generic_xml", properties: analyzeGenericPropertyNodes(nodes, { maxPhotos: Infinity }) };
      const remaining = selected.filter(id => !alreadyExists.some(item => item.externalId === id));
      if (remaining.some(id => analyzed.properties.filter(p => p.externalId === id).length !== 1)) throw newImportError("SYNC_NEW_INVALID_DATA");
      await budget.run(() => lock.assert());
      const user = await budget.run(() => UsuarioModel.findById(usuarioId));
      if (!user || user.activo === false) throw newImportError("SYNC_NEW_FAILED", 403);
      checkRun(await budget.run(() => readRun()), lock.source);
      const claimed = await budget.run(() => ImportSyncRunModel.updateOne({ _id: runId, usuarioId, status: "simulated",
        sourceIdentityHash: source.feedUrlHash, snapshotDigest: freshRun.snapshotDigest, expiresAt: { $gt: now() },
        reappearedRestore: { $exists: false },
        $or: [{ newImport: { $exists: false } }, { "newImport.status": "idle" }] },
      { $set: { newImport: { status: "importing", selectedExternalIds: selected, startedAt: now(), results: alreadyExists } } }, { runValidators: true }),
      { onLateResult: async result => {
        if (result.matchedCount) await ImportSyncRunModel.updateOne(runFilter,
          { $set: { "newImport.status": "indeterminate", "newImport.failureCode": "SYNC_NEW_UNCONFIRMED" } });
      } });
      if (claimed.matchedCount !== 1) throw newImportError("SYNC_NEW_RUN_CHANGED");
      started = true;
      const assertOperation = async session => {
        budget.assertActive();
        await lock.assert(session);
        const run = await readRun(session);
        checkRun(run, lock.source, true);
        if (run.snapshotDigest !== freshRun.snapshotDigest) throw newImportError("SYNC_NEW_RUN_CHANGED");
      };
      const internalContext = { source: lock.source, lock,
        assert: () => budget.run(() => assertOperation()),
        beforePersist: async session => {
          await lock.fence(session);
          await assertOperation(session);
        },
        afterPersist: async (session, result) => {
          const receipt = await ImportSyncRunModel.updateOne({ ...runFilter, "newImport.results.externalId": { $ne: result.externalId } },
            { $push: { "newImport.results": safeNewResult(result) } }, { session, runValidators: true });
          if (receipt.matchedCount !== 1) throw newImportError("SYNC_NEW_RUN_CHANGED");
          await assertOperation(session);
        } };
      const outcome = remaining.length ? await runImport({ usuarioId, feedUrl: lock.feedUrl, analyzed,
        selectedExternalIds: remaining, budget, internalContext }) : { results: [] };
      await budget.run(() => lock.assert());
      const stored = await budget.run(() => readRun());
      checkRun(stored, lock.source, true);
      const receipts = stored.newImport.results || [];
      const byId = new Map(receipts.map(item => [item.externalId, safeNewResult(item)]));
      for (const item of outcome.results) {
        if (byId.has(item.externalId)) continue;
        if (item.status === "imported") throw newImportError("SYNC_NEW_UNCONFIRMED", 503);
        byId.set(item.externalId, safeNewResult({ ...item,
          status: item.reason === "duplicate" ? "already_exists" : item.reason === "reconciliation_required" ? "indeterminate" : "skipped",
          reason: ({ duplicate: "ALREADY_EXISTS", reconciliation_required: "RECONCILIATION_REQUIRED", invalid_data: "INVALID_DATA",
            not_started: "NOT_STARTED", creation_failed: "CREATION_FAILED" })[item.reason], imageWarnings: item.warnings?.length || 0 }));
      }
      const results = selected.map(id => byId.get(id) || safeNewResult({ externalId: id, status: "skipped", reason: "NOT_STARTED" }));
      const indeterminate = results.some(r => r.status === "indeterminate");
      const completed = await budget.run(() => ImportSyncRunModel.updateOne(runFilter, { $set: {
        "newImport.status": indeterminate ? "indeterminate" : "completed", "newImport.results": results,
        "newImport.counts": newImportCounts(results), "newImport.completedAt": now(),
        ...(indeterminate ? { "newImport.failureCode": "SYNC_NEW_UNCONFIRMED" } : {})
      } }, { runValidators: true }));
      if (completed.matchedCount !== 1 || indeterminate) throw newImportError("SYNC_NEW_UNCONFIRMED", 503);
      return { ok: true, alreadyImported: false, runId: String(runId), newImport: safeNewImportSummary({ ...stored.newImport,
        status: "completed", results, completedAt: now() }) };
    } catch (error) {
      let code = safeNewFailureCode(error);
      if (started) {
        const unknown = ["IMPORT_TIMEOUT", "SYNC_NEW_UNCONFIRMED"].includes(code) || error.retainImages === true ||
          (!NEW_IMPORT_FAILURE_CODES.has(error.code) && !error.status) ||
          error.hasErrorLabel?.("UnknownTransactionCommitResult");
        try {
          await ImportSyncRunModel.updateOne(runFilter, { $set: { "newImport.status": unknown ? "indeterminate" : "failed",
            "newImport.failureCode": unknown ? "SYNC_NEW_UNCONFIRMED" : code } }, { runValidators: true });
        } catch { console.warn("[CRM Sync Import New]", { code: "SYNC_NEW_UNCONFIRMED" }); }
        if (unknown) code = "SYNC_NEW_UNCONFIRMED";
      }
      throw newImportError(code, code === "SYNC_NEW_UNCONFIRMED" ? 503 : error.status ||
        (code === "SYNC_NEW_FAILED" ? 500 : code === "IMPORT_TIMEOUT" || code === "FEED_TIMEOUT" ? 504 : 409));
    } finally {
      if (lock) await lock.release();
      budget.dispose();
    }
  };
}
