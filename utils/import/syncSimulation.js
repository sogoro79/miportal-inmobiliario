import ImportSource from "../../models/ImportSource.js";
import ImportSyncRun from "../../models/ImportSyncRun.js";
import Propiedad from "../../models/Propiedad.js";
import ImportReconciliation from "../../models/ImportReconciliation.js";
import Usuario from "../../models/Usuario.js";
import { getPublicationAvailability } from "../propertyCreation.js";
import { hasReappearedMarkers } from "./reappearedEligibility.js";
import { fetchFeedXml } from "./feedFetcher.js";
import { MAX_SYNC_PROPERTIES } from "./syncSnapshot.js";
import { buildFeedSnapshot } from "../importers/importerRegistry.js";
import { receivedNewSnapshotValid } from "./inmowebPolicy.js";
import { createImportBudget } from "./importBudget.js";
import { acquireSyncLock } from "./syncLock.js";
import { prepareSyncPlan, snapshotDigest, safeRunSummary, runVersions, RUN_LIFETIME_MS } from "./syncPlan.js";

const safeCodes = new Set([
  "SYNC_SOURCE_NOT_CONFIGURED", "SYNC_SOURCE_NOT_FOUND", "SYNC_RUN_FAILED", "SYNC_RUN_SAVE_FAILED",
  "SYNC_SOURCE_BUSY", "SYNC_ENROLL_SELECTION_INVALID", "SYNC_SNAPSHOT_INCOMPLETE", "SYNC_ENROLL_BASELINE_MISMATCH",
  "SYNC_EXISTING_LIMIT_EXCEEDED", "XML_INVALID", "XML_DOCTYPE_BLOCKED", "XML_ENTITY_BLOCKED",
  "FEED_TOO_LARGE", "FEED_UNREACHABLE", "FEED_TIMEOUT", "FEED_TRUNCATED", "IMPORT_TIMEOUT",
  "INVALID_URL", "INVALID_PROTOCOL", "PRIVATE_HOST", "PRIVATE_IP", "DNS_LOOKUP_FAILED",
  "BAD_STATUS", "INVALID_CONTENT_TYPE", "TOO_MANY_REDIRECTS", "INVALID_REDIRECT"
]);

export function safeSimulationCode(error) {
  return safeCodes.has(error?.code) ? error.code : "SYNC_RUN_FAILED";
}

