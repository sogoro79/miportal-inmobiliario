import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import express from "express";
import jwt from "jsonwebtoken";
import { Readable, Writable, PassThrough } from "node:stream";
import Usuario from "../models/Usuario.js";
import ImportSyncRun from "../models/ImportSyncRun.js";
import { createCrmImportRouter } from "../routes/crmImport.js";
import { createReappearedRestorer } from "../utils/import/syncRestoreReappeared.js";
import { restoreSelectionHash } from "../utils/import/reappearedRestoreState.js";
import { buildSyncSnapshot } from "../utils/import/syncSnapshot.js";
import { prepareSyncPlan, snapshotDigest, runVersions, safeRunSummary,
  evaluateRunApplyEligibility, evaluateRunNewImportEligibility } from "../utils/import/syncPlan.js";
import { safeMissingEligibility, missingContentFingerprint } from "../utils/import/missingEligibility.js";
import { managedFingerprint } from "../utils/import/syncBaseline.js";
import { encryptFeedUrl } from "../utils/import/feedUrlCrypto.js";
import { capturePropertyContent } from "../utils/propertyContent.js";
import { createPublicationPersistence } from "../utils/publicationPersistence.js";
import { createSyncApplier } from "../utils/import/syncApply.js";
import { createSyncNewImporter } from "../utils/import/syncImportNew.js";
import { createMissingHider } from "../utils/import/syncHideMissing.js";

const U = "000000000000000000000001", S = "000000000000000000000002",
  R = "000000000000000000000003", C = "000000000000000000000004";
const env = { CRM_FEED_URL_KEY_V1: crypto.randomBytes(32).toString("base64") };
const xmlProperty = ref => `<property><externalId>${ref}</externalId><title>Casa</title><description>Original</description>
  <price>198000</price><operation>venta</operation><address>Direccion</address><city>Rota</city><province>Cádiz</province>
  <propertyType>piso</propertyType><condition>used</condition><bedrooms>2</bedrooms><bathrooms>1</bathrooms>
  <surface>72</surface><garage>false</garage><pool>false</pool><terrace>true</terrace></property>`;
