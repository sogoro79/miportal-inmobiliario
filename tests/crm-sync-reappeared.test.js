import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import express from "express";
import jwt from "jsonwebtoken";
import { Readable, Writable, PassThrough } from "node:stream";
import Usuario from "../models/Usuario.js";
import { createCrmImportRouter } from "../routes/crmImport.js";
import { buildSyncSnapshot } from "../utils/import/syncSnapshot.js";
import { compareSyncSnapshot } from "../utils/import/syncDiff.js";
import { prepareSyncPlan, safeRunSummary, snapshotDigest, runVersions } from "../utils/import/syncPlan.js";
import { managedFingerprint } from "../utils/import/syncBaseline.js";
import { missingContentFingerprint } from "../utils/import/missingEligibility.js";
import { prepareReappearedEligibility } from "../utils/import/reappearedEligibility.js";
import { createSyncSimulator } from "../utils/import/syncSimulation.js";
import { encryptFeedUrl } from "../utils/import/feedUrlCrypto.js";
import ImportSyncRun from "../models/ImportSyncRun.js";

const U = "000000000000000000000001", S = "000000000000000000000002",
  P = "000000000000000000000003", R = "000000000000000000000004", N = "000000000000000000000005";
const now = new Date("2026-10-13T12:00:00Z"), hideStart = new Date(+now - 3600000);
const xml = `<properties><property><externalId>CRM-1</externalId><title>Casa</title>
  <description>Descripción original</description><price>219000</price><operation>venta</operation>
  <address>Dirección ficticia</address><city>Rota</city><province>Cádiz</province>
  <propertyType>piso</propertyType><condition>used</condition><bedrooms>2</bedrooms><bathrooms>1</bathrooms>
  <surface>80</surface><terrace>true</terrace><garage>false</garage><pool>false</pool>
</property></properties>`;
function fixture(feed = xml) {
  const original = { ...buildSyncSnapshot(xml).properties[0].data, _id: P, usuarioId: U,
    importSourceId: S, source: "crm", syncEnabled: true, syncOverrides: {}, contentRevision: 2,
    syncApplyFingerprintVersion: 1, visiblePublicamente: true, imagenes: [], fechaExpiracion: null };
  original.syncApplyFingerprint = managedFingerprint(original);
  const causal = { _id: R, usuarioId: U, importSourceId: S, sourceIdentityHash: "a".repeat(64),
    snapshotDigest: snapshotDigest(buildSyncSnapshot(xml)), ...runVersions, status: "simulated",
    snapshotComplete: true, totalResults: 1, planTruncated: false, expiresAt: new Date(+hideStart + 1200000),
    plan: [{ externalId: "CRM-1", type: "MISSING", propiedadId: P, hideMissingEligible: true,
      safeReasonCode: "MISSING_REQUIRES_REVIEW", missingEvidence: {
      version: 1, usuarioId: U, importSourceId: S, enrolled: true, reconciliationChecked: true,
      expectedContentRevision: 2, expectedVisiblePublicamente: true, baselineVersion: 1,
      expectedBaselineFingerprint: original.syncApplyFingerprint, expectedContentFingerprint: missingContentFingerprint(original)
    } }],
    missingHide: { status: "completed", selectedExternalIds: ["CRM-1"],
      results: [{ externalId: "CRM-1", status: "hidden" }], countHidden: 1, countAlreadyHidden: 0,
      startedAt: hideStart, completedAt: new Date(+hideStart + 2000) } };
  const property = { ...original, contentRevision: 3, visiblePublicamente: false,
    hiddenByMissingRunId: R, removedFromFeedAt: new Date(+hideStart + 1000) };
  const snapshot = buildSyncSnapshot(feed);
  const context = { usuarioId: U, importSourceId: S, sourceIdentityHash: "a".repeat(64),
    snapshotDigest: snapshotDigest(snapshot), versions: runVersions, causalRuns: [causal], reconciliations: [],
    user: { _id: U, activo: true, plan: "vip", planActivo: true }, visibleCount: 0, now };
  return { property, causal, snapshot, context };
}
const eligibility = f => prepareReappearedEligibility(f.snapshot, [f.property], "CRM-1", f.context);
const plan = f => prepareSyncPlan(f.snapshot, [f.property], f.context);
const run = (f, prepared = plan(f)) => ({ _id: N, usuarioId: U, importSourceId: S, status: "simulated",
  startedAt: now, expiresAt: new Date(+now + 1200000), snapshotComplete: true,
  snapshotDigest: snapshotDigest(f.snapshot), sourceIdentityHash: f.context.sourceIdentityHash, ...runVersions,
  ...prepared, planTruncated: prepared.resultsTruncated });

