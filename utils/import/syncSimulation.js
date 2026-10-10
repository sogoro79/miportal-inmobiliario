import ImportSource from "../../models/ImportSource.js";
import ImportSyncRun from "../../models/ImportSyncRun.js";
import Propiedad from "../../models/Propiedad.js";
import { fetchFeedXml } from "./feedFetcher.js";
import { decryptFeedUrl } from "./feedUrlCrypto.js";
import { buildSyncSnapshot, MAX_SYNC_PROPERTIES } from "./syncSnapshot.js";
import { compareSyncSnapshot } from "./syncDiff.js";
import { createImportBudget } from "./importBudget.js";

const safeCodes = new Set([
  "SYNC_SOURCE_NOT_CONFIGURED", "SYNC_SOURCE_NOT_FOUND", "SYNC_RUN_FAILED", "SYNC_RUN_SAVE_FAILED",
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
    let query = ImportSourceModel.findOne({ _id: importSourceId, usuarioId, activo: true });
    if (query?.select) query = query.select("+encryptedFeedUrl");
    const source = await query;
    if (!source) throw Object.assign(new Error("Fuente no encontrada."), { code: "SYNC_SOURCE_NOT_FOUND", status: 404 });
    const feedUrl = decryptFeedUrl(source, env);
    if (source.feedType !== "generic_xml") throw Object.assign(new Error("Fuente no configurada."), { code: "SYNC_SOURCE_NOT_CONFIGURED", status: 409 });
    const startedAt = now();
    const run = await ImportSyncRunModel.create({ usuarioId, importSourceId, status: "running", mode: "simulation", startedAt });
    const budget = createImportBudget();
    try {
      const fetched = await fetchXml(feedUrl, { budget });
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
      const diff = compareSyncSnapshot(snapshot, existing.slice(0, MAX_SYNC_PROPERTIES));
      const { results, ...summary } = diff;
      const finishedAt = now();
      const final = { ...summary, status: snapshot.snapshotComplete ? "completed" : "incomplete",
        finishedAt, durationMs: finishedAt.getTime() - startedAt.getTime(),
        snapshotComplete: snapshot.snapshotComplete, snapshotCount: snapshot.snapshotCount, warnings: snapshot.warnings };
      budget.assertActive();
      await ImportSyncRunModel.updateOne({ _id: run._id, usuarioId }, { $set: final });
      return { runId: String(run._id), mode: "simulation", ...final,
        totalResults: results.length, resultsTruncated: results.length > 100, results: results.slice(0, 100) };
    } catch (error) {
      const code = safeSimulationCode(error);
      const finishedAt = now();
      await ImportSyncRunModel.updateOne({ _id: run._id, usuarioId }, { $set: {
        status: "failed", errorCount: 1, errorCode: code, finishedAt, durationMs: finishedAt.getTime() - startedAt.getTime()
      } }).catch(() => console.warn("[CRM Sync Simulation]", { code: "SYNC_RUN_SAVE_FAILED" }));
      throw Object.assign(new Error("No se pudo completar la simulación CRM."), { code, status: code === "FEED_TIMEOUT" || code === "IMPORT_TIMEOUT" ? 504 : 400 });
    } finally { budget.dispose(); }
  };
}
