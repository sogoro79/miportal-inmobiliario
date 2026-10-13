import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import Propiedad from "../../models/Propiedad.js";
import Usuario from "../../models/Usuario.js";
import ImportSource from "../../models/ImportSource.js";
import ImportSyncRun from "../../models/ImportSyncRun.js";
import ImportReconciliation from "../../models/ImportReconciliation.js";
import { fetchFeedXml } from "./feedFetcher.js";
import { buildSyncSnapshot } from "./syncSnapshot.js";
import { snapshotDigest, runVersions } from "./syncPlan.js";
import { safeMissingEligibility, missingContentFingerprint } from "./missingEligibility.js";
import { baselineValid, hasOverrides } from "./syncBaseline.js";
import { safeMissingHideSummary, safeMissingHideCode } from "./missingHideState.js";
import { acquireSyncLock } from "./syncLock.js";
import { createImportBudget } from "./importBudget.js";

const id = value => String(value || "").toLowerCase();
const validId = value => /^[a-f0-9]{24}$/.test(id(value));
const sameSelection = (a,b) => Array.isArray(a) && isDeepStrictEqual([...a].sort(), [...b].sort());
export const missingHideError = (code, status = 409) => Object.assign(new Error("No se pudo confirmar el ocultado CRM."), { code, status });
function reject(code, status) { throw missingHideError(code, status); }
const safeResult = run => ({ runId: String(run._id), ...safeMissingHideSummary(run.missingHide) });

