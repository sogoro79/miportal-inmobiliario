import { safeRunSummary, runVersions, snapshotDigest } from "./syncPlan.js";
import { assertInmowebNewSelectionAllowed, receivedNewSnapshotValid } from "./inmowebPolicy.js";
import { SNAPSHOT_REQUIRED } from "./providerSnapshots.js";

const reusable = run => run.status === "simulated" && !run.blocked && !run.errorCode &&
  !run.missingHide && !run.reappearedRestore && (!run.newImport || run.newImport.status === "idle") &&
  !run.planTruncated && !run.resultsTruncated && Array.isArray(run.plan) &&
  run.snapshotComplete === false && run.newSnapshotComplete === true && run.providerNormalizationVersion === 1 &&
  Object.entries(runVersions).every(([key, version]) => run[key] === version);
const sameSource = (run, source, owner) => source?.activo === true && source.feedType === "inmoweb" &&
  String(source.usuarioId) === String(owner) && String(run.usuarioId) === String(owner) &&
  String(run.importSourceId) === String(source._id) && run.sourceIdentityHash === source.feedUrlHash;

// Presentation only: never fetches a feed or acquires a lock, and never writes.
// Import NEW remains the final authority for live ownership/plan/capacity/conflicts.
export function createInmowebRunReader({ ImportSourceModel, ImportSyncRunModel, providerSnapshots,
  now = () => new Date(), env = process.env }) {
  async function sourceFor(owner) {
    let query = ImportSourceModel.findOne({ usuarioId: owner, activo: true });
    if (query?.select) query = query.select("_id usuarioId feedType activo feedUrlHash");
    if (query?.lean) query = query.lean();
    return query;
  }
  async function evaluate(run, owner, source) {
    const dto = safeRunSummary(run, now(), env);
    if (run.feedType !== "inmoweb") return dto;
    source ??= await sourceFor(owner);
    let evidence, blocked = dto.newImportBlockedReason;
    if (!sameSource(run, source, owner)) blocked = "SYNC_NEW_SOURCE_CHANGED";
    else if (!reusable(run)) blocked = blocked || "SYNC_NEW_RUN_CHANGED";
    else if (!(new Date(run.expiresAt).getTime() > +now())) blocked = "RUN_EXPIRED";
    else {
      try {
        evidence = await providerSnapshots.readPersisted({ run, usuarioId: owner, source });
        if (!receivedNewSnapshotValid(evidence.snapshot) || snapshotDigest(evidence.snapshot) !== run.snapshotDigest ||
            new Date(evidence.expiresAt).getTime() < +now()) throw new Error("Unavailable review");
      } catch { evidence = undefined; blocked = blocked || SNAPSHOT_REQUIRED; }
    }
    if (!evidence) blocked ||= SNAPSHOT_REQUIRED;
    dto.snapshotState = evidence ? "valid" : "unavailable";
    if (evidence) {
      dto.feedFetchedAt = evidence.fetchedAt;
      dto.snapshotExpiresAt = evidence.expiresAt;
    }
    dto.applyEligible = false;
    dto.snapshotComplete = false;
    for (const row of dto.results) {
      row.enrollmentEligible = false;
      if (row.type === "MISSING") row.hideMissingEligible = false;
      if (row.type === "REAPPEARED") row.restoreEligible = false;
      if (row.type !== "NEW") continue;
      let reason = blocked;
      const items = evidence?.snapshot.properties.filter(p => p.data.externalId === row.externalId) || [];
      if (!reason && (items.length !== 1 || items[0].publishableByData !== true || items[0].errors.length)) reason = "SYNC_NEW_INVALID_DATA";
      if (!reason) {
        try { assertInmowebNewSelectionAllowed("inmoweb", [row.externalId], env); }
        catch (error) { reason = error.code === "INMOWEB_NEW_DISABLED" ? error.code : "INMOWEB_NEW_EXTERNAL_ID_NOT_ALLOWED"; }
      }
      row.importNewEligible = !reason;
      row.importNewBlockCode = reason || null;
    }
    dto.newImportEligible = !blocked && dto.results.some(row => row.type === "NEW" && row.importNewEligible);
    dto.newImportBlockedReason = dto.newImportEligible ? null : blocked || "INMOWEB_NEW_EXTERNAL_ID_NOT_ALLOWED";
    return dto;
  }
  return {
    evaluate,
    async byId(id, owner) {
      let query = ImportSyncRunModel.findOne({ _id: id, usuarioId: owner });
      if (query?.select) query = query.select("+plan");
      if (query?.lean) query = query.lean();
      const run = await query;
      return run && String(run.usuarioId) === String(owner) ? evaluate(run, owner) : null;
    },
    async latest(owner) {
      const source = await sourceFor(owner);
      if (!source || source.feedType !== "inmoweb" || source.activo !== true || String(source.usuarioId) !== String(owner)) return null;
      // Do not filter by status or walk backwards past a consumed/indeterminate run.
      let query = ImportSyncRunModel.findOne({ usuarioId: owner, importSourceId: source._id });
      query = query.sort({ startedAt: -1, _id: -1 });
      if (query?.select) query = query.select("+plan");
      if (query?.lean) query = query.lean();
      const run = await query;
      if (!run || run.feedType !== "inmoweb" || !sameSource(run, source, owner) || !reusable(run)) return null;
      return evaluate(run, owner, source);
    }
  };
}