test("proven reappearance is exclusively REAPPEARED, blocked for UPDATE, with private evidence and no mutations", () => {
  const f = fixture(), before = structuredClone(f);
  const diff = compareSyncSnapshot(f.snapshot, [f.property], f.context);
  assert.equal(diff.results[0].type, "REAPPEARED");
  const prepared = plan(f), entry = prepared.plan[0];
  assert.equal(entry.type, "REAPPEARED"); assert.equal(entry.blocked, true);
  assert.equal(entry.restoreEligible, true); assert.equal(entry.restoreBlockCode, null);
  assert.equal(prepared.reappearedCount, 1);
  for (const key of ["unchangedCount", "updateCount", "newCount", "missingCount", "conflictCount", "errorCount"])
    assert.equal(prepared[key], 0);
  assert.equal(entry.restoreEvidence.expectedHiddenByMissingRunId, R);
  assert.equal(entry.restoreEvidence.expectedContentRevision, 3);
  assert.deepEqual(f, before);
  const doc = new ImportSyncRun(run(f));
  assert.equal(doc.validateSync(), undefined);
  const safe = safeRunSummary(doc.toObject(), now);
  assert.equal(safe.results[0].restoreEligible, true);
  assert.equal(safe.reappearedCount, 1);
  assert.doesNotMatch(JSON.stringify(safe), /restoreEvidence|propiedadId|usuarioId|importSourceId|causalRun|hiddenByMissingRunId|Fingerprint|sourceIdentityHash|snapshotDigest|Revision|observedPlan/);
  assert.ok(!JSON.stringify(safe).includes(R)); assert.ok(!JSON.stringify(safe).includes(P));
});
test("managed and non-managed incoming changes remain REAPPEARED, never UPDATE", () => {
  for (const feed of [xml.replace("219000", "225000"), xml.replace("Dirección ficticia", "Otra dirección")]) {
    const f = fixture(feed), prepared = plan(f);
    assert.equal(prepared.plan[0].type, "REAPPEARED");
    assert.equal(prepared.plan[0].restoreBlockCode, "REAPPEARED_CONTENT_CHANGED");
    assert.equal(prepared.plan[0].restoreEligible, false);
    assert.equal(prepared.updateCount, 0); assert.equal(prepared.reappearedCount, 1);
  }
});
test("incomplete or invalid cause never falls back to UPDATE for a MISSING-marked property", () => {
  for (const mutate of [f => { delete f.property.removedFromFeedAt; }, f => { f.context.causalRuns = []; }]) {
    const f = fixture(xml.replace("219000", "225000")); mutate(f);
    const prepared = plan(f);
    assert.equal(prepared.plan[0].type, "CONFLICT");
    assert.equal(prepared.plan[0].restoreEligible, false);
    assert.equal(prepared.updateCount, 0);
  }
});
test("manual/plan hiding and missing markers never classify as REAPPEARED", () => {
  for (const mutate of [f => { delete f.property.hiddenByMissingRunId; delete f.property.removedFromFeedAt; },
    f => { delete f.property.hiddenByMissingRunId; }, f => { delete f.property.removedFromFeedAt; },
    f => { f.property.ocultoManual = true; }, f => { f.property.eliminada = true; },
    f => { f.property.visiblePublicamente = true; }]) {
    const f = fixture(); mutate(f);
    assert.notEqual(plan(f).plan[0].type, "REAPPEARED");
    assert.notEqual(plan(f).plan[0].restoreEligible, true);
  }
});
for (const [name, mutate, code] of [
  ["marker absent", f => { delete f.property.hiddenByMissingRunId; }, "REAPPEARED_HIDE_MARKER_MISSING"],
  ["removal date absent", f => { delete f.property.removedFromFeedAt; }, "REAPPEARED_REMOVAL_DATE_MISSING"],
  ["causal absent", f => { f.context.causalRuns = []; }, "REAPPEARED_CAUSAL_RUN_INVALID"],
  ["causal owner", f => { f.causal.usuarioId = S; }, "REAPPEARED_CAUSAL_RUN_INVALID"],
  ["causal source", f => { f.causal.importSourceId = U; }, "REAPPEARED_CAUSAL_RUN_INVALID"],
  ["causal receipt incomplete", f => { f.causal.missingHide.status = "preparing"; }, "REAPPEARED_CAUSAL_RUN_INVALID"],
  ["causal result reference", f => { f.causal.missingHide.results[0].externalId = "OTHER"; }, "REAPPEARED_CAUSAL_RUN_INVALID"],
  ["causal selection reference", f => { f.causal.missingHide.selectedExternalIds = ["OTHER"]; }, "REAPPEARED_CAUSAL_RUN_INVALID"],
  ["causal counts", f => { f.causal.missingHide.countHidden = 2; }, "REAPPEARED_CAUSAL_RUN_INVALID"],
  ["causal in future", f => { f.causal.missingHide.completedAt = new Date(+now + 1000); }, "REAPPEARED_CAUSAL_RUN_INVALID"],
  ["causal property", f => { f.causal.plan[0].propiedadId = S; }, "REAPPEARED_CAUSAL_RUN_INVALID"],
  ["causal snapshot", f => { f.causal.snapshotComplete = false; }, "REAPPEARED_CAUSAL_RUN_INVALID"],
  ["causal digest", f => { f.causal.sourceIdentityHash = "b".repeat(64); }, "REAPPEARED_CAUSAL_RUN_INVALID"],
  ["visible", f => { f.property.visiblePublicamente = true; }, "REAPPEARED_ALREADY_VISIBLE"],
  ["not enrolled", f => { f.property.syncEnabled = false; }, "REAPPEARED_NOT_ENROLLED"],
  ["invalid baseline", f => { f.property.syncApplyFingerprint = "bad"; }, "REAPPEARED_BASELINE_INVALID"],
  ["override", f => { f.property.syncOverrides.descripcion = true; }, "REAPPEARED_MANUAL_OVERRIDE"],
  ["reconciliation unchecked", f => { delete f.context.reconciliations; }, "REAPPEARED_RECONCILIATION_UNCHECKED"],
  ["reconciliation by property", f => { f.context.reconciliations = [{ propiedadId: P }]; }, "REAPPEARED_RECONCILIATION_PENDING"],
  ["reconciliation by identity", f => { f.context.reconciliations = [{ usuarioId: U, importSourceId: S, externalId: "CRM-1" }]; }, "REAPPEARED_RECONCILIATION_PENDING"],
  ["owner changed", f => { f.property.usuarioId = S; }, "REAPPEARED_OWNER_CHANGED"],
  ["source changed", f => { f.property.importSourceId = U; }, "REAPPEARED_SOURCE_CHANGED"],
  ["source manual", f => { f.property.source = "manual"; }, "REAPPEARED_SOURCE_CHANGED"],
  ["invalid revision", f => { f.property.contentRevision = -1; }, "REAPPEARED_REVISION_INVALID"],
  ["revision changed after hide", f => { f.property.contentRevision++; }, "REAPPEARED_REVISION_INVALID"],
  ["incomplete snapshot", f => { f.snapshot.snapshotComplete = false; }, "REAPPEARED_SNAPSHOT_INCOMPLETE"],
  ["plan inactive", f => { f.context.user.planActivo = false; }, "REAPPEARED_PLAN_INACTIVE"],
  ["user inactive", f => { f.context.user.activo = false; }, "REAPPEARED_PLAN_INACTIVE"],
  ["listing expired", f => { f.property.fechaExpiracion = now; }, "REAPPEARED_LISTING_EXPIRED"],
  ["listing invalid date", f => { f.property.fechaExpiracion = "invalid"; }, "REAPPEARED_LISTING_EXPIRED"],
  ["listing sold", f => { f.property.estadoComercial = "Vendido"; f.causal.plan[0].missingEvidence.expectedContentFingerprint = missingContentFingerprint({ ...f.property, visiblePublicamente: true }); }, "REAPPEARED_OTHER_HIDING_CAUSE"],
  ["free no capacity", f => { f.context.user.plan = "gratis"; f.context.visibleCount = 2; }, "REAPPEARED_PLAN_LIMIT"],
  ["VIP trial expired", f => { Object.assign(f.context.user, { plan: "vip_trial", trialAccepted: true, trialEndDate: now }); }, "REAPPEARED_PLAN_INACTIVE"],
  ["VIP trial unaccepted", f => { Object.assign(f.context.user, { plan: "vip_trial", trialAccepted: false, trialEndDate: new Date(+now + 3600000) }); }, "REAPPEARED_PLAN_INACTIVE"],
  ["paid plan expired despite active flag", f => { Object.assign(f.context.user, { plan: "basico", planFechaFin: now }); }, "REAPPEARED_PLAN_INACTIVE"],
  ["unknown plan", f => { f.context.user.plan = "unknown"; }, "REAPPEARED_PLAN_INACTIVE"]
]) test(`${name} is blocked without mutating property`, () => {
  const f = fixture(); mutate(f); const before = structuredClone(f.property);
  const result = eligibility(f);
  assert.equal(result.restoreEligible, false); assert.equal(result.restoreBlockCode, code);
  assert.equal(result.restoreEvidence, undefined); assert.deepEqual(f.property, before);
});
test("absent, duplicated property and absent feed reference fail closed", () => {
  const f = fixture();
  for (const [matches, ref, code] of [[[], "CRM-1", "REAPPEARED_PROPERTY_NOT_FOUND"],
    [[f.property, f.property], "CRM-1", "REAPPEARED_IDENTITY_AMBIGUOUS"],
    [[f.property], "OTHER", "REAPPEARED_IDENTITY_AMBIGUOUS"]]) {
    assert.equal(prepareReappearedEligibility(f.snapshot, matches, ref, f.context).restoreBlockCode, code);
  }
});
test("eligible VIP/trial, lanzamiento and limited plans keep current commercial capacities", () => {
  for (const [flags, count] of [
    [{ plan: "vip" }, 10000],
    [{ plan: "vip_trial", trialAccepted: true, trialEndDate: new Date(+now + 86400000) }, 10000],
    [{ plan: "lanzamiento_2026", planFechaFin: new Date("2027-01-31T22:59:59Z") }, 9],
    [{ plan: "basico" }, 2], [{ plan: "destacado" }, 3], [{ plan: "gratis" }, 1]
  ]) {
    const f = fixture(); Object.assign(f.context.user, flags); f.context.visibleCount = count;
    assert.equal(eligibility(f).restoreEligible, true);
    f.context.visibleCount++;
    assert.equal(eligibility(f).restoreEligible, ["vip", "vip_trial"].includes(flags.plan));
  }
});
test("truncation removes restore evidence and denies all REAPPEARED actions", () => {
  const f = fixture();
  const others = Array.from({ length: 100 }, (_, i) => ({ externalId: `LEGACY-${i}`, syncEnabled: false }));
  const prepared = prepareSyncPlan(f.snapshot, [f.property, ...others], f.context);
  const entry = prepared.plan.find(e => e.type === "REAPPEARED");
  assert.equal(entry.restoreEligible, false); assert.equal(entry.restoreBlockCode, "REAPPEARED_RUN_TRUNCATED");
  assert.equal(entry.restoreEvidence, undefined);
  assert.equal(prepared.reappearedCount, 1);
});
test("safe summary rejects expired, changed, incomplete and legacy evidence without exposing it", () => {
  for (const [mutate, code] of [
    [r => { r.expiresAt = now; }, "REAPPEARED_RUN_EXPIRED"],
    [r => { r.snapshotComplete = false; }, "REAPPEARED_SNAPSHOT_INCOMPLETE"],
    [r => { r.planTruncated = true; }, "REAPPEARED_RUN_TRUNCATED"],
    [r => { delete r.plan[0].restoreEvidence; }, "REAPPEARED_RUN_CHANGED"],
    [r => { delete r.snapshotVersion; }, "REAPPEARED_RUN_CHANGED"],
    [r => { r.status = "applied"; }, "REAPPEARED_RUN_CHANGED"],
    [r => { r.plan[0].restoreEvidence.sourceIdentityHash = "b".repeat(64); }, "REAPPEARED_RUN_CHANGED"],
    [r => { delete r.plan[0].restoreEvidence.reconciliationChecked; }, "REAPPEARED_RUN_CHANGED"]
  ]) {
    const f = fixture(), stored = run(f); mutate(stored);
    const result = safeRunSummary(stored, now).results[0];
    assert.equal(result.restoreEligible, false); assert.equal(result.restoreBlockCode, code);
    assert.equal(result.restoreEvidence, undefined);
  }
  const f = fixture(), stored = run(f);
  stored.plan[0].restoreEvidence.planValidUntil = new Date(+now + 1000);
  assert.equal(safeRunSummary(stored, new Date(+now + 1001)).results[0].restoreBlockCode, "REAPPEARED_PLAN_INACTIVE");
  const legacy = new ImportSyncRun({ _id: N, ...run(f), plan: [{ externalId: "CRM-1", type: "REAPPEARED", blocked: true }] });
  assert.notEqual(legacy.plan[0].restoreEligible, true); assert.equal(legacy.plan[0].restoreEvidence, undefined);
});
test("existing UI renders REAPPEARED as review only with no checkbox or action", () => {
  const element = () => ({ children: [], textContent: "", listeners: {}, append(v) { this.children.push(v); },
    replaceChildren() { this.children = []; }, setAttribute() {}, addEventListener(k, fn) { this.listeners[k] = fn; } });
  const context = vm.createContext({ window: {}, document: { createElement: element }, Date });
  vm.runInContext(readFileSync(new URL("../public/js/crm-sync-ui.js", import.meta.url), "utf8"), context);
  const f = fixture(), output = element();
  context.window.HomeClickCrmSync.renderizar(safeRunSummary(run(f), now), output,
    () => assert.fail("enroll"), () => assert.fail("UPDATE"), () => assert.fail("NEW"), null, () => assert.fail("MISSING"));
  const descendants = n => [n, ...n.children.flatMap(descendants)];
  assert.ok(descendants(output).some(e => /REAPPEARED.*requiere revisión/.test(e.textContent)));
  assert.ok(descendants(output).every(e => e.type !== "checkbox" && !e.listeners.click));
});

