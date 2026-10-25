import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { createFeedAccess } from "../utils/import/feedAccess.js";
import { createProviderSnapshots, SNAPSHOT_REQUIRED } from "../utils/import/providerSnapshots.js";
import { inmowebAvailable, INMOWEB_UNAVAILABLE } from "../utils/import/inmowebAvailability.js";
import { buildFeedSnapshot } from "../utils/importers/importerRegistry.js";
import { snapshotDigest, runVersions } from "../utils/import/syncPlan.js";

const xml = fs.readFileSync(new URL("./fixtures/crm/inmoweb-synthetic.xml", import.meta.url), "utf8");
const url = "https://feed.example.test/catalog?key=synthetic";
const owner = "synthetic-owner", hash = createHash("sha256").update(url).digest("hex");
for (const [date, expected] of [
  ["2026-01-01T16:59:59Z", false], ["2026-01-01T17:00:00Z", true],
  ["2026-01-02T07:59:59Z", true], ["2026-01-02T08:00:00Z", false],
  ["2026-07-01T15:59:59Z", false], ["2026-07-01T16:00:00Z", true],
  ["2026-07-02T06:59:59Z", true], ["2026-07-02T07:00:00Z", false],
  ["2026-03-29T01:30:00Z", true], ["2026-10-25T00:30:00Z", true], ["2026-10-25T01:30:00Z", true]
]) test(`Madrid availability ${date}`, () => assert.equal(inmowebAvailable(Date.parse(date)), expected));

function setup(date = "2026-01-01T18:00:00Z") {
  let time = Date.parse(date), calls = 0;
  const snapshots = createProviderSnapshots({ now: () => time });
  const access = createFeedAccess({ now: () => time, snapshots, log: () => {}, fetchXml: async () => { calls++; return { xml }; } });
  const snapshot = buildFeedSnapshot(xml, { feedType: "inmoweb" });
  const run = { ...runVersions, _id: "run-one", usuarioId: owner, importSourceId: "source-one", feedType: "inmoweb",
    providerNormalizationVersion: snapshot.normalizationVersion, snapshotDigest: snapshotDigest(snapshot),
    sourceIdentityHash: hash, expiresAt: new Date(time + 1_200_000) };
  const source = { _id: "source-one", usuarioId: owner, feedType: "inmoweb", feedUrlHash: hash };
  const read = () => access(url, { usuarioId: owner, feedType: "inmoweb", fresh: false });
  const get = (changes = {}) => snapshots.get({ run, source, usuarioId: owner, ...changes });
  return { snapshots, access, read, get, run, source, calls: () => calls, advance: ms => { time += ms; } };
}
test("outside availability no download; generic XML remains unrestricted", async () => {
  const h = setup("2026-01-01T12:00:00Z");
  await assert.rejects(h.read(), { code: INMOWEB_UNAVAILABLE }); assert.equal(h.calls(), 0);
  await h.access(url, { usuarioId: owner, feedType: "generic_xml", fresh: false }); assert.equal(h.calls(), 1);
});
test("fresh cached read works across closing time, expires without a provider request", async () => {
  const h = setup("2026-01-01T07:59:00Z");
  const fetched = await h.read(); h.advance(120_000);
  assert.equal((await h.read()).captureId, fetched.captureId); assert.equal(h.calls(), 1);
  h.advance(180_001); await assert.rejects(h.read(), { code: INMOWEB_UNAVAILABLE }); assert.equal(h.calls(), 1);
});
test("exact run lease is bound to successful transport and allows age <= five minutes", async () => {
  const h = setup(); const fetched = await h.read();
  h.snapshots.bind({ fetched, run: h.run, usuarioId: owner });
  assert.equal(snapshotDigest(h.get()), h.run.snapshotDigest);
  h.advance(300_000); assert.equal(snapshotDigest(h.get()), h.run.snapshotDigest);
  h.advance(1); assert.throws(() => h.get(), { code: SNAPSHOT_REQUIRED }); assert.equal(h.calls(), 1);
});
for (const kind of ["digest", "identity", "owner", "source", "run", "providerVersion", "normalization", "expired", "restart", "missing", "forged"]) {
  test(`lease rejects ${kind} without any fallback download`, async () => {
    const h = setup(); const fetched = await h.read();
    if (kind !== "missing") h.snapshots.bind({ fetched, run: h.run, usuarioId: owner });
    if (kind === "digest") h.run.snapshotDigest = "f".repeat(64);
    if (kind === "identity") h.source.feedUrlHash = "f".repeat(64);
    if (kind === "owner") h.run.usuarioId = "other";
    if (kind === "source") h.source._id = "other";
    if (kind === "run") h.run._id = "other";
    if (kind === "providerVersion") h.run.providerNormalizationVersion++;
    if (kind === "normalization") h.run.normalizationVersion++;
    if (kind === "expired") h.run.expiresAt = new Date(0);
    const action = kind === "restart" ? () => createProviderSnapshots().get({ run: h.run, source: h.source, usuarioId: owner })
      : kind === "forged" ? () => h.snapshots.bind({ fetched: { ...fetched, captureId: "invented" }, run: h.run, usuarioId: owner }) : () => h.get();
    assert.throws(action, { code: SNAPSHOT_REQUIRED }); assert.equal(h.calls(), 1);
  });
}
test("returned normalized snapshots cannot mutate the retained evidence", async () => {
  const h = setup(); const fetched = await h.read(); h.snapshots.bind({ fetched, run: h.run, usuarioId: owner });
  h.get().properties.length = 0;
  assert.equal(snapshotDigest(h.get()), h.run.snapshotDigest);
});
