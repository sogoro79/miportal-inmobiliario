import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import ProviderSnapshot from "../models/ProviderSnapshot.js";
import { createProviderSnapshots, SNAPSHOT_REQUIRED } from "../utils/import/providerSnapshots.js";
import { createFeedAccess } from "../utils/import/feedAccess.js";
import { snapshotDigest, runVersions } from "../utils/import/syncPlan.js";
import { buildFeedSnapshot } from "../utils/importers/importerRegistry.js";
import { providerSnapshotStore } from "./helpers/providerSnapshotStore.js";

const xml = fs.readFileSync(new URL("./fixtures/crm/inmoweb-synthetic.xml", import.meta.url), "utf8");
const feedUrl = "https://feed.example.test/private/catalog?key=synthetic-feed-key";
const owner = "507f1f77bcf86cd799439099", sourceId = "507f1f77bcf86cd799439098", runId = "507f1f77bcf86cd799439097";
async function setup({ persist = true, ttlMs = 300_000 } = {}) {
  let time = Date.parse("2026-01-01T18:00:00Z"), fetches = 0;
  const env = { CRM_FEED_URL_KEY_V1: crypto.randomBytes(32).toString("base64") };
  const db = providerSnapshotStore(), now = () => time;
  const create = () => createProviderSnapshots({ now, env, ttlMs, SnapshotModel: db.Model });
  const memory = create();
  const access = createFeedAccess({ now, snapshots: memory, log: () => {}, fetchXml: async () => { fetches++; return { xml }; } });
  const fetched = await access(feedUrl, { usuarioId: owner, feedType: "inmoweb", fresh: false });
  const normalized = buildFeedSnapshot(xml, { feedType: "inmoweb" });
  const hash = crypto.createHash("sha256").update(feedUrl).digest("hex");
  const run = { ...runVersions, _id: runId, usuarioId: owner, importSourceId: sourceId, feedType: "inmoweb",
    providerNormalizationVersion: normalized.normalizationVersion, snapshotDigest: snapshotDigest(normalized),
    sourceIdentityHash: hash, expiresAt: new Date(time + 1_200_000) };
  const source = { _id: sourceId, usuarioId: owner, feedType: "inmoweb", feedUrlHash: hash };
  const args = { run, source, usuarioId: owner };
  if (persist) await memory.bind({ fetched, run, usuarioId: owner });
  return { db, env, memory, create, args, fetched, run, source, now, fetches: () => fetches,
    advance: ms => { time += ms; }, doc: () => db.docs.get(runId) };
}

