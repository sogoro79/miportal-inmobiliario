import test from "node:test";
import assert from "node:assert/strict";
import { buildSyncSnapshot } from "../utils/import/syncSnapshot.js";
import { managedFingerprint } from "../utils/import/syncBaseline.js";
import { prepareSyncPlan, safeRunSummary, runVersions, snapshotDigest } from "../utils/import/syncPlan.js";
import { prepareMissingEligibility } from "../utils/import/missingEligibility.js";
import { createSyncSimulator } from "../utils/import/syncSimulation.js";
import { encryptFeedUrl } from "../utils/import/feedUrlCrypto.js";
import ImportSyncRun from "../models/ImportSyncRun.js";

const U = "000000000000000000000001", S = "000000000000000000000002", P = "000000000000000000000003";
const xml = `<properties><property><externalId>PRESENT</externalId><title>Casa</title><operation>venta</operation><price>1</price><address>Direccion</address><bedrooms>2</bedrooms></property></properties>`;
const now = new Date();
const property = () => {
  const p = { _id: P, usuarioId: U, importSourceId: S, source: "crm", externalId: "ABSENT",
    titulo: "Casa", precio: 198000, habitaciones: 2, visiblePublicamente: true, syncEnabled: true,
    contentRevision: 3, syncOverrides: {}, syncApplyFingerprintVersion: 1 };
  p.syncApplyFingerprint = managedFingerprint(p); return p;
};
const context = { usuarioId: U, importSourceId: S, reconciliations: [] };
const run = plan => ({ _id: P, usuarioId: U, importSourceId: S, status: "simulated", snapshotComplete: true,
  sourceIdentityHash: "a".repeat(64), snapshotDigest: snapshotDigest(buildSyncSnapshot(xml)), ...runVersions,
  expiresAt: new Date(+now + 600000), ...plan, planTruncated: plan.resultsTruncated });
const missing = plan => plan.plan.find(e => e.type === "MISSING");