const equal = (a, b) => a instanceof Date && b instanceof Date ? +a === +b : String(a) === String(b);
function values(doc, parts) {
  if (!parts.length) return Array.isArray(doc) ? doc.flatMap(d => values(d, [])) : [doc];
  return Array.isArray(doc) ? doc.flatMap(d => values(d, parts)) : values(doc?.[parts[0]], parts.slice(1));
}
function matches(doc, filter) {
  return !!doc && Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return expected.some(f => matches(doc, f));
    const actual = values(doc, key.split("."));
    if (expected && typeof expected === "object" && !(expected instanceof Date)) return Object.entries(expected).every(([op, e]) => {
      if (op === "$exists") return actual.some(a => a !== undefined) === e;
      if (op === "$in") return actual.some(a => e.some(v => equal(v, a)));
      if (op === "$nin") return actual.every(a => !e.some(v => equal(v, a)));
      if (op === "$ne") return actual.every(a => !equal(a, e));
      if (op === "$gt") return actual.some(a => a > e);
      if (op === "$lte") return actual.some(a => a <= e);
      return false;
    });
    return expected === null ? actual.some(a => a == null) : actual.some(a => equal(a, expected));
  });
}
function update(doc, operation) {
  function set(key, value) {
    const parts = key.split("."); let target = doc;
    for (const part of parts.slice(0, -1)) target = target[part] ||= {};
    target[parts.at(-1)] = structuredClone(value);
  }
  for (const [key, value] of Object.entries(operation.$set || {})) set(key, value);
  for (const [key, value] of Object.entries(operation.$inc || {})) set(key, (values(doc, key.split("."))[0] || 0) + value);
  for (const key of Object.keys(operation.$unset || {})) delete doc[key];
}
function harness(count = 1) {
  let clock = new Date(), before = () => {}, onFetch = () => {}, afterWrite = () => {}, failAt, attempts = 0, retry = false, unknown, fetches = 0, tail = Promise.resolve();
  let xml = `<properties>${Array.from({ length: count }, (_, i) => xmlProperty(`CRM-${i}`)).join("")}</properties>`;
  const snapshot = buildSyncSnapshot(xml), start = new Date(+clock - 3600000);
  const originals = snapshot.properties.map((item, i) => {
    const p = { ...item.data, _id: String(10 + i).padStart(24, "0"), usuarioId: U, importSourceId: S,
      source: "crm", syncEnabled: true, syncOverrides: {}, contentRevision: 2,
      syncApplyFingerprintVersion: 1, visiblePublicamente: true, imagenes: ["stored-photo"], fechaExpiracion: null };
    p.syncApplyFingerprint = managedFingerprint(p); return p;
  });
  const causal = { _id: C, usuarioId: U, importSourceId: S, status: "simulated", ...runVersions,
    snapshotComplete: true, snapshotDigest: snapshotDigest(snapshot), totalResults: count, planTruncated: false,
    plan: originals.map(p => ({ externalId: p.externalId, type: "MISSING", propiedadId: p._id,
      hideMissingEligible: true, safeReasonCode: "MISSING_REQUIRES_REVIEW", missingEvidence: {
        version: 1, usuarioId: U, importSourceId: S, expectedVisiblePublicamente: true, enrolled: true,
        reconciliationChecked: true, expectedContentRevision: 2, baselineVersion: 1,
        expectedBaselineFingerprint: p.syncApplyFingerprint, expectedContentFingerprint: missingContentFingerprint(p)
      } })),
    missingHide: { status: "completed", selectedExternalIds: originals.map(p => p.externalId),
      results: originals.map(p => ({ externalId: p.externalId, status: "hidden" })), countHidden: count,
      countAlreadyHidden: 0, startedAt: start, completedAt: new Date(+start + 2000) } };
  const state = { user: { _id: U, activo: true, plan: "vip", planActivo: true, publicationVersion: 0 }, recs: [],
    sources: [{ _id: S, usuarioId: U, activo: true, feedType: "generic_xml", ...encryptFeedUrl("https://feeds.example/catalog.xml", env) }],
    props: originals.map(p => ({ ...p, visiblePublicamente: false, hiddenByMissingRunId: C,
      removedFromFeedAt: new Date(+start + 1000), contentRevision: 3 })), runs: [] };
  causal.sourceIdentityHash = state.sources[0].feedUrlHash;
  const prepared = prepareSyncPlan(snapshot, state.props, { usuarioId: U, importSourceId: S,
    sourceIdentityHash: causal.sourceIdentityHash, snapshotDigest: snapshotDigest(snapshot), versions: runVersions,
    causalRuns: [causal], reconciliations: [], user: state.user, visibleCount: 0, now: clock });
  state.runs = [causal, { _id: R, usuarioId: U, importSourceId: S, status: "simulated", ...runVersions,
    sourceIdentityHash: causal.sourceIdentityHash, snapshotDigest: snapshotDigest(snapshot), snapshotComplete: true,
    expiresAt: new Date(+clock + 1200000), ...prepared, planTruncated: false }];
  const logs = [], current = session => session?.data || state;
  function query(fn) { let session; return { select() { return this; }, lean() { return this; },
    read() { return this; }, readConcern() { return this; }, maxTimeMS() { return this; },
    session(s) { session = s; return this; }, then(resolve, reject) {
      return Promise.resolve().then(() => structuredClone(fn(current(session)))).then(resolve, reject);
    } }; }
  function model(name) {
    return { findOne: f => query(s => s[name].find(p => matches(p, f))),
      find: f => query(s => s[name].filter(p => matches(p, f))),
      async updateOne(f, op, opts = {}) {
        logs.push({ name, f, op, tx: !!opts.session });
        if (name === "props" && ++attempts === failAt) return { matchedCount: 0 };
        const p = current(opts.session)[name].find(p => matches(p, f));
        if (!p) return { matchedCount: 0, modifiedCount: 0 };
        update(p, op); if (name === "props") afterWrite(); return { matchedCount: 1, modifiedCount: 1 };
      } };
  }
  const sources = model("sources");
  sources.findOneAndUpdate = async (f, op) => {
    const p = state.sources.find(p => matches(p, f)); if (!p) return null;
    update(p, op); return structuredClone(p);
  };
  const props = model("props");
  props.countDocuments = f => query(s => {
    logs.push({ name: "count", tx: s !== state }); return s.props.filter(p => matches(p, f)).length;
  });
  props.create = async (docs, opts) => {
    logs.push({ name: "manualCreate", tx: !!opts.session });
    current(opts.session).props.push(...docs.map(doc => ({ visiblePublicamente: true, ...structuredClone(doc) }))); return docs;
  };
  props.findById = value => query(s => s.props.find(p => equal(p._id, value)));
  async function startSession() {
    return { async withTransaction(callback, opts) {
      assert.deepEqual(opts.readConcern, { level: "snapshot" }); assert.deepEqual(opts.writeConcern, { w: "majority" });
      // Mock user-document contention serializes commits; assertions verify fence-before-count.
      const previous = tail; let release; tail = new Promise(resolve => { release = resolve; }); await previous;
      before(state); this.data = structuredClone(state);
      try {
        await callback();
        if (retry) { this.data = structuredClone(state); await callback(); }
        if (unknown === "before") throw Object.assign(new Error("unknown"), { errorLabels: ["UnknownTransactionCommitResult"] });
        Object.assign(state, this.data);
        if (unknown === "after") throw Object.assign(new Error("unknown"), { errorLabels: ["UnknownTransactionCommitResult"] });
      } finally { this.data = undefined; release(); }
    }, async endSession() {} };
  }
  props.startSession = startSession;
  const user = { findOne: f => query(s => matches(s.user, f) ? s.user : null), findById: () => query(s => s.user), startSession,
    async updateOne(f, op, opts) {
      logs.push({ name: "userFence", f, op, tx: !!opts.session });
      const s = current(opts.session); if (!matches(s.user, f)) return { matchedCount: 0 };
      update(s.user, op); return { matchedCount: 1 };
    } };
  const deps = { PropiedadModel: props, UsuarioModel: user, ImportSourceModel: sources,
    ImportSyncRunModel: model("runs"), ReconciliationModel: model("recs"), env, now: () => new Date(clock),
    fetchXml: async () => { fetches++; onFetch(); return { xml }; } };
  return { state, deps, logs, restore: createReappearedRestorer(deps),
    request: { usuarioId: U, runId: R, externalIds: originals.map(p => p.externalId) },
    get run() { return state.runs.find(r => r._id === R); }, get fetches() { return fetches; },
    before(fn) { before = fn; }, feed(value) { xml = value; }, advance(ms) { clock = new Date(+clock + ms); },
    onFetch(fn) { onFetch = fn; },
    afterWrite(fn) { afterWrite = fn; },
    fail(n) { failAt = n; }, retry() { retry = true; }, unknown(where) { unknown = where; } };
}