function simulationHarness(pending = false) {
  const f = fixture(), env = { CRM_FEED_URL_KEY_V1: Buffer.alloc(32, 1).toString("base64") };
  const source = { _id: S, usuarioId: U, activo: true, feedType: "generic_xml", ...encryptFeedUrl("https://feeds.example/catalog.xml", env) };
  f.context.sourceIdentityHash = source.feedUrlHash; f.causal.sourceIdentityHash = source.feedUrlHash;
  const reads = []; let stored;
  function query(value, name, filter) {
    const log = { name, filter }; reads.push(log);
    return { select(v) { log.select = v; return this; }, lean() { return this; },
      limit() { return this; }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } };
  }
  const dependencies = { env, now: () => now,
    ImportSourceModel: { findOne: async () => source,
      findOneAndUpdate: async (filter, op) => { Object.assign(source, op.$set); return source; },
      updateOne: async () => ({ matchedCount: 1 }) },
    ImportSyncRunModel: { create: async data => { stored = { _id: N, ...data }; return stored; },
      updateOne: async (filter, op) => { Object.assign(stored, op.$set); for (const key of Object.keys(op.$unset || {})) delete stored[key]; },
      find: filter => query([f.causal], "causal", filter),
      findOne: filter => query(filter._id === N && filter.usuarioId === U ? stored : null, "safe run", filter) },
    PropiedadModel: { find: filter => query([f.property], "properties", filter),
      countDocuments: filter => query(0, "capacity", filter),
      updateOne: () => assert.fail("property write"), deleteMany: () => assert.fail("property deletion") },
    UsuarioModel: { findOne: filter => query(f.context.user, "user", filter), updateOne: () => assert.fail("user write") },
    ReconciliationModel: { find: filter => query(pending ? [{ propiedadId: P }] : [], "reconciliation", filter) },
    fetchXml: async () => ({ xml }) };
  return { f, dependencies, reads, simulate: createSyncSimulator(dependencies), get stored() { return stored; } };
}
test("real simulator queries causal run, reconciliations and capacity, persists evidence without property writes", async () => {
  for (const pending of [false, true]) {
    const h = simulationHarness(pending), before = structuredClone(h.f.property);
    const result = await h.simulate({ usuarioId: U, importSourceId: S });
    assert.deepEqual(result, safeRunSummary(h.stored, now));
    assert.equal(result.results[0].type, "REAPPEARED");
    assert.equal(result.results[0].restoreEligible, !pending);
    assert.equal(result.results[0].restoreBlockCode, pending ? "REAPPEARED_RECONCILIATION_PENDING" : null);
    assert.equal(result.reappearedCount, 1);
    assert.equal(new ImportSyncRun(h.stored).validateSync(), undefined);
    assert.deepEqual(h.f.property, before);
    assert.ok(h.reads.some(r => r.name === "causal" && r.filter._id.$in.includes(R) && r.select === "+plan"));
    assert.ok(h.reads.some(r => r.name === "properties" && r.select === "+hiddenByMissingRunId"));
    assert.ok(h.reads.some(r => r.name === "reconciliation" && r.filter.$or[0].propiedadId.$in.includes(P)));
    assert.ok(h.reads.some(r => r.name === "capacity" && r.filter.usuarioId === U));
  }
});
function http(app, path, { method = "POST", body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const req = new Readable({ read() { this.push(payload); this.push(null); } });
    Object.assign(req, { method, url: path, originalUrl: path, complete: true, headers: {
      "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)),
      authorization: `Bearer ${jwt.sign({ id: U }, "reappeared-test-only")}`
    }, socket: new PassThrough() });
    req.socket.remoteAddress = "127.0.0.1"; req.connection = req.socket;
    const chunks = [], headers = {};
    const res = new Writable({ write(c, e, cb) { chunks.push(Buffer.from(c)); cb(); } });
    res.statusCode = 200;
    res.setHeader = (key, value) => { headers[key.toLowerCase()] = value; };
    res.getHeader = key => headers[key.toLowerCase()];
    res.removeHeader = key => { delete headers[key.toLowerCase()]; };
    const end = res.end.bind(res);
    res.end = c => { if (c) chunks.push(Buffer.from(c)); end();
      resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); };
    app.handle(req, res, reject);
  });
}
test("real HTTP POST/GET agree on REAPPEARED eligibility and expose no private evidence", async () => {
  const h = simulationHarness(), original = Usuario.findById, secret = process.env.JWT_SECRET;
  const causalStart = new Date(Date.now() - 3600000);
  h.f.causal.missingHide.startedAt = causalStart;
  h.f.causal.missingHide.completedAt = new Date(+causalStart + 2000);
  h.f.property.removedFromFeedAt = new Date(+causalStart + 1000);
  process.env.JWT_SECRET = "reappeared-test-only";
  Usuario.findById = async () => h.f.context.user;
  const pass = (req, res, next) => next(), app = express(); app.use(express.json());
  app.use("/api/crm-import", createCrmImportRouter({ ...h.dependencies,
    simulateSync: createSyncSimulator({ ...h.dependencies, now: () => new Date() }),
    rateLimitMiddleware: pass, userRateLimitMiddleware: pass }));
  try {
    const post = await http(app, "/api/crm-import/sync/simulate", { body: { importSourceId: S } });
    assert.equal(post.status, 200);
    const get = await http(app, `/api/crm-import/sync/runs/${N}`, { method: "GET" });
    assert.equal(get.status, 200);
    assert.deepEqual(get.body.results, post.body.results);
    assert.equal(get.body.reappearedCount, 1);
    assert.equal(post.body.results[0].restoreEligible, true);
    assert.doesNotMatch(JSON.stringify(get.body), /restoreEvidence|hiddenByMissingRunId|causalRun|Fingerprint|Revision|snapshotDigest|sourceIdentityHash/);
    assert.equal(h.f.property.visiblePublicamente, false);
  } finally {
    Usuario.findById = original;
    if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret;
  }
});
