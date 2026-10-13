import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import Propiedad from "../models/Propiedad.js";
import { capturePropertyContent, markManualContentChanges } from "../utils/propertyContent.js";
import { guardManualPropertyRevision } from "../utils/propertyRevision.js";
import { consumesPublicationQuota, filtroPropiedadesValidasVisibles, publicationPlanIsCurrent } from "../utils/publishEligibility.js";
import { KNOWN_PLAN_IDS } from "../utils/planLimits.js";
import { createPropertyCapacityTransition } from "../utils/propertyCapacityTransition.js";
import { createPublicationPersistence } from "../utils/publicationPersistence.js";
import { aplicarLimitesPlanTrasTrial } from "../utils/trialPlanLimits.js";
import { createReappearedRestorer } from "../utils/import/syncRestoreReappeared.js";
import { buildSyncSnapshot } from "../utils/import/syncSnapshot.js";
import { prepareSyncPlan, runVersions, snapshotDigest } from "../utils/import/syncPlan.js";
import { managedFingerprint } from "../utils/import/syncBaseline.js";
import { missingContentFingerprint } from "../utils/import/missingEligibility.js";
import { encryptFeedUrl } from "../utils/import/feedUrlCrypto.js";

const U = "000000000000000000000001", S = "000000000000000000000002", R = "000000000000000000000003",
  C = "000000000000000000000004", P = "000000000000000000000005";