for (const count of [1, 3, 10]) test(`atomic restore of ${count} changes only visibility, markers and revision`, async () => {
  const h = harness(count), before = structuredClone(h.state.props);
  const r = await h.restore(h.request);
  assert.equal(r.status, "completed"); assert.equal(r.countRestored, count); assert.equal(r.countAlreadyRestored, 0);
  h.state.props.forEach((p, i) => {
    assert.equal(p.visiblePublicamente, true); assert.equal(p.hiddenByMissingRunId, null); assert.equal(p.removedFromFeedAt, null);
    assert.equal(p.contentRevision, 4);
    assert.deepEqual({ ...capturePropertyContent(p), visiblePublicamente: false }, capturePropertyContent(before[i]));
    assert.equal(p.syncApplyFingerprint, before[i].syncApplyFingerprint); assert.deepEqual(p.syncOverrides, before[i].syncOverrides);
    assert.deepEqual(p.imagenes, before[i].imagenes);
  });
  assert.equal(h.state.user.publicationVersion, 1);
  assert.ok(h.logs.findIndex(e => e.name === "userFence") < h.logs.findIndex(e => e.name === "count"));
  assert.ok(h.logs.filter(e => e.name === "props").every(e => e.tx));
  assert.equal(new ImportSyncRun({ ...h.run, startedAt: new Date() }).validateSync(), undefined);
});
test("second conditional write failure rolls back entire batch and user fence", async () => {
  const h = harness(2), before = structuredClone(h.state.props); h.fail(2);
  await assert.rejects(() => h.restore(h.request), { code: "REAPPEARED_REVISION_CHANGED" });
  assert.deepEqual(h.state.props, before); assert.equal(h.state.user.publicationVersion, 0);
  assert.equal(h.run.reappearedRestore.status, "failed"); assert.equal(h.run.reappearedRestore.countRestored, 0);
});
for (const [name, mutate, code] of [
  ["deleted", s => { s.props = []; }, "REAPPEARED_PROPERTY_NOT_FOUND"],
  ["owner", s => { s.props[0].usuarioId = S; }, "REAPPEARED_PROPERTY_NOT_FOUND"],
  ["source", s => { s.props[0].importSourceId = U; }, "REAPPEARED_PROPERTY_NOT_FOUND"],
  ["property identity", s => { s.props[0]._id = C; }, "REAPPEARED_IDENTITY_AMBIGUOUS"],
  ["duplicate", s => { s.props.push(structuredClone(s.props[0])); }, "REAPPEARED_IDENTITY_AMBIGUOUS"],
  ["revision", s => { s.props[0].contentRevision++; }, "REAPPEARED_REVISION_CHANGED"],
  ["marker", s => { s.props[0].hiddenByMissingRunId = R; }, "REAPPEARED_MARKER_CHANGED"],
  ["removed date", s => { s.props[0].removedFromFeedAt = new Date(); }, "REAPPEARED_MARKER_CHANGED"],
  ["visible without receipt", s => { s.props[0].visiblePublicamente = true; }, "REAPPEARED_ALREADY_VISIBLE"],
  ["override", s => { s.props[0].syncOverrides.descripcion = true; }, "REAPPEARED_MANUAL_OVERRIDE"],
  ["content", s => { s.props[0].direccion = "Edited"; }, "REAPPEARED_CONTENT_CHANGED"],
  ["photos", s => { s.props[0].imagenes.push("different"); }, "REAPPEARED_CONTENT_CHANGED"],
  ["causal removed", s => { s.runs = s.runs.filter(r => r._id !== C); }, "REAPPEARED_CAUSAL_RUN_INVALID"],
  ["causal failed", s => { s.runs[0].missingHide.status = "failed"; }, "REAPPEARED_CAUSAL_RUN_INVALID"],
  ["causal owner", s => { s.runs[0].usuarioId = S; }, "REAPPEARED_CAUSAL_RUN_INVALID"],
  ["causal not hidden", s => { s.runs[0].missingHide.results[0].status = "failed"; }, "REAPPEARED_CAUSAL_RUN_INVALID"],
  ["reconciliation", s => { s.recs.push({ propiedadId: s.props[0]._id }); }, "REAPPEARED_RECONCILIATION_PENDING"],
  ["inactive", s => { s.user.activo = false; }, "REAPPEARED_PLAN_INACTIVE"],
  ["plan inactive", s => { s.user.planActivo = false; }, "REAPPEARED_PLAN_INACTIVE"],
  ["plan expired", s => { s.user.planFechaFin = new Date(0); }, "REAPPEARED_PLAN_INACTIVE"],
  ["trial expired", s => { Object.assign(s.user, { plan: "vip_trial", trialAccepted: true, trialEndDate: new Date(0) }); }, "REAPPEARED_PLAN_INACTIVE"],
  ["listing expired", s => { s.props[0].fechaExpiracion = new Date(0); }, "REAPPEARED_LISTING_EXPIRED"],
  ["manual hiding", s => { s.props[0].ocultoManual = true; }, "REAPPEARED_OTHER_HIDING_CAUSE"],
  ["lock lost", s => { s.sources[0].importLockToken = "other"; }, "SYNC_SOURCE_BUSY"],
  ["source hash", s => { s.sources[0].feedUrlHash = "b".repeat(64); }, "SYNC_SOURCE_BUSY"]
]) test(`transaction revalidates ${name} and aborts without restoration`, async () => {
  const h = harness(); h.before(mutate);
  await assert.rejects(() => h.restore(h.request), { code });
  assert.ok(h.state.props.every(p => name === "visible without receipt" || p.visiblePublicamente === false));
  assert.ok(!h.logs.some(e => e.name === "props"));
});
for (const [name, mutate, code] of [
  ["expired", h => h.advance(1200001), "REAPPEARED_RUN_EXPIRED"],
  ["incomplete", h => { h.run.snapshotComplete = false; }, "REAPPEARED_SNAPSHOT_INCOMPLETE"],
  ["truncated", h => { h.run.planTruncated = true; }, "REAPPEARED_RUN_TRUNCATED"],
  ["foreign run", h => { h.run.usuarioId = S; }, "REAPPEARED_RUN_NOT_FOUND"],
  ["foreign source", h => { h.state.sources[0].usuarioId = R; }, "SYNC_SOURCE_NOT_FOUND"],
  ["source changed", h => { h.state.sources[0].feedUrlHash = "b".repeat(64); }, "REAPPEARED_SOURCE_CHANGED"],
  ["UPDATE receipt", h => { h.run.status = "applied"; }, "REAPPEARED_OPERATION_CONFLICT"],
  ["UPDATE receipt metadata", h => { h.run.appliedAt = new Date(); }, "REAPPEARED_OPERATION_CONFLICT"],
  ["NEW receipt", h => { h.run.newImport = { status: "completed" }; }, "REAPPEARED_OPERATION_CONFLICT"],
  ["MISSING receipt", h => { h.run.missingHide = { status: "completed" }; }, "REAPPEARED_OPERATION_CONFLICT"],
  ["non REAPPEARED", h => { h.run.plan[0].type = "UPDATE"; }, "REAPPEARED_NOT_ELIGIBLE"],
  ["legacy evidence", h => { delete h.run.plan[0].restoreEvidence; }, "REAPPEARED_RUN_CHANGED"]
]) test(`${name} blocks before refetch`, async () => {
  const h = harness(); mutate(h); await assert.rejects(() => h.restore(h.request), { code });
  assert.equal(h.fetches, 0); assert.ok(!h.logs.some(e => e.name === "props"));
});
test("changed feed and disappeared reference reject before transaction", async () => {
  for (const [feed, code] of [[`<properties>${xmlProperty("CRM-0").replace("198000", "199000")}</properties>`, "REAPPEARED_CONTENT_CHANGED"],
    [`<properties>${xmlProperty("CRM-0")}${xmlProperty("OTHER")}</properties>`, "REAPPEARED_FEED_CHANGED"],
    [`<properties>${xmlProperty("OTHER")}</properties>`, "REAPPEARED_NO_LONGER_PRESENT"], ["<properties/>", "REAPPEARED_SNAPSHOT_INCOMPLETE"]]) {
    const h = harness(); h.feed(feed); await assert.rejects(() => h.restore(h.request), { code });
    assert.equal(h.run.reappearedRestore, undefined); assert.ok(!h.logs.some(e => e.name === "props"));
  }
});
test("persisted changed-content REAPPEARED is not restored", async () => {
  const h = harness(); h.run.plan[0].restoreEligible = false; h.run.plan[0].restoreBlockCode = "REAPPEARED_CONTENT_CHANGED";
  await assert.rejects(() => h.restore(h.request), { code: "REAPPEARED_CONTENT_CHANGED" }); assert.equal(h.fetches, 0);
});
test("real batch capacity rejects two restores for the last slot; exact limit is accepted", async () => {
  for (const visible of [1, 0]) {
    const h = harness(2); h.state.user.plan = "gratis";
    for (let i = 0; i < visible; i++) h.state.props.push({ _id: `other-${i}`, usuarioId: U, visiblePublicamente: true });
    if (visible) await assert.rejects(() => h.restore(h.request), { code: "REAPPEARED_PLAN_LIMIT" });
    else assert.equal((await h.restore(h.request)).countRestored, 2);
    assert.equal(h.state.props.filter(p => p.source === "crm" && p.visiblePublicamente).length, visible ? 0 : 2);
  }
});
test("VIP, accepted VIP trial and launch plan retain commercial rules", async () => {
  for (const plan of ["vip", "vip_trial", "lanzamiento_2026"]) {
    const h = harness(); Object.assign(h.state.user, { plan, trialAccepted: true,
      trialEndDate: new Date(Date.now() + 86400000), planFechaFin: new Date("2027-01-31T22:59:59Z") });
    assert.equal((await h.restore(h.request)).countRestored, 1);
  }
});
test("completed receipt replay is read-only after expiry and different selection is rejected", async () => {
  const h = harness(2), r = await h.restore(h.request), before = structuredClone(h.state), logs = h.logs.length;
  h.advance(3600000);
  assert.deepEqual(await h.restore({ ...h.request, externalIds: [...h.request.externalIds].reverse() }), r);
  assert.deepEqual(h.state, before); assert.equal(h.logs.length, logs); assert.equal(h.fetches, 1);
  await assert.rejects(() => h.restore({ ...h.request, externalIds: ["CRM-0"] }), { code: "REAPPEARED_SELECTION_MISMATCH" });
});
for (const status of ["preparing", "applying", "indeterminate", "failed"]) test(`${status} blocks retries without refetch`, async () => {
  const h = harness(); h.run.reappearedRestore = { status, selectedExternalIds: h.request.externalIds,
    selectionHash: restoreSelectionHash(h.request.externalIds) };
  await assert.rejects(() => h.restore(h.request), { code: status === "indeterminate" ? "REAPPEARED_INDETERMINATE"
    : status === "failed" ? "REAPPEARED_OPERATION_CONFLICT" : "REAPPEARED_IN_PROGRESS" });
  assert.equal(h.fetches, 0); assert.equal(h.logs.length, 0);
});
for (const where of ["before", "after"]) test(`unknown commit ${where} never replays writes and GET recovers stored status`, async () => {
  const h = harness(); h.unknown(where);
  if (where === "before") await assert.rejects(() => h.restore(h.request), { code: "REAPPEARED_INDETERMINATE" });
  else assert.equal((await h.restore(h.request)).status, "completed");
  assert.equal(h.run.reappearedRestore.status, where === "before" ? "indeterminate" : "completed");
  assert.equal(h.state.props[0].visiblePublicamente, where === "after");
  const count = h.logs.length;
  if (where === "before") await assert.rejects(() => h.restore(h.request), { code: "REAPPEARED_INDETERMINATE" });
  else assert.equal((await h.restore(h.request)).status, "completed");
  assert.equal(h.logs.length, count); assert.equal(h.fetches, 1);
});
test("callback retry refetches once and commits one revision/user fence", async () => {
  const h = harness(2); h.retry(); await h.restore(h.request);
  assert.equal(h.fetches, 1); assert.equal(h.state.user.publicationVersion, 1);
  assert.ok(h.state.props.every(p => p.contentRevision === 4));
});
test("run expiring during transaction rolls back every restoration", async () => {
  const h = harness(2), before = structuredClone(h.state.props);
  h.afterWrite(() => h.advance(1200000));
  await assert.rejects(() => h.restore(h.request), { code: "REAPPEARED_RUN_EXPIRED" });
  assert.deepEqual(h.state.props, before); assert.equal(h.state.user.publicationVersion, 0);
});
test("current listing expiry at the exact boundary aborts", async () => {
  const h = harness(); h.before(s => { s.props[0].fechaExpiracion = h.deps.now(); });
  await assert.rejects(() => h.restore(h.request), { code: "REAPPEARED_LISTING_EXPIRED" });
  assert.equal(h.state.props[0].visiblePublicamente, false);
});
test("reconciliation query failure is uncertain and never authorizes restoration", async () => {
  const h = harness(); h.deps.ReconciliationModel.find = () => { throw new Error("private internal failure"); };
  await assert.rejects(() => h.restore(h.request), { code: "REAPPEARED_INDETERMINATE" });
  assert.equal(h.state.props[0].visiblePublicamente, false); assert.equal(h.run.reappearedRestore.status, "indeterminate");
});
test("corrupt completed receipt cannot manufacture idempotent success", async () => {
  const h = harness(); await h.restore(h.request); h.run.reappearedRestore.results[0].status = "failed";
  await assert.rejects(() => h.restore(h.request), { code: "REAPPEARED_INDETERMINATE" });
});
test("real UPDATE, NEW and MISSING services reject a restore-consumed run without refetch", async () => {
  const h = harness(); await h.restore(h.request); const fetches = h.fetches;
  for (const [service, code] of [[createSyncApplier(h.deps), "RUN_BLOCKED"],
    [createSyncNewImporter(h.deps), "RUN_BLOCKED"], [createMissingHider(h.deps), "MISSING_OPERATION_BLOCKED"]])
    await assert.rejects(() => service(h.request), { code });
  assert.equal(h.fetches, fetches);
});
test("receipt freezes run for UPDATE, NEW and MISSING; safe GET hides all internal data", async () => {
  const h = harness(); await h.restore(h.request);
  assert.equal(evaluateRunApplyEligibility(h.run).applyEligible, false);
  assert.equal(evaluateRunNewImportEligibility(h.run).newImportEligible, false);
  assert.equal(safeMissingEligibility({}, h.run, new Date(), runVersions).hideMissingEligible, false);
  const safe = safeRunSummary(h.run);
  assert.equal(safe.reappearedRestore.status, "completed"); assert.equal(safe.reappearedRestore.countRestored, 1);
  assert.doesNotMatch(JSON.stringify(safe), /operationId|selectionHash|propiedadId|usuarioId|importSourceId|hiddenByMissingRunId|Fingerprint|Revision|restoreEvidence/);
});
for (const source of ["manual", "crm"]) test(`publicationVersion serializes restore and ${source} publication persistence for last slot`, async () => {
  const h = harness(); h.state.user.plan = "gratis";
  h.state.props.push({ _id: "existing", usuarioId: U, visiblePublicamente: true });
  const publish = createPublicationPersistence(h.deps);
  const publications = [];
  h.onFetch(() => publications.push(publish({ usuarioId: U,
    ...(source === "crm" ? { extra: { source: "crm", importSourceId: S, externalId: "NEW-CRM" } } : {}),
    propertyId: "000000000000000000000099", body: { titulo: "Manual", precio: 1, tipoOperacion: "venta", direccion: "Direccion", habitaciones: 2 } })));
  const results = [...await Promise.allSettled([h.restore(h.request)]), ...await Promise.allSettled(publications)];
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(h.state.props.filter(p => p.visiblePublicamente === true).length, 2);
  const fences = h.logs.filter(e => e.name === "userFence");
  assert.equal(fences.length, 2); assert.ok(fences.every(e => e.tx && e.f._id === U && e.op.$inc.publicationVersion === 1));
});
test("two source-independent restores share user fence and cannot consume last slot twice", async () => {
  const h = harness(2); h.state.user.plan = "gratis";
  const s2 = "000000000000000000000005", r2 = "000000000000000000000006", c2 = "000000000000000000000007";
  const source2 = { ...h.state.sources[0], _id: s2 };
  h.state.sources.push(source2); h.state.props[1].importSourceId = s2; h.state.props[1].hiddenByMissingRunId = c2;
  const cause2 = structuredClone(h.state.runs[0]); cause2._id = c2; cause2.importSourceId = s2;
  cause2.plan = [cause2.plan[1]]; cause2.plan[0].missingEvidence.importSourceId = s2;
  cause2.missingHide.selectedExternalIds = ["CRM-1"]; cause2.missingHide.results = [{ externalId: "CRM-1", status: "hidden" }];
  cause2.missingHide.countHidden = 1;
  const run2 = structuredClone(h.run); run2._id = r2; run2.importSourceId = s2; run2.plan = [run2.plan[1]];
  Object.assign(run2.plan[0].restoreEvidence, { importSourceId: s2, expectedHiddenByMissingRunId: c2, causalRunId: c2 });
  h.run.plan = [h.run.plan[0]]; h.state.runs.push(cause2, run2);
  h.state.props.push({ _id: "existing", usuarioId: U, visiblePublicamente: true });
  const results = await Promise.allSettled([h.restore({ ...h.request, externalIds: ["CRM-0"] }),
    h.restore({ usuarioId: U, runId: r2, externalIds: ["CRM-1"] })]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.find(r => r.status === "rejected").reason.code, "REAPPEARED_PLAN_LIMIT");
  assert.equal(h.state.props.filter(p => p.visiblePublicamente === true).length, 2);
});