export function createMissingHider({ PropiedadModel = Propiedad, UsuarioModel = Usuario,
  ImportSourceModel = ImportSource, ImportSyncRunModel = ImportSyncRun, ReconciliationModel = ImportReconciliation,
  fetchXml = fetchFeedXml, env = process.env, now = () => new Date() } = {}) {
  return async ({ usuarioId, runId, externalIds }) => {
    if (!validId(usuarioId) || !validId(runId) || !Array.isArray(externalIds) || !externalIds.length || externalIds.length > 10 ||
      new Set(externalIds).size !== externalIds.length || externalIds.some(e => typeof e !== "string" || !e.trim() || e !== e.trim() ||
        e.length > 200 || /https?:\/\/|[<>&?=\u0000-\u001f]/i.test(e))) reject("MISSING_SELECTION_INVALID", 400);
    async function one(Model, filter, session, select) {
      let query = Model.findOne(filter);
      if (select && query?.select) query = query.select(select);
      if (session && query?.session) query = query.session(session);
      if (query?.lean) query = query.lean();
      return query;
    }
    async function userActive(session) {
      const user = await one(UsuarioModel, { _id: usuarioId }, session);
      if (!user || user.activo === false) reject("MISSING_USER_INACTIVE", 403);
    }
    async function readRun(session) {
      const run = await one(ImportSyncRunModel, { _id: runId, usuarioId }, session, "+plan");
      if (!run) reject("SYNC_RUN_NOT_FOUND", 404);
      return run;
    }
    function previous(run) {
      if (!run.missingHide) return null;
      if (!sameSelection(run.missingHide.selectedExternalIds, externalIds)) reject("MISSING_SELECTION_MISMATCH");
      if (run.missingHide.status === "completed") return safeResult(run);
      reject(run.missingHide.status === "indeterminate" ? "MISSING_UNCONFIRMED" :
        ["preparing", "applying"].includes(run.missingHide.status) ? "MISSING_IN_PROGRESS" : "MISSING_OPERATION_BLOCKED");
    }
    function checkRun(run, source, operationId) {
      if (id(run.importSourceId) !== id(source._id) || id(source.usuarioId) !== id(usuarioId) ||
        run.sourceIdentityHash !== source.feedUrlHash || source.activo !== true || source.feedType !== "generic_xml") reject("MISSING_RUN_CHANGED");
      if (run.missingHide && (run.missingHide.operationId !== operationId || run.missingHide.status !== "preparing" ||
        !sameSelection(run.missingHide.selectedExternalIds, externalIds))) reject("MISSING_OPERATION_BLOCKED");
      if (run.status !== "simulated" || run.reappearedRestore || (run.newImport?.status && run.newImport.status !== "idle")) reject("MISSING_OPERATION_BLOCKED");
      const clean = { ...run, missingHide: undefined };
      return externalIds.map(ref => {
        const entries = (run.plan || []).filter(e => e.externalId === ref);
        if (entries.length !== 1 || entries[0].type !== "MISSING" || entries[0].hideMissingEligible !== true) reject("MISSING_SELECTION_INVALID", 400);
        const eligibility = safeMissingEligibility(entries[0], clean, now(), runVersions);
        if (!eligibility.hideMissingEligible) reject(eligibility.hideMissingBlockCode);
        return entries[0];
      });
    }
    await userActive();
    const initial = await readRun();
    const initialSource = await one(ImportSourceModel, { _id: initial.importSourceId, usuarioId, activo: true });
    if (!initialSource) reject("SYNC_SOURCE_NOT_FOUND", 404);
    if (initial.sourceIdentityHash !== initialSource.feedUrlHash) reject("MISSING_RUN_CHANGED");
    const completed = previous(initial);
    if (completed) return completed;
    checkRun(initial, initialSource);
    const budget = createImportBudget();
    let lock, session, operationId, claimed = false;
    try {
      lock = await acquireSyncLock({ ImportSourceModel, usuarioId, importSourceId: initial.importSourceId, env, now });
      checkRun(initial, lock.source);
      const fetched = await fetchXml(lock.feedUrl, { budget });
      budget.assertActive();
      const snapshot = buildSyncSnapshot(fetched.xml);
      if (!snapshot.snapshotComplete) reject("MISSING_SNAPSHOT_INCOMPLETE");
      if (snapshot.properties.some(e => externalIds.includes(e.data.externalId))) reject("MISSING_REAPPEARED");
      if (snapshotDigest(snapshot) !== initial.snapshotDigest) reject("MISSING_FEED_CHANGED");
      await lock.assert();
      operationId = crypto.randomUUID();
      const startedAt = now();
      const intent = await ImportSyncRunModel.updateOne({ _id: runId, usuarioId, status: "simulated",
        expiresAt: { $gt: now() }, missingHide: { $exists: false }, reappearedRestore: { $exists: false } }, { $set: {
        missingHide: { status: "preparing", operationId, selectedExternalIds: externalIds, results: [], startedAt }
      } }, { runValidators: true });
      if (intent.modifiedCount !== 1) reject("MISSING_OPERATION_BLOCKED");
      claimed = true;
      session = await PropiedadModel.startSession();
      let result;
      await session.withTransaction(async () => {
        budget.assertActive();
        await lock.fence(session);
        await userActive(session);
        const run = await readRun(session);
        const source = await one(ImportSourceModel, { _id: run.importSourceId, usuarioId, activo: true }, session);
        if (!source) reject("SYNC_SOURCE_NOT_FOUND", 404);
        const entries = checkRun(run, source, operationId);
        if (run.snapshotDigest !== snapshotDigest(snapshot)) reject("MISSING_RUN_CHANGED");
        let propsQuery = PropiedadModel.find({ usuarioId, importSourceId: run.importSourceId, source: "crm", externalId: { $in: externalIds } });
        if (propsQuery?.select) propsQuery = propsQuery.select("+hiddenByMissingRunId");
        if (propsQuery?.session) propsQuery = propsQuery.session(session);
        if (propsQuery?.lean) propsQuery = propsQuery.lean();
        const properties = await propsQuery;
        let recQuery = ReconciliationModel.find({ $or: [{ propiedadId: { $in: entries.map(e => e.propiedadId) } },
          { usuarioId, importSourceId: run.importSourceId, externalId: { $in: externalIds } }] });
        if (recQuery?.session) recQuery = recQuery.session(session);
        if (recQuery?.lean) recQuery = recQuery.lean();
        if ((await recQuery).length) reject("MISSING_RECONCILIATION_PENDING");
        const applying = await ImportSyncRunModel.updateOne({ _id: runId, usuarioId,
          "missingHide.operationId": operationId, "missingHide.status": "preparing" },
        { $set: { "missingHide.status": "applying" } }, { session, runValidators: true });
        if (applying.modifiedCount !== 1) reject("MISSING_RUN_CHANGED");
        const results = [];
        for (const entry of entries) {
          budget.assertActive();
          const found = properties.filter(p => p.externalId === entry.externalId);
          if (found.length !== 1) reject("MISSING_PROPERTY_CHANGED");
          const p = found[0], evidence = entry.missingEvidence;
          const already = id(p.hiddenByMissingRunId) === id(runId) && p.visiblePublicamente === false &&
            Number.isFinite(new Date(p.removedFromFeedAt).getTime()) && p.removedFromFeedAt != null;
          if (id(p._id) !== id(entry.propiedadId) || id(p.usuarioId) !== id(usuarioId) || id(p.importSourceId) !== id(run.importSourceId) ||
            p.source !== "crm" || hasOverrides(p) || !baselineValid(p) ||
            p.syncApplyFingerprint !== evidence.expectedBaselineFingerprint || p.syncApplyFingerprintVersion !== evidence.baselineVersion ||
            (p.contentRevision ?? 0) !== evidence.expectedContentRevision + (already ? 1 : 0) ||
            (!already && (p.visiblePublicamente !== true || p.hiddenByMissingRunId || p.removedFromFeedAt)) ||
            missingContentFingerprint(already ? { ...p, visiblePublicamente: true } : p) !== evidence.expectedContentFingerprint)
            reject("MISSING_PROPERTY_CHANGED");
          if (already) { results.push({ externalId: entry.externalId, status: "already_hidden" }); continue; }
          const revision = evidence.expectedContentRevision;
          const changed = await PropiedadModel.updateOne({ _id: entry.propiedadId, usuarioId,
            importSourceId: run.importSourceId, source: "crm", externalId: entry.externalId,
            visiblePublicamente: true, hiddenByMissingRunId: null, removedFromFeedAt: null, syncEnabled: true,
            syncApplyFingerprint: evidence.expectedBaselineFingerprint, syncApplyFingerprintVersion: evidence.baselineVersion,
            $or: revision === 0 ? [{ contentRevision: 0 }, { contentRevision: { $exists: false } }] : [{ contentRevision: revision }]
          }, { $set: { visiblePublicamente: false, removedFromFeedAt: now(), hiddenByMissingRunId: runId },
            $inc: { contentRevision: 1 } }, { session, runValidators: true });
          if (changed.modifiedCount !== 1) reject("MISSING_PROPERTY_CHANGED");
          results.push({ externalId: entry.externalId, status: "hidden" });
        }
        budget.assertActive(); await lock.assert(session);
        checkRun(run, source, operationId);
        const receipt = { status: "completed", operationId, selectedExternalIds: externalIds, results, startedAt,
          completedAt: now(), countHidden: results.filter(r => r.status === "hidden").length,
          countAlreadyHidden: results.filter(r => r.status === "already_hidden").length };
        const saved = await ImportSyncRunModel.updateOne({ _id: runId, usuarioId, "missingHide.operationId": operationId,
          "missingHide.status": "applying" }, { $set: { missingHide: receipt } }, { session, runValidators: true });
        if (saved.modifiedCount !== 1) reject("MISSING_RUN_CHANGED");
        result = safeResult({ ...run, missingHide: receipt });
      }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 10000 });
      return result;
    } catch (error) {
      const unknown = error?.hasErrorLabel?.("UnknownTransactionCommitResult") || error?.errorLabels?.includes("UnknownTransactionCommitResult");
      const code = unknown ? "MISSING_UNCONFIRMED" : safeMissingHideCode(error);
      if (claimed) await ImportSyncRunModel.updateOne({ _id: runId, usuarioId, "missingHide.operationId": operationId,
        "missingHide.status": { $in: ["preparing", "applying"] } }, { $set: {
        "missingHide.status": unknown ? "indeterminate" : "failed", "missingHide.errorCode": code,
        ...(!unknown ? { "missingHide.results": externalIds.map(externalId => ({ externalId, status: "failed", code })),
          "missingHide.countHidden": 0, "missingHide.countAlreadyHidden": 0, "missingHide.completedAt": now() } : {})
      } }, { runValidators: true }).catch(() => console.warn("[CRM Missing Hide]", { code: "MISSING_UNCONFIRMED" }));
      throw missingHideError(code, unknown ? 503 : error?.status || 409);
    } finally {
      if (session) await session.endSession().catch(() => {});
      if (lock) await lock.release();
      budget.dispose();
    }
  };
}