const env = { CRM_FEED_URL_KEY_V1: crypto.randomBytes(32).toString("base64") };
const xml = `<properties><property><externalId>RESTORE</externalId><title>Casa</title><description>Original</description>
<price>100000</price><operation>venta</operation><address>Rota</address><city>Rota</city><province>Cádiz</province>
<propertyType>piso</propertyType><condition>used</condition><bedrooms>2</bedrooms><bathrooms>1</bathrooms>
<surface>72</surface><garage>false</garage><pool>false</pool><terrace>true</terrace></property></properties>`;
function clone(value) {
  if (value instanceof Date) return new Date(value);
  if (value?.toHexString) return value.toHexString();
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]));
  return value;
}
function values(doc, path) {
  if (!path.length) return Array.isArray(doc) ? doc.flatMap(d => values(d, [])) : [doc];
  return Array.isArray(doc) ? doc.flatMap(d => values(d, path)) : values(doc?.[path[0]], path.slice(1));
}
const eq = (a, b) => a instanceof Date && b instanceof Date ? +a === +b : String(a) === String(b);
function matches(doc, filter) {
  return !!doc && Object.entries(filter).every(([key, e]) => {
    if (key === "$or") return e.some(f => matches(doc, f));
    if (key === "$and") return e.every(f => matches(doc, f));
    const actual = values(doc, key.split("."));
    if (e && typeof e === "object" && !(e instanceof Date) && !e.toHexString) return Object.entries(e).every(([op, v]) => {
      if (op === "$exists") return actual.some(a => a !== undefined) === v;
      if (op === "$ne") return actual.every(a => !eq(a, v));
      if (op === "$in") return actual.some(a => v.some(b => eq(a, b)));
      if (op === "$nin") return actual.every(a => !v.some(b => eq(a, b)));
      if (op === "$gt") return actual.some(a => a > v);
      if (op === "$lte") return actual.some(a => a <= v);
      return false;
    });
    return e === null ? actual.some(a => a == null) : actual.some(a => eq(a, e));
  });
}
function mutate(doc, op) {
  function set(key, value) { const parts = key.split("."); let node = doc;
    for (const part of parts.slice(0, -1)) node = node[part] ||= {};
    node[parts.at(-1)] = clone(value);
  }
  for (const [k, v] of Object.entries(op.$set || {})) set(k, v);
  for (const [k, v] of Object.entries(op.$inc || {})) set(k, (values(doc, k.split("."))[0] || 0) + v);
  for (const key of Object.keys(op.$unset || {})) delete doc[key];
}
function fixture(visible = 1) {
  const now = new Date(), base = { titulo: "Casa", precio: 100000, direccion: "Rota", tipoOperacion: "venta",
    habitaciones: 2, banos: 1, superficie: 72, estadoComercial: "Disponible", imagenes: [], contentRevision: 0,
    usuarioId: U, visiblePublicamente: true, fechaExpiracion: new Date(0) };
  const snapshot = buildSyncSnapshot(xml);
  const original = { ...base, ...snapshot.properties[0].data, _id: P, source: "crm", importSourceId: S,
    syncEnabled: true, syncOverrides: {}, syncApplyFingerprintVersion: 1, contentRevision: 2, fechaExpiracion: null };
  original.syncApplyFingerprint = managedFingerprint(original);
  const source = { _id: S, usuarioId: U, activo: true, feedType: "generic_xml", ...encryptFeedUrl("https://feeds.example/catalog.xml", env) };
  const hideStart = new Date(+now - 3600000);
  const causal = { _id: C, usuarioId: U, importSourceId: S, status: "simulated", sourceIdentityHash: source.feedUrlHash,
    snapshotDigest: snapshotDigest(snapshot), ...runVersions, snapshotComplete: true, planTruncated: false, totalResults: 1,
    plan: [{ externalId: "RESTORE", type: "MISSING", propiedadId: P, hideMissingEligible: true,
      safeReasonCode: "MISSING_REQUIRES_REVIEW", missingEvidence: { version: 1, usuarioId: U, importSourceId: S,
        expectedContentRevision: 2, expectedVisiblePublicamente: true, enrolled: true, reconciliationChecked: true,
        baselineVersion: 1, expectedBaselineFingerprint: original.syncApplyFingerprint,
        expectedContentFingerprint: missingContentFingerprint(original) } }],
    missingHide: { status: "completed", selectedExternalIds: ["RESTORE"], results: [{ externalId: "RESTORE", status: "hidden" }],
      countHidden: 1, countAlreadyHidden: 0, startedAt: hideStart, completedAt: new Date(+hideStart + 2000) } };
  const restored = { ...original, visiblePublicamente: false, contentRevision: 3, hiddenByMissingRunId: C,
    removedFromFeedAt: new Date(+hideStart + 1000) };
  const state = { users: [{ _id: U, activo: true, plan: "gratis", planActivo: false, publicationVersion: 0 }],
    props: [...Array.from({ length: visible }, (_, i) => ({ ...base, _id: String(100 + i).padStart(24, "0") })),
      { ...base, _id: "000000000000000000000010", estadoComercial: "Vendido" },
      { ...base, _id: "000000000000000000000011", visiblePublicamente: false }, restored], sources: [source], runs: [causal], recs: [] };
  const planned = prepareSyncPlan(snapshot, [restored], { usuarioId: U, importSourceId: S, sourceIdentityHash: source.feedUrlHash,
    snapshotDigest: snapshotDigest(snapshot), versions: runVersions, causalRuns: [causal], reconciliations: [],
    user: state.users[0], visibleCount: visible, now });
  state.runs.push({ _id: R, usuarioId: U, importSourceId: S, status: "simulated", sourceIdentityHash: source.feedUrlHash,
    snapshotDigest: snapshotDigest(snapshot), snapshotComplete: true, expiresAt: new Date(+now + 1200000), ...runVersions,
    ...planned, planTruncated: false });
  const logs = []; let conflicts = 0, attempts = 0, failWrite = false, forceRetry = false, unknown, validations = 0,
    barrier, releaseBarrier, arrivals = 0;
  const live = session => session?.data || state;
  const query = fn => { let session; return { select() { return this; }, lean() { return this; },
    session(s) { session = s; return this; }, read() { return this; }, readConcern() { return this; }, maxTimeMS() { return this; },
    then(resolve, reject) { return Promise.resolve().then(() => clone(fn(live(session), session))).then(resolve, reject); } }; };
  function model(name) {
    return { findOne: filter => query(s => s[name].find(p => matches(p, filter))),
      findById: key => query(s => s[name].find(p => eq(p._id, key))), find: filter => query(s => s[name].filter(p => matches(p, filter))),
      async updateOne(filter, op, opts = {}) {
        logs.push({ name, filter: clone(filter), op: clone(op), session: opts.session?.number });
        if (name === "props" && failWrite) return { matchedCount: 0 };
        const row = live(opts.session)[name].find(p => matches(p, filter));
        if (!row) return { matchedCount: 0, modifiedCount: 0 };
        mutate(row, op); opts.session?.writes.push({ name, filter: clone(filter), op: clone(op) });
        return { matchedCount: 1, modifiedCount: 1 };
      } };
  }
  async function startSession() {
    return { number: ++attempts, async withTransaction(callback, opts) {
      assert.deepEqual(opts.readConcern, { level: "snapshot" }); assert.deepEqual(opts.writeConcern, { w: "majority" });
      for (let retry = 0; retry < 8; retry++) {
        this.data = clone(state); this.writes = []; const version = state.users[0].publicationVersion;
        try {
          if (barrier && retry === 0) { if (++arrivals === 2) releaseBarrier(); else await barrier; }
          await callback(); await Promise.resolve();
          // Optimistic MVCC: a stale user write conflicts at commit and reruns with a fresh snapshot.
          if (state.users[0].publicationVersion !== version || (forceRetry && retry === 0)) { conflicts++; continue; }
          const committed = clone(state);
          for (const w of this.writes) {
            if (w.name === "create") committed.props.push(clone(w.row));
            else {
              const row = committed[w.name].find(p => matches(p, w.filter));
              if (!row) throw Object.assign(new Error("WriteConflict"), { transient: true });
              mutate(row, w.op);
            }
          }
          if (unknown === "before") throw Object.assign(new Error("unknown commit"), { errorLabels: ["UnknownTransactionCommitResult"] });
          Object.assign(state, committed);
          if (unknown === "after") throw Object.assign(new Error("unknown commit"), { errorLabels: ["UnknownTransactionCommitResult"] });
          return;
        } catch (error) { if (error.transient) { conflicts++; continue; } throw error; }
        finally { this.data = undefined; }
      }
      throw new Error("mock transaction retry exhausted");
    }, async endSession() {} };
  }
  const users = model("users"), props = model("props"), sources = model("sources"); users.startSession = startSession;
  props.startSession = startSession;
  props.countDocuments = filter => query((s, session) => { logs.push({ name: "count", session: session?.number });
    return s.props.filter(p => matches(p, filter)).length; });
  props.create = async (docs, opts) => docs.map(doc => { const row = { visiblePublicamente: true, ...clone(doc) };
    opts.session.data.props.push(row); opts.session.writes.push({ name: "create", row }); return row; });
  sources.findOneAndUpdate = async (f, op) => { const row = state.sources.find(p => matches(p, f));
    if (!row) return null; mutate(row, op); return clone(row); };
  const deps = { UsuarioModel: users, PropiedadModel: props, ImportSourceModel: sources, ImportSyncRunModel: model("runs"),
    ReconciliationModel: model("recs"), env, now: () => new Date(), fetchXml: async () => ({ xml }) };
  function edit(key, fields) {
    const row = state.props.find(p => eq(p._id, key)); const doc = Propiedad.hydrate(clone(row));
    const validate = doc.validate;
    doc.validate = async (...args) => { validations++; return validate.apply(doc, args); };
    const before = capturePropertyContent(doc); guardManualPropertyRevision(doc);
    doc.set(fields); markManualContentChanges(doc, before);
    doc.save = async () => { logs.push({ name: "plainSave" }); const stored = state.props.find(p => eq(p._id, doc._id));
      if (!matches(stored, doc.$where)) throw Object.assign(new Error("changed"), { code: "PROPERTY_REVISION_CONFLICT" });
      mutate(stored, doc.getChanges()); return doc; };
    return createPropertyCapacityTransition(deps)(doc, before);
  }
  const publish = createPublicationPersistence(deps);
  const restore = createReappearedRestorer(deps);
  return { state, logs, deps, edit, get conflicts() { return conflicts; }, fail() { failWrite = true; }, retry() { forceRetry = true; },
    get validations() { return validations; }, unknown(where) { unknown = where; },
    concurrent() { barrier = new Promise(resolve => { releaseBarrier = resolve; }); },
    occupied: () => state.props.filter(consumesPublicationQuota).length,
    restore: () => restore({ usuarioId: U, runId: R, externalIds: ["RESTORE"] }),
    publish: source => publish({ usuarioId: U, propertyId: "000000000000000000000099",
      body: { titulo: "Nuevo", direccion: "Rota", precio: 100000, tipoOperacion: "venta", habitaciones: 2 },
      ...(source === "crm" ? { extra: { source: "crm", externalId: "NEW", importSourceId: S } } : {}) }),
    recover: () => aplicarLimitesPlanTrasTrial(U, { planDestino: "gratis", repararSiNoHayVisibles: true,
      repararPeriodosCaducados: true, renovarPermitidas: false, UsuarioModel: users, PropiedadModel: props }) };
}
const SOLD = "000000000000000000000010", HIDDEN = "000000000000000000000011";