test("valid persisted capture survives process cache restart and then uses memory without repeated DB reads", async () => {
  const h = await setup(), restarted = h.create();
  const loaded = await restarted.get(h.args);
  assert.equal(snapshotDigest(loaded), h.run.snapshotDigest);
  assert.equal(h.db.effects.reads, 1);
  loaded.properties.length = 0;
  assert.equal(snapshotDigest(await restarted.get(h.args)), h.run.snapshotDigest);
  assert.equal(h.db.effects.reads, 1); assert.equal(h.fetches(), 1);
});
test("original valid memory fast path requires no DB read", async () => {
  const h = await setup(); h.db.faults.read = true;
  assert.equal(snapshotDigest(await h.memory.get(h.args)), h.run.snapshotDigest);
  assert.equal(h.db.effects.reads, 0);
});
test("TTL cleanup delay cannot authorize old documents; exact five-minute boundary is allowed", async () => {
  const h = await setup({ ttlMs: 900_000 });
  assert.equal(+h.doc().expiresAt - +h.doc().fetchedAt, 300_000);
  h.advance(300_000); assert.equal(snapshotDigest(await h.create().get(h.args)), h.run.snapshotDigest);
  h.advance(1);
  await assert.rejects(h.create().get(h.args), { code: SNAPSHOT_REQUIRED });
  assert.equal(h.db.docs.size, 1); assert.equal(h.fetches(), 1);
});
for (const change of ["owner", "source-owner", "source", "identity", "run", "digest", "normalization", "adapter", "run-expired", "provider"]) {
  test(`persisted snapshot rejects mismatched ${change}`, async () => {
    const h = await setup();
    if (change === "owner") h.args.usuarioId = "other";
    if (change === "source-owner") h.source.usuarioId = "other";
    if (change === "source") h.source._id = "other";
    if (change === "identity") h.source.feedUrlHash = "f".repeat(64);
    if (change === "run") h.run._id = "507f1f77bcf86cd799439096";
    if (change === "digest") h.run.snapshotDigest = "f".repeat(64);
    if (change === "normalization") h.run.normalizationVersion++;
    if (change === "adapter") h.run.providerNormalizationVersion++;
    if (change === "run-expired") h.run.expiresAt = new Date(0);
    if (change === "provider") h.run.feedType = "generic_xml";
    await assert.rejects(h.create().get(h.args), { code: SNAPSHOT_REQUIRED });
    assert.equal(h.fetches(), 1);
  });
}
for (const change of ["ciphertext", "expiresAt", "fetchedAt", "key", "missing-key", "read-error", "missing"]) {
  test(`persisted ${change} fails closed without exposing details or refetching`, async () => {
    const h = await setup();
    if (change === "ciphertext") h.doc().encryptedSnapshot = h.doc().encryptedSnapshot.replace(/^./, c => c === "A" ? "B" : "A");
    if (change === "expiresAt") h.doc().expiresAt = new Date(+h.doc().expiresAt + 1000);
    if (change === "fetchedAt") h.doc().fetchedAt = new Date(+h.doc().fetchedAt - 1000);
    if (change === "key") h.env.CRM_FEED_URL_KEY_V1 = crypto.randomBytes(32).toString("base64");
    if (change === "missing-key") delete h.env.CRM_FEED_URL_KEY_V1;
    if (change === "read-error") h.db.faults.read = true;
    if (change === "missing") h.db.docs.clear();
    await assert.rejects(h.create().get(h.args), error => {
      assert.equal(error.code, SNAPSHOT_REQUIRED);
      assert.doesNotMatch(error.message, /database|key|https|cipher|private/); return true;
    });
    assert.equal(h.fetches(), 1);
  });
}
test("expiresAt is rechecked after DB await, and transaction session is forwarded", async () => {
  const h = await setup(); const session = { synthetic: true };
  h.db.faults.beforeRead = () => h.advance(300_001);
  await assert.rejects(h.create().get({ ...h.args, session }), { code: SNAPSHOT_REQUIRED });
  assert.deepEqual(h.db.effects.sessions, [session]);
});
test("stored document contains only allowlisted metadata and ciphertext, not XML, URLs, content or key material", async () => {
  const h = await setup(); const text = JSON.stringify(h.doc());
  assert.doesNotMatch(text, /https?:|synthetic-feed-key|<propiedad|<properties|SYNTHETIC-REF|imagenes|fotos/);
  assert.equal(text.includes(h.env.CRM_FEED_URL_KEY_V1), false);
  assert.deepEqual(Object.keys(h.doc()).sort(), ["runId", "usuarioId", "importSourceId", "provider", "sourceIdentityHash",
    "snapshotDigest", "fetchedAt", "expiresAt", "snapshotVersion", "normalizationVersion", "applyFieldsVersion",
    "providerAdapterVersion", "encryptedSnapshot", "keyVersion"].sort());
  await new ProviderSnapshot(h.doc()).validate(); // schema validation only; no connection
});
test("model has unique run binding, zero-delay TTL index and rejects arbitrary plaintext fields", async () => {
  assert.ok(ProviderSnapshot.schema.indexes().some(([fields, options]) => fields.runId === 1 && options.unique));
  assert.ok(ProviderSnapshot.schema.indexes().some(([fields, options]) => fields.expiresAt === 1 && options.expireAfterSeconds === 0));
  const h = await setup();
  assert.throws(() => new ProviderSnapshot({ ...h.doc(), feedUrl }), /strict mode/);
  assert.equal(ProviderSnapshot.schema.path("encryptedSnapshot").options.select, false);
});
test("repeat binding cannot extend lifetime; failed persistence does not install a memory lease", async () => {
  const h = await setup(); const before = structuredClone(h.doc());
  h.advance(1000); await h.memory.bind({ fetched: h.fetched, run: h.run, usuarioId: owner });
  assert.deepEqual(h.doc(), before); assert.equal(h.db.effects.inserts, 1);
  const failed = await setup({ persist: false }); failed.db.faults.write = true;
  await assert.rejects(failed.memory.bind({ fetched: failed.fetched, run: failed.run, usuarioId: owner }), { code: SNAPSHOT_REQUIRED });
  await assert.rejects(failed.memory.get(failed.args), { code: SNAPSHOT_REQUIRED });
});