test("valid MISSING persists evidence but does not mutate property or authorize UPDATE", () => {
  const p = property(), before = structuredClone(p);
  const plan = prepareSyncPlan(buildSyncSnapshot(xml), [p], context), entry = missing(plan);
  assert.equal(entry.hideMissingEligible, true); assert.equal(entry.hideMissingBlockCode, null);
  assert.equal(entry.blocked, true); assert.equal(entry.missingEvidence.expectedContentRevision, 3);
  assert.equal(entry.missingEvidence.expectedVisiblePublicamente, true);
  assert.deepEqual(p, before);
  const safe = safeRunSummary(run(plan), now).results.find(e => e.type === "MISSING");
  assert.equal(safe.hideMissingEligible, true); assert.equal(safe.hideMissingBlockCode, null);
  assert.doesNotMatch(JSON.stringify(safe), /propiedadId|importSourceId|usuarioId|Fingerprint|Revision|missingEvidence|sourceIdentityHash/);
  const doc = new ImportSyncRun({ ...run(plan), startedAt: now });
  assert.equal(doc.validateSync(), undefined); assert.equal(doc.plan.find(e => e.type === "MISSING").missingEvidence.version, 1);
});
for (const [name, mutate, code] of [
  ["owner", p => { p.usuarioId = S; }, "MISSING_OWNER_CHANGED"],
  ["source", p => { p.importSourceId = U; }, "MISSING_SOURCE_CHANGED"],
  ["manual source", p => { p.source = "manual"; }, "MISSING_SOURCE_CHANGED"],
  ["not enrolled", p => { p.syncEnabled = false; }, "MISSING_NOT_ENROLLED"],
  ["invalid baseline", p => { p.syncApplyFingerprint = "bad"; }, "MISSING_BASELINE_INVALID"],
  ["changed content", p => { p.precio = 2; }, "MISSING_BASELINE_INVALID"],
  ["override", p => { p.syncOverrides.descripcion = true; }, "MISSING_MANUAL_OVERRIDE"],
  ["hidden", p => { p.visiblePublicamente = false; }, "MISSING_ALREADY_HIDDEN"],
  ["previously missing", p => { p.removedFromFeedAt = now; }, "MISSING_PREVIOUSLY_HIDDEN"],
  ["future marker", p => { p.hiddenByMissingRunId = P; }, "MISSING_PREVIOUSLY_HIDDEN"],
  ["invalid revision", p => { p.contentRevision = -1; }, "MISSING_REVISION_INVALID"]
]) test(`${name} blocks MISSING`, () => {
  const p = property(); mutate(p);
  const entry = missing(prepareSyncPlan(buildSyncSnapshot(xml), [p], context));
  assert.equal(entry.hideMissingEligible, false); assert.equal(entry.hideMissingBlockCode, code);
});
test("reconciliation by property ID or identity blocks; unchecked reconciliation fails closed", () => {
  for (const r of [{ propiedadId: P }, { usuarioId: U, importSourceId: S, externalId: "ABSENT" }]) {
    assert.equal(missing(prepareSyncPlan(buildSyncSnapshot(xml), [property()], { ...context, reconciliations: [r] })).hideMissingBlockCode, "MISSING_RECONCILIATION_PENDING");
  }
  assert.equal(missing(prepareSyncPlan(buildSyncSnapshot(xml), [property()], { ...context, reconciliations: undefined })).hideMissingBlockCode, "MISSING_RECONCILIATION_UNCHECKED");
});
test("deleted, ambiguous and incomplete properties never become actionable", () => {
  const snapshot = buildSyncSnapshot(xml);
  assert.equal(prepareMissingEligibility(snapshot, [], "ABSENT", context).hideMissingBlockCode, "MISSING_PROPERTY_NOT_FOUND");
  assert.equal(prepareMissingEligibility(snapshot, [property(), property()], "ABSENT", context).hideMissingBlockCode, "MISSING_IDENTITY_AMBIGUOUS");
  assert.equal(prepareMissingEligibility({ ...snapshot, snapshotComplete: false }, [property()], "ABSENT", context).hideMissingEligible, false);
  assert.equal(prepareSyncPlan({ ...snapshot, snapshotComplete: false }, [property()], context).missingCount, 0);
});
test("truncated plan and legacy/expired/incomplete run fail closed", () => {
  const snapshot = buildSyncSnapshot(xml);
  const huge = prepareSyncPlan(snapshot, Array.from({ length: 101 }, (_, i) => ({ ...property(), externalId: `ABSENT-${i}` })), context);
  assert.equal(missing(huge).hideMissingBlockCode, "MISSING_RUN_TRUNCATED");
  const plan = prepareSyncPlan(snapshot, [property()], context);
  for (const mutate of [r => { delete r.plan.find(e => e.type === "MISSING").missingEvidence; },
    r => { delete r.snapshotVersion; }, r => { delete r.sourceIdentityHash; }]) {
    const r = run(structuredClone(plan)); mutate(r);
    assert.equal(safeRunSummary(r, now).results.find(e => e.type === "MISSING").hideMissingBlockCode, "MISSING_RUN_CHANGED");
  }
  for (const [flags, code] of [[{ expiresAt: new Date(+now - 1) }, "MISSING_RUN_EXPIRED"],
    [{ snapshotComplete: false }, "MISSING_SNAPSHOT_INCOMPLETE"], [{ planTruncated: true }, "MISSING_RUN_TRUNCATED"]]) {
    assert.equal(safeRunSummary({ ...run(plan), ...flags }, now).results.find(e => e.type === "MISSING").hideMissingBlockCode, code);
  }
});
test("real simulator reads reconciliations, persists evidence and returns identical safe POST/GET", async () => {
  const env = { CRM_FEED_URL_KEY_V1: Buffer.alloc(32, 1).toString("base64") };
  for (const pending of [false, true]) {
    const source = { _id: S, usuarioId: U, activo: true, feedType: "generic_xml", ...encryptFeedUrl("https://feeds.example/catalog.xml", env) };
    let stored, filter;
    const sim = createSyncSimulator({ env, now: () => now,
      ImportSourceModel: { findOne: async () => source,
        findOneAndUpdate: async (f,u) => { Object.assign(source,u.$set); return source; },
        updateOne: async () => ({ matchedCount: 1 }) },
      ImportSyncRunModel: { create: async data => { stored = { _id: P, ...data }; return stored; },
        updateOne: async (f,u) => { Object.assign(stored,u.$set); for (const key of Object.keys(u.$unset || {})) delete stored[key]; } },
      PropiedadModel: { find: async () => [property()], updateOne: () => assert.fail("no property writes"),
        deleteMany: () => assert.fail("no deletions") },
      ReconciliationModel: { find: async f => { filter = f; return pending ? [{ propiedadId: P }] : []; } },
      fetchXml: async () => ({ xml })
    });
    const response = await sim({ usuarioId: U, importSourceId: S });
    assert.deepEqual(filter.$or[0], { propiedadId: { $in: [P] } });
    const safe = response.results.find(e => e.type === "MISSING");
    assert.equal(safe.hideMissingEligible, !pending); assert.equal(safe.blocked, true);
    assert.deepEqual(response, safeRunSummary(stored, now));
  }
});