test("quota predicate exactly matches existing Mongo filter, including absent flags and expiry", () => {
  const filter = filtroPropiedadesValidasVisibles(U);
  for (const doc of [{}, { visiblePublicamente: false }, { activo: false }, { eliminada: true }, { oculto: true },
    { estadoComercial: "Vendido" }, { estadoComercial: "vendido" }, { fechaExpiracion: new Date(0) },
    { estadoComercial: "Disponible" }, { ocultaManual: true }]) {
    assert.equal(consumesPublicationQuota(doc), matches({ usuarioId: U, ...doc }, filter));
  }
});
test("plan validation retains all catalog plans, accepts current trials and rejects expired/inactive plans", () => {
  const now = new Date("2026-10-13T12:00:00Z"), future = new Date("2027-01-30T00:00:00Z");
  for (const plan of KNOWN_PLAN_IDS) {
    const user = { plan, activo: true, planActivo: true, trialAccepted: true, trialEndDate: future,
      planFechaFin: future, professionalPromoStatus: "active", professionalPromoEndsAt: future };
    assert.equal(publicationPlanIsCurrent(user, now), true, plan);
    assert.equal(publicationPlanIsCurrent({ ...user, planFechaFin: now }, now), false, plan);
    assert.equal(publicationPlanIsCurrent({ ...user, activo: false }, now), false, plan);
    if (plan !== "gratis") assert.equal(publicationPlanIsCurrent({ ...user, planActivo: false }, now), false, plan);
  }
});
for (const [name, key, fields] of [["normal sold to available", SOLD, { estadoComercial: "Disponible" }],
  ["admin false to true", HIDDEN, { visiblePublicamente: true }]]) {
  test(`${name} consumes a free slot with fence before count`, async () => {
    const h = fixture(); await h.edit(key, fields); assert.equal(h.occupied(), 2);
    assert.equal(h.state.users[0].publicationVersion, 1);
    assert.ok(h.logs.findIndex(l => l.name === "users") < h.logs.findIndex(l => l.name === "count"));
  });
  test(`${name} at limit rejects without property/fence commit`, async () => {
    const h = fixture(2), before = clone(h.state);
    await assert.rejects(() => h.edit(key, fields), { code: "PUBLICATION_PLAN_LIMIT" });
    assert.deepEqual(h.state, before);
  });
}
for (const [name, fields] of [["price edit at limit", { precio: 200000 }], ["description edit at limit", { descripcion: "Editada" }],
  ["normal available to sold", { estadoComercial: "Vendido" }], ["admin hide", { visiblePublicamente: false }]])
  test(`${name} does not acquire capacity or fail at limit`, async () => {
    const h = fixture(2); await h.edit(h.state.props[0]._id, fields);
    assert.equal(h.state.users[0].publicationVersion, 0); assert.ok(!h.logs.some(l => l.name === "count"));
  });
