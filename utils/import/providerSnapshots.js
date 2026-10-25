import { randomUUID } from "node:crypto";
import { buildFeedSnapshot } from "../importers/importerRegistry.js";
import { snapshotDigest, runVersions } from "./syncPlan.js";

export const SNAPSHOT_REQUIRED = "INMOWEB_FRESH_SNAPSHOT_REQUIRED";
export const SNAPSHOT_MESSAGE = "Actualiza y revisa los inmuebles de InmoWeb antes de importar.";
const reject = () => { throw Object.assign(new Error(SNAPSHOT_MESSAGE), { code: SNAPSHOT_REQUIRED, status: 409 }); };

// Server-only evidence of successful transport. No URL or client-supplied snapshot.
// Process-local: restart/eviction loses leases and NEW fails closed, without refetch.
export function createProviderSnapshots({ now = Date.now, ttlMs = 300_000, maxEntries = 100,
  maxBytes = 32 * 1024 * 1024 } = {}) {
  const captures = new Map(), leases = new Map();
  const valid = capture => capture && now() >= capture.at && now() - capture.at <= Math.min(ttlMs, 300_000);
  function prune() {
    for (const [id, capture] of captures) if (!valid(capture)) captures.delete(id);
    for (const [id, lease] of leases) if (!captures.has(lease.captureId)) leases.delete(id);
  }
  function matches(run, capture, owner) {
    return String(run.usuarioId) === String(owner) && capture.owner === String(owner) && run.feedType === "inmoweb" && capture.provider === "inmoweb" &&
      run.sourceIdentityHash === capture.sourceHash && run.snapshotDigest === capture.digest &&
      run.providerNormalizationVersion === capture.snapshot.normalizationVersion &&
      Object.entries(runVersions).every(([key, version]) => run[key] === version);
  }
  return {
    record({ xml, usuarioId, sourceHash, fetchedAt }) {
      prune();
      const at = Date.parse(fetchedAt), id = randomUUID();
      const bytes = Buffer.byteLength(xml);
      let used = [...captures.values()].reduce((total, capture) => total + capture.bytes, 0);
      while (captures.size && (captures.size >= maxEntries || used + bytes > maxBytes)) {
        const oldest = captures.keys().next().value;
        used -= captures.get(oldest).bytes; captures.delete(oldest);
      }
      if (bytes > maxBytes) return undefined;
      captures.set(id, { xml, owner: String(usuarioId), sourceHash, at, bytes });
      prune();
      return id;
    },
    bind({ fetched, run, usuarioId }) {
      prune();
      const capture = captures.get(fetched.captureId);
      if (!valid(capture) || capture.xml !== fetched.xml) reject();
      const snapshot = buildFeedSnapshot(capture.xml, { feedType: "inmoweb" });
      capture.provider = "inmoweb";
      capture.snapshot = snapshot;
      capture.digest = snapshotDigest(snapshot);
      if (!matches(run, capture, usuarioId)) reject();
      if (leases.size >= maxEntries) leases.delete(leases.keys().next().value);
      leases.set(String(run._id), { captureId: fetched.captureId, sourceId: String(run.importSourceId) });
    },
    get({ run, usuarioId, source }) {
      prune();
      const lease = leases.get(String(run._id));
      const capture = lease && captures.get(lease.captureId);
      if (!valid(capture) || !capture.snapshot || !matches(run, capture, usuarioId) ||
          lease.sourceId !== String(source._id) || String(run.importSourceId) !== lease.sourceId ||
          source.feedType !== "inmoweb" || String(source.usuarioId) !== String(usuarioId) ||
          source.feedUrlHash !== capture.sourceHash || !(new Date(run.expiresAt).getTime() > now())) reject();
      return structuredClone(capture.snapshot);
    }
  };
}