function http(app, path, { method = "POST", body, auth = true } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const req = new Readable({ read() { this.push(payload); this.push(null); } });
    Object.assign(req, { method, url: path, originalUrl: path, complete: true,
      headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)),
        ...(auth ? { authorization: `Bearer ${jwt.sign({ id: U }, "restore-test-only")}` } : {}) }, socket: new PassThrough() });
    req.socket.remoteAddress = "127.0.0.1"; req.connection = req.socket;
    const chunks = [], headers = {}, res = new Writable({ write(c, e, cb) { chunks.push(Buffer.from(c)); cb(); } });
    res.statusCode = 200; res.setHeader = (k, v) => { headers[k.toLowerCase()] = v; };
    res.getHeader = k => headers[k.toLowerCase()]; res.removeHeader = k => { delete headers[k.toLowerCase()]; };
    const end = res.end.bind(res); res.end = c => { if (c) chunks.push(Buffer.from(c)); end();
      resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); };
    app.handle(req, res, reject);
  });
}
test("authenticated HTTP strict contract, completed receipt and lost-response GET recovery", async () => {
  const h = harness(), original = Usuario.findById, secret = process.env.JWT_SECRET;
  Usuario.findById = async () => h.state.user; process.env.JWT_SECRET = "restore-test-only";
  const pass = (req, res, next) => next(), app = express(); app.use(express.json());
  app.use("/api/crm-import", createCrmImportRouter({ ...h.deps, restoreReappearedSync: h.restore,
    restoreRateLimitMiddleware: pass, restoreUserRateLimitMiddleware: pass }));
  const path = "/api/crm-import/sync/restore-reappeared", body = { runId: R, externalIds: ["CRM-0"] };
  try {
    assert.equal((await http(app, path, { body, auth: false })).status, 401);
    for (const invalid of [{ ...body, sourceId: S }, { ...body, userId: U }, { ...body, propertyId: C },
      { ...body, precio: 1 }, { ...body, externalIds: [] }, { ...body, externalIds: ["CRM-0", "CRM-0"] },
      { ...body, externalIds: Array.from({ length: 11 }, (_, i) => `CRM-${i}`) }, { ...body, externalIds: [" CRM-0"] }])
      assert.equal((await http(app, path, { body: invalid })).status, 400);
    assert.equal((await http(app, path, { body: { ...body, runId: S } })).status, 404);
    assert.equal((await http(app, path, { body })).body.status, "completed");
    const result = await http(app, `/api/crm-import/sync/runs/${R}`, { method: "GET" });
    assert.equal(result.status, 200); assert.equal(result.body.reappearedRestore.countRestored, 1);
    assert.doesNotMatch(JSON.stringify(result.body), /operationId|selectionHash|restoreEvidence|hiddenByMissingRunId|Fingerprint|Revision/);
    const writes = h.logs.length; assert.equal((await http(app, path, { body })).status, 200); assert.equal(h.logs.length, writes);
  } finally {
    Usuario.findById = original; if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret;
  }
});
test("no external effects, private defaults and no property deletion", () => {
  assert.equal(new ImportSyncRun().reappearedRestore, undefined);
  const code = fs.readFileSync(new URL("../utils/import/syncRestoreReappeared.js", import.meta.url), "utf8");
  assert.doesNotMatch(code, /Cloudinary|deleteOne|deleteMany|Notificacion|Conversacion|Mensaje|enviarCorreo/i);
});