test("manual/admin cannot republish MISSING or a stale removed marker", async () => {
  for (const marker of [C, null]) {
    const h = fixture(); h.state.props.find(p => p._id === P).hiddenByMissingRunId = marker;
    await assert.rejects(() => h.edit(P, { visiblePublicamente: true }), { code: "PUBLICATION_MISSING_PROTECTED" });
    assert.equal(h.state.props.find(p => p._id === P).visiblePublicamente, false);
  }
});
test("conditional failure rolls back fence and preserves property", async () => {
  const h = fixture(), before = clone(h.state); h.fail();
  await assert.rejects(() => h.edit(SOLD, { estadoComercial: "Disponible" }), { code: "PROPERTY_REVISION_CONFLICT" });
  assert.deepEqual(h.state, before);
});
test("transaction retry executes no external effects and increments revision/fence once", async () => {
  const h = fixture(); h.retry(); await h.edit(SOLD, { estadoComercial: "Disponible" });
  assert.equal(h.conflicts, 1); assert.equal(h.state.users[0].publicationVersion, 1);
  assert.equal(h.state.props.find(p => p._id === SOLD).contentRevision, 1);
  assert.equal(h.validations, 1);
  assert.ok(!h.logs.some(l => l.name === "plainSave"));
});
for (const where of ["before", "after"]) test(`unknown edit commit ${where} retains uploaded resources and never claims failure/success`, async () => {
  const h = fixture(); h.unknown(where);
  await assert.rejects(() => h.edit(SOLD, { estadoComercial: "Disponible" }), error =>
    error.code === "PUBLICATION_EDIT_UNCONFIRMED" && error.status === 503 && error.retainImages === true);
  assert.equal(h.occupied(), where === "after" ? 2 : 1);
  assert.equal(h.state.users[0].publicationVersion, where === "after" ? 1 : 0);
});
test("recovery fills at most two slots and always excludes MISSING", async () => {
  const h = fixture(0); h.state.props.push({ ...clone(h.state.props.find(p => p._id === HIDDEN)), _id: "000000000000000000000012" },
    { ...clone(h.state.props.find(p => p._id === HIDDEN)), _id: "000000000000000000000013" });
  const result = await h.recover(); assert.equal(result.propiedadesRecuperadas, 2); assert.equal(h.occupied(), 2);
  assert.equal(h.state.props.find(p => p._id === P).visiblePublicamente, false);
  assert.ok(h.logs.findIndex(l => l.name === "users") < h.logs.findIndex(l => l.name === "count"));
});
test("recovery at limit restores zero and does not displace current publications", async () => {
  const h = fixture(2), ids = h.state.props.filter(consumesPublicationQuota).map(p => p._id);
  const result = await h.recover(); assert.equal(result.propiedadesRecuperadas, 0); assert.equal(h.occupied(), 2);
  assert.deepEqual(h.state.props.filter(consumesPublicationQuota).map(p => p._id), ids);
});
test("pure plan limit reduction does not increment publicationVersion", async () => {
  const h = fixture(3);
  const result = await aplicarLimitesPlanTrasTrial(U, { UsuarioModel: h.deps.UsuarioModel, PropiedadModel: h.deps.PropiedadModel });
  assert.equal(result.propiedadesOcultadas, 2); // one sold record and one excess public record
  assert.equal(h.occupied(), 2); assert.equal(h.state.users[0].publicationVersion, 0);
});
test("stale plan recovery aborts instead of applying an obsolete destination", async () => {
  const h = fixture(); h.state.users[0].plan = "vip"; h.state.users[0].planActivo = true;
  await assert.rejects(h.recover, { code: "PUBLICATION_PLAN_CHANGED" }); assert.equal(h.state.users[0].publicationVersion, 0);
});
const operations = {
  restore: h => h.restore(), normal: h => h.edit(SOLD, { estadoComercial: "Disponible" }),
  admin: h => h.edit(HIDDEN, { visiblePublicamente: true }), recovery: h => h.recover(),
  manual: h => h.publish("manual"), NEW: h => h.publish("crm")
};
for (const [a, b] of [["restore", "normal"], ["restore", "admin"], ["restore", "recovery"], ["NEW", "normal"],
  ["NEW", "admin"], ["NEW", "recovery"], ["manual", "recovery"], ["admin", "recovery"]])
  test(`${a} + ${b} race on last slot retries a stale snapshot and never produces N+1`, async () => {
    const h = fixture(); h.concurrent(); const results = await Promise.allSettled([operations[a](h), operations[b](h)]);
    assert.equal(h.occupied(), 2);
    assert.ok(h.conflicts >= 1, "must model a real stale-version commit conflict, not just serialize callbacks");
    if (b !== "recovery") assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    else assert.ok(results.some(r => r.status === "fulfilled"));
    for (const rejected of results.filter(r => r.status === "rejected"))
      assert.ok(["PUBLICATION_PLAN_LIMIT", "REAPPEARED_PLAN_LIMIT"].includes(rejected.reason.code) || /límite/.test(rejected.reason.message));
    const r = h.state.props.find(p => p._id === P);
    if (a !== "restore") assert.equal(r.visiblePublicamente, false);
  });
test("recovery retry never publishes hiddenByMissingRunId and retains exactly available slots", async () => {
  const h = fixture(0); h.retry(); const result = await h.recover();
  assert.equal(result.propiedadesRecuperadas, 1); assert.equal(h.occupied(), 1);
  assert.equal(h.state.props.find(p => p._id === P).hiddenByMissingRunId, C);
});
test("both online edit routes use the capacity helper; external image effects remain outside it", () => {
  const normal = fs.readFileSync(new URL("../routes/propiedades.js", import.meta.url), "utf8");
  const admin = fs.readFileSync(new URL("../routes/admin.js", import.meta.url), "utf8");
  assert.match(normal, /savePropertyWithCapacity\(propiedad, contenidoAnterior\)/);
  assert.match(admin, /savePropertyWithCapacity\(propiedad, contenidoAnterior\)/);
  assert.match(normal, /debeLimpiarSubidas && !err.retainImages/);
  const helper = fs.readFileSync(new URL("../utils/propertyCapacityTransition.js", import.meta.url), "utf8");
  assert.doesNotMatch(helper, /cloudinary|enviarCorreo|deleteMany|deleteOne/i);
});