export function createSyncSimulator({
  ImportSourceModel = ImportSource, ImportSyncRunModel = ImportSyncRun, PropiedadModel = Propiedad,
  ReconciliationModel = ImportReconciliation, UsuarioModel = Usuario,
  fetchXml = fetchFeedXml, env = process.env, now = () => new Date()
} = {}) {
  return async ({ usuarioId, importSourceId }) => {
    const startedAt = now();
    const budget = createImportBudget();
    let lock;
    let run;
    try {
      lock = await acquireSyncLock({ ImportSourceModel, usuarioId, importSourceId, env, now, allowedFeedTypes: ["generic_xml", "inmoweb"] });
      run = await ImportSyncRunModel.create({ usuarioId, importSourceId, status: "blocked", mode: "simulation", startedAt,
        expiresAt: new Date(startedAt.getTime() + RUN_LIFETIME_MS), ...runVersions,
        sourceIdentityHash: lock.source.feedUrlHash, errorCode: "SIMULATION_IN_PROGRESS" });
      const fetched = await fetchXml(lock.feedUrl, { budget });
      budget.assertActive();
      const snapshot = buildFeedSnapshot(fetched.xml, { feedType: lock.source.feedType });
      let properties = PropiedadModel.find({ usuarioId, importSourceId, source: "crm" });
      if (properties?.select) properties = properties.select("+hiddenByMissingRunId");
      if (properties?.limit) properties = properties.limit(MAX_SYNC_PROPERTIES + 1);
      if (properties?.lean) properties = properties.lean();
      const existing = await budget.run(() => properties);
      if (existing.length > MAX_SYNC_PROPERTIES) {
        snapshot.snapshotComplete = false;
        snapshot.warnings.push("SYNC_EXISTING_LIMIT_EXCEEDED", "MISSING_DISABLED_INCOMPLETE_SNAPSHOT");
      }
      const incomingIds = new Set(snapshot.properties.map(item => item.data.externalId));
      const missing = snapshot.snapshotComplete ? existing.filter(p => !incomingIds.has(p.externalId)) : [];
      const reappeared = existing.filter(p => incomingIds.has(p.externalId) && hasReappearedMarkers(p));
      const reconciliationCandidates = [...missing, ...reappeared];
      let reconciliations = [];
      if (reconciliationCandidates.length) {
        let query = ReconciliationModel.find({ $or: [
          { propiedadId: { $in: reconciliationCandidates.map(p => p._id) } },
          { usuarioId, importSourceId, externalId: { $in: reconciliationCandidates.map(p => p.externalId) } }
        ] });
        if (query?.lean) query = query.lean();
        reconciliations = await budget.run(() => query);
      }
      let causalRuns = [], user, visibleCount;
      if (reappeared.length) {
        const causalIds = [...new Set(reappeared.map(p => String(p.hiddenByMissingRunId))
          .filter(value => /^[a-fA-F0-9]{24}$/.test(value)))];
        if (causalIds.length) {
          let query = ImportSyncRunModel.find({ _id: { $in: causalIds } });
          if (query?.select) query = query.select("+plan");
          if (query?.lean) query = query.lean();
          causalRuns = await budget.run(() => query);
        }
        let query = UsuarioModel.findOne({ _id: usuarioId });
        if (query?.lean) query = query.lean();
        user = await budget.run(() => query);
        if (user) {
          const availability = await budget.run(() => getPublicationAvailability(user, { usuarioId, PropiedadModel }));
          visibleCount = availability.anunciosActuales;
        }
      }
      const { plan, resultsTruncated, ...summary } = prepareSyncPlan(snapshot, existing.slice(0, MAX_SYNC_PROPERTIES),
        { usuarioId, importSourceId, reconciliations, causalRuns, user, visibleCount, now: now(),
          sourceIdentityHash: lock.source.feedUrlHash, snapshotDigest: snapshotDigest(snapshot), versions: runVersions });
      const finishedAt = now();
      const validForNew = receivedNewSnapshotValid(snapshot) && existing.length <= MAX_SYNC_PROPERTIES;
      const simulated = snapshot.snapshotComplete || validForNew;
      const final = { ...summary, plan, planTruncated: resultsTruncated, snapshotDigest: snapshotDigest(snapshot),
        ...(lock.source.feedType === "inmoweb" ? { feedType: "inmoweb", newSnapshotComplete: validForNew,
          providerNormalizationVersion: snapshot.normalizationVersion } : {}),
        status: simulated ? "simulated" : "blocked",
        ...(simulated ? {} : { errorCode: "SYNC_SNAPSHOT_INCOMPLETE" }),
        finishedAt, durationMs: finishedAt.getTime() - startedAt.getTime(),
        snapshotComplete: snapshot.snapshotComplete, snapshotCount: snapshot.snapshotCount, warnings: snapshot.warnings };
      budget.assertActive();
      await lock.assert();
      await ImportSyncRunModel.updateOne({ _id: run._id, usuarioId }, { $set: final,
        ...(simulated ? { $unset: { errorCode: "" } } : {}) });
      return safeRunSummary({ _id: run._id, usuarioId, importSourceId,
        sourceIdentityHash: lock.source.feedUrlHash, ...runVersions,
        createdAt: startedAt, expiresAt: new Date(startedAt.getTime() + RUN_LIFETIME_MS), ...final }, now(), env);
    } catch (error) {
      const code = safeSimulationCode(error);
      const finishedAt = now();
      if (run) await ImportSyncRunModel.updateOne({ _id: run._id, usuarioId }, { $set: {
        status: "failed", errorCount: 1, errorCode: code, finishedAt, durationMs: finishedAt.getTime() - startedAt.getTime()
      } }).catch(() => console.warn("[CRM Sync Simulation]", { code: "SYNC_RUN_SAVE_FAILED" }));
      throw Object.assign(new Error("No se pudo completar la simulación CRM."), { code, status: code === "FEED_TIMEOUT" || code === "IMPORT_TIMEOUT" ? 504 : 400 });
    } finally {
      if (lock) await lock.release();
      budget.dispose();
    }
  };
}
