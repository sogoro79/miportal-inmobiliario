import { randomUUID } from "node:crypto";
import { buildFeedSnapshot } from "../importers/importerRegistry.js";
import { snapshotDigest, runVersions } from "./syncPlan.js";
import { encryptProviderSnapshot, decryptProviderSnapshot } from "./providerSnapshotCrypto.js";

export const SNAPSHOT_REQUIRED = "INMOWEB_FRESH_SNAPSHOT_REQUIRED";
export const SNAPSHOT_MESSAGE = "Actualiza y revisa los inmuebles de InmoWeb antes de importar.";
const reject = () => { throw Object.assign(new Error(SNAPSHOT_MESSAGE), { code: SNAPSHOT_REQUIRED, status: 409 }); };

// Only successful transport can mint a capture. Persistence stores authenticated,
// encrypted normalized data bound to one immutable run, never XML or a feed URL.
export function createProviderSnapshots({ now = Date.now, ttlMs = 300_000, maxEntries = 100,
  maxBytes = 32 * 1024 * 1024, SnapshotModel, env = process.env } = {}) {
  const captures = new Map(), leases = new Map();
  const lifetime = Math.min(ttlMs, 300_000);
  const valid = capture => capture && Number.isFinite(capture.at) && Number.isFinite(capture.expiresAt) &&
    now() >= capture.at && now() <= capture.expiresAt && now() - capture.at <= lifetime &&
    capture.expiresAt <= capture.at + lifetime;
  function prune() {
    for (const [id, capture] of captures) if (!valid(capture)) captures.delete(id);
    for (const [id, lease] of leases) if (!captures.has(lease.captureId)) leases.delete(id);
  }
  function retain(id, capture) {
    prune();
    let used = [...captures.values()].reduce((total, item) => total + item.bytes, 0);
    while (captures.size && (captures.size >= maxEntries || used + capture.bytes > maxBytes)) {
      const oldest = captures.keys().next().value;
      used -= captures.get(oldest).bytes; captures.delete(oldest);
    }
    if (capture.bytes > maxBytes) return false;
    captures.set(id, capture); prune();
    return true;
  }
  function matches(run, capture, owner) {
    return String(run.usuarioId) === String(owner) && capture.owner === String(owner) && run.feedType === "inmoweb" && capture.provider === "inmoweb" &&
      run.sourceIdentityHash === capture.sourceHash && run.snapshotDigest === capture.digest &&
      run.providerNormalizationVersion === capture.snapshot.normalizationVersion &&
      Object.entries(runVersions).every(([key, version]) => run[key] === version);
  }
  function validate(capture, lease, { run, usuarioId, source }) {
    if (!valid(capture) || !capture.snapshot || !matches(run, capture, usuarioId) ||
        lease.sourceId !== String(source._id) || String(run.importSourceId) !== lease.sourceId ||
        source.feedType !== "inmoweb" || String(source.usuarioId) !== String(usuarioId) ||
        source.feedUrlHash !== capture.sourceHash || !(new Date(run.expiresAt).getTime() > now())) reject();
  }
  function attach(run, captureId) {
    if (leases.size >= maxEntries) leases.delete(leases.keys().next().value);
    leases.set(String(run._id), { captureId, sourceId: String(run.importSourceId) });
  }
  const identity = run => ({ runId: run._id, usuarioId: run.usuarioId, importSourceId: run.importSourceId,
    provider: "inmoweb", sourceIdentityHash: run.sourceIdentityHash, snapshotDigest: run.snapshotDigest,
    ...runVersions, providerAdapterVersion: run.providerNormalizationVersion });
  function decode(doc, run) {
    if (!doc || Object.entries(identity(run)).some(([key, value]) => String(doc[key]) !== String(value))) reject();
    const capture = { owner: String(doc.usuarioId), provider: doc.provider, sourceHash: doc.sourceIdentityHash,
      at: new Date(doc.fetchedAt).getTime(), expiresAt: new Date(doc.expiresAt).getTime(), digest: doc.snapshotDigest };
    if (!valid(capture)) reject(); // TTL index is cleanup only; never a validity guarantee.
    capture.snapshot = decryptProviderSnapshot(doc, env);
    if (capture.snapshot.feedType !== "inmoweb" || snapshotDigest(capture.snapshot) !== capture.digest ||
        !matches(run, capture, run.usuarioId)) reject();
    capture.bytes = Buffer.byteLength(JSON.stringify(capture.snapshot));
    return capture;
  }
  async function persist(capture, fetched, run) {
    try {
      const metadata = { ...identity(run), fetchedAt: new Date(capture.at), expiresAt: new Date(capture.expiresAt) };
      const doc = { ...metadata, ...encryptProviderSnapshot(capture.snapshot, metadata, env) };
      await SnapshotModel.init?.();
      // Insert-only: retries cannot refresh fetchedAt, extend TTL or rebind a run.
      let query = SnapshotModel.findOneAndUpdate({ runId: run._id }, { $setOnInsert: doc },
        { upsert: true, new: true, runValidators: true });
      if (query?.select) query = query.select("+encryptedSnapshot");
      if (query?.lean) query = query.lean();
      const saved = decode(await query, run);
      if (saved.at !== capture.at || saved.expiresAt !== capture.expiresAt) reject();
      if (!valid(capture)) reject();
      attach(run, fetched.captureId);
    } catch { reject(); }
  }
  async function restore(args) {
    const { run, usuarioId, source, session } = args;
    try {
      if (!SnapshotModel || run.feedType !== "inmoweb" || String(run.usuarioId) !== String(usuarioId) ||
          String(source.usuarioId) !== String(usuarioId) || source.feedType !== "inmoweb" ||
          source.feedUrlHash !== run.sourceIdentityHash || String(run.importSourceId) !== String(source._id)) reject();
      let query = SnapshotModel.findOne({ ...identity(run), expiresAt: { $gte: new Date(now()) } });
      if (query?.select) query = query.select("+encryptedSnapshot");
      if (session && query?.session) query = query.session(session);
      if (query?.lean) query = query.lean();
      const capture = decode(await query, run);
      const id = randomUUID(), lease = { sourceId: String(source._id) };
      validate(capture, lease, args); // Recheck clock after the asynchronous DB read.
      if (retain(id, capture)) attach(run, id);
      return structuredClone(capture.snapshot);
    } catch { reject(); }
  }
  return {
    record({ xml, usuarioId, sourceHash, fetchedAt }) {
      const at = Date.parse(fetchedAt), id = randomUUID();
      return retain(id, { xml, owner: String(usuarioId), sourceHash, at,
        expiresAt: at + lifetime, bytes: Buffer.byteLength(xml) }) ? id : undefined;
    },
    bind({ fetched, run, usuarioId }) {
      prune();
      const capture = captures.get(fetched.captureId);
      if (!valid(capture) || capture.xml !== fetched.xml) reject();
      const snapshot = buildFeedSnapshot(capture.xml, { feedType: "inmoweb" });
      capture.provider = "inmoweb"; capture.snapshot = snapshot; capture.digest = snapshotDigest(snapshot);
      if (!matches(run, capture, usuarioId)) reject();
      if (SnapshotModel) return persist(capture, fetched, run);
      attach(run, fetched.captureId);
    },
    get(args) {
      prune();
      const lease = leases.get(String(args.run._id));
      const capture = lease && captures.get(lease.captureId);
      if (!capture) return SnapshotModel ? restore(args) : reject();
      validate(capture, lease, args);
      return structuredClone(capture.snapshot);
    }
  };
}
