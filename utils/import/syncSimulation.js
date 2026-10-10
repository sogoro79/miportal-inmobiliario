import ImportSource from "../../models/ImportSource.js";
import ImportSyncRun from "../../models/ImportSyncRun.js";
import Propiedad from "../../models/Propiedad.js";
import { fetchFeedXml } from "./feedFetcher.js";
import { buildSyncSnapshot, MAX_SYNC_PROPERTIES } from "./syncSnapshot.js";
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
  fetchXml = fetchFeedXml, env = process.env, now = () => new Date()
} = {}) {
  return async ({ usuarioId, importSourceId }) => {
    const startedAt = now();
    const budget = createImportBudget();
    let lock;
    let run;
    try {
      lock = await acquireSyncLock({ ImportSourceModel, usuarioId, importSourceId, env, now });
      run = await ImportSyncRunModel.create({ usuarioId, importSourceId, status: "blocked", mode: "simulation", startedAt,
        expiresAt: new Date(startedAt.getTime() + RUN_LIFETIME_MS), ...runVersions,
        sourceIdentityHash: lock.source.feedUrlHash, errorCode: "SIMULATION_IN_PROGRESS" });
      const fetched = await fetchXml(lock.feedUrl, { budget });
      budget.assertActive();
      const snapshot = buildSyncSnapshot(fetched.xml);
      let properties = PropiedadModel.find({ usuarioId, importSourceId, source: "crm" });
      if (properties?.limit) properties = properties.limit(MAX_SYNC_PROPERTIES + 1);
      if (properties?.lean) properties = properties.lean();
      const existing = await budget.run(() => properties);
      if (existing.length > MAX_SYNC_PROPERTIES) {
        snapshot.snapshotComplete = false;
        snapshot.warnings.push("SYNC_EXISTING_LIMIT_EXCEEDED", "MISSING_DISABLED_INCOMPLETE_SNAPSHOT");
      }
      const { plan, resultsTruncated, ...summary } = prepareSyncPlan(snapshot, existing.slice(0, MAX_SYNC_PROPERTIES));
      const finishedAt = now();
      const final = { ...summary, plan, planTruncated: resultsTruncated, snapshotDigest: snapshotDigest(snapshot),
        status: snapshot.snapshotComplete ? "simulated" : "blocked",
        ...(snapshot.snapshotComplete ? {} : { errorCode: "SYNC_SNAPSHOT_INCOMPLETE" }),
        finishedAt, durationMs: finishedAt.getTime() - startedAt.getTime(),
        snapshotComplete: snapshot.snapshotComplete, snapshotCount: snapshot.snapshotCount, warnings: snapshot.warnings };
      budget.assertActive();
      await lock.assert();
      await ImportSyncRunModel.updateOne({ _id: run._id, usuarioId }, { $set: final,
        ...(snapshot.snapshotComplete ? { $unset: { errorCode: "" } } : {}) });
      return safeRunSummary({ _id: run._id, createdAt: startedAt, expiresAt: new Date(startedAt.getTime() + RUN_LIFETIME_MS), ...final }, now());
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
