import { providerSnapshotStore } from "./helpers/providerSnapshotStore.js";
import { createProviderSnapshots, SNAPSHOT_REQUIRED } from "../utils/import/providerSnapshots.js";
import { createFeedAccess, PROVIDER_BLOCKED } from "../utils/import/feedAccess.js";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";
import express from "express";
import jwt from "jsonwebtoken";
import { Readable, Writable, PassThrough } from "node:stream";
import Usuario from "../models/Usuario.js";
import Propiedad from "../models/Propiedad.js";
import ImportSyncRun from "../models/ImportSyncRun.js";
import { createCrmImportRouter } from "../routes/crmImport.js";
import { createSyncNewImporter } from "../utils/import/syncImportNew.js";
import { createSelectedImporter } from "../utils/import/selectedImport.js";
import { buildSyncSnapshot } from "../utils/import/syncSnapshot.js";
import { parseGenericPropertyNodes, analyzeGenericPropertyNodes } from "../utils/importers/genericXmlImporter.js";
import { prepareSyncPlan, snapshotDigest, runVersions, safeRunSummary, evaluateRunApplyEligibility } from "../utils/import/syncPlan.js";
import { encryptFeedUrl } from "../utils/import/feedUrlCrypto.js";
import { createImportBudget, MAX_BATCH_PROPERTIES, MAX_BATCH_PHOTOS, MAX_BATCH_MS } from "../utils/import/importBudget.js";
import { securityRateLimits } from "../utils/security.js";
import { createMissingHider } from "../utils/import/syncHideMissing.js";
import { createSyncApplier } from "../utils/import/syncApply.js";
import { managedFingerprint } from "../utils/import/syncBaseline.js";
import { buildFeedSnapshot } from "../utils/importers/importerRegistry.js";
import { receivedNewSnapshotValid } from "../utils/import/inmowebPolicy.js";
import { createSyncSimulator } from "../utils/import/syncSimulation.js";
import { createReappearedRestorer } from "../utils/import/syncRestoreReappeared.js";
import { createSyncEnroller } from "../utils/import/syncEnroll.js";
import { acquireSyncLock } from "../utils/import/syncLock.js";
import { getLimiteFotosPlan } from "../utils/planLimits.js";

const U = "507f1f77bcf86cd799439099", S = "507f1f77bcf86cd799439098", R = "507f1f77bcf86cd799439096";
const env = { CRM_FEED_URL_KEY_V1: crypto.randomBytes(32).toString("base64") };
const xml = (count = 1, photos = 0) => `<properties>${Array.from({ length: count }, (_, i) =>
  `<property><id>N-${i}</id><title>Casa ${i}</title><description>Texto</description><price>120</price><operation>sale</operation>
  <address>Chipiona ${i}</address><city>Chipiona</city><bedrooms>2</bedrooms><bathrooms>1</bathrooms><propertyType>piso</propertyType>
  <photos>${Array.from({ length: photos }, (_, n) => `<photo>https://images.example/${i}-${n}.jpg</photo>`).join("")}</photos></property>`).join("")}</properties>`;

function mixedOperationHarness() {
  const updateRecord = xml(1).replaceAll("N-0", "UPDATE-1").replaceAll("120", "200")
    .replace("Casa 0", "Vivienda existente").replace("Chipiona 0", "Direccion existente");
  const feedXml = xml(1).replace("</properties>", updateRecord.replace("<properties>", ""));
  const h = harness({ feedXml });
  const incoming = buildSyncSnapshot(updateRecord).properties[0].data;
  const updated = { ...incoming, _id: "000000000000000000000010", usuarioId: U, importSourceId: S, source: "crm",
    precio: 100, imagenes: [], visiblePublicamente: true, syncEnabled: true, syncOverrides: {}, contentRevision: 2,
    syncApplyFingerprintVersion: 1 };
  updated.syncApplyFingerprint = managedFingerprint(updated);
  const absent = { ...updated, _id: "000000000000000000000011", externalId: "MISSING-1", contentRevision: 3 };
  h.state.properties.push(updated, absent);
  const snapshot = buildSyncSnapshot(feedXml);
  Object.assign(h.state.run, prepareSyncPlan(snapshot, h.state.properties, { usuarioId: U, importSourceId: S, reconciliations: [] }));
  const hide = createMissingHider(h.dependencies), apply = createSyncApplier(h.dependencies);
  return { ...h, hide, apply, hideRequest: { usuarioId: U, runId: R, externalIds: ["MISSING-1"] },
    applyRequest: { usuarioId: U, runId: R, externalIds: ["UPDATE-1"] } };
}

for (const opponent of ["UPDATE", "NEW"]) for (const winner of ["MISSING", "opponent"])
  test(`real services ${opponent} vs MISSING: ${winner} wins shared lock/run without mixed receipts`, async () => {
    const h = mixedOperationHarness();
    assert.equal(h.state.run.plan.find(e => e.externalId === "MISSING-1").hideMissingEligible, true);
    assert.equal(h.state.run.plan.find(e => e.externalId === "UPDATE-1").type, "UPDATE");
    assert.equal(h.state.run.plan.find(e => e.externalId === "N-0").type, "NEW");
    const before = structuredClone(h.state.properties);
    let unlock, signal;
    const paused = new Promise(resolve => { unlock = resolve; }), started = new Promise(resolve => { signal = resolve; });
    h.faults.fetch = async () => { signal(); await paused; };
    const competing = () => opponent === "UPDATE" ? h.apply(h.applyRequest) : h.run(h.request);
    const winning = () => winner === "MISSING" ? h.hide(h.hideRequest) : competing();
    const losing = () => winner === "MISSING" ? competing() : h.hide(h.hideRequest);
    const pending = winning(); await started;
    await assert.rejects(losing, { code: "SYNC_SOURCE_BUSY" });
    unlock(); const receipt = await pending;
    assert.equal(h.state.source.importLockToken, undefined);
    assert.equal(h.effects.fetch, 1);
    assert.equal(h.effects.uploads, 0); assert.equal(h.effects.downloads, 0); assert.equal(h.effects.deletes, 0);
    if (winner === "MISSING") {
      assert.equal(receipt.status, "completed"); assert.equal(h.state.run.missingHide.status, "completed");
      assert.equal(h.state.run.newImport, undefined); assert.equal(h.state.run.appliedCount, undefined);
      assert.deepEqual(h.state.properties[0], before[0]);
      assert.equal(h.state.properties[1].visiblePublicamente, false); assert.equal(h.state.properties[1].contentRevision, 4);
      assert.equal(h.state.properties.length, 2);
      await assert.rejects(losing, { code: "RUN_BLOCKED" });
    } else {
      assert.equal(h.state.run.missingHide, undefined); assert.deepEqual(h.state.properties[1], before[1]);
      if (opponent === "UPDATE") {
        assert.equal(h.state.run.status, "applied"); assert.equal(receipt.appliedCount, 1);
        assert.equal(h.state.properties[0].precio, 200); assert.equal(h.state.properties[0].contentRevision, 3);
        assert.equal(h.state.run.newImport, undefined);
      } else {
        assert.equal(h.state.run.newImport.status, "completed"); assert.equal(receipt.newImport.counts.imported, 1);
        assert.equal(h.state.properties.filter(p => p.externalId === "N-0").length, 1);
        assert.deepEqual(h.state.properties[0], before[0]); assert.equal(h.state.user.publicationVersion, 1);
        assert.equal(h.state.run.appliedCount, undefined);
      }
      await assert.rejects(losing, { code: "MISSING_OPERATION_BLOCKED" });
    }
  });
function values(doc, path) {
  if (!path.length) return [doc];
  if (Array.isArray(doc)) return doc.flatMap(d => values(d, path));
  return values(doc?.[path[0]], path.slice(1));
}
const equal = (a, b) => a instanceof Date && b instanceof Date ? +a === +b
  : Array.isArray(a) && Array.isArray(b) ? JSON.stringify(a) === JSON.stringify(b) : String(a) === String(b);
function matches(doc, filter) {
  return Boolean(doc) && Object.entries(filter).every(([key, value]) => {
    if (key === "$or") return value.some(f => matches(doc, f));
    const actual = values(doc, key.split("."));
    if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      return Object.entries(value).every(([op, expected]) => {
        if (op === "$in") return actual.some(v => expected.some(e => equal(v, e)));
        if (op === "$gt") return actual.some(v => v > expected);
        if (op === "$lte") return actual.some(v => v <= expected);
        if (op === "$ne") return !actual.some(v => equal(v, expected));
        if (op === "$exists") return actual.some(v => v !== undefined) === expected;
        throw new Error(`Unsupported ${op}`);
      });
    }
    return value === null ? actual.some(v => v == null) : actual.some(v => equal(v, value));
  });
}
function set(doc, path, value) {
  const keys = path.split("."); let target = doc;
  for (const key of keys.slice(0, -1)) target = target[key] ||= {};
  target[keys.at(-1)] = structuredClone(value);
}
function update(doc, operation) {
  for (const [key, value] of Object.entries(operation.$set || {})) set(doc, key, value);
  for (const [key, value] of Object.entries(operation.$inc || {})) set(doc, key, (values(doc, key.split("."))[0] || 0) + value);
  for (const [key, value] of Object.entries(operation.$push || {})) {
    const array = values(doc, key.split("."))[0]; array.push(structuredClone(value));
  }
  for (const key of Object.keys(operation.$unset || {})) delete doc[key];
}
function harness({ count = 1, photos = 0, plan = "vip", feedXml, feedType = "generic_xml", inmowebEnabled = false, inmowebAllowedExternalIds } = {}) {
  const testEnv = { ...env, ...(inmowebEnabled ? { INMOWEB_NEW_ENABLED: "true" } : {}),
    ...(inmowebAllowedExternalIds !== undefined ? { INMOWEB_NEW_ALLOWED_EXTERNAL_IDS: inmowebAllowedExternalIds } : {}) };
  let clock = new Date(), feed = feedXml ?? xml(count, photos), txn;
  const snapshot = buildFeedSnapshot(feed, { feedType });
  const state = { source: { _id: S, usuarioId: U, activo: true, feedType,
    ...encryptFeedUrl("https://feed.example/catalog.xml?token=secret", env) },
    run: { _id: R, usuarioId: U, importSourceId: S, status: "simulated", expiresAt: new Date(+clock + 1200000),
      ...runVersions, snapshotDigest: snapshotDigest(snapshot), snapshotComplete: snapshot.snapshotComplete,
      ...(feedType === "inmoweb" ? { feedType, newSnapshotComplete: receivedNewSnapshotValid(snapshot), providerNormalizationVersion: snapshot.normalizationVersion } : {}),
      ...prepareSyncPlan(snapshot, []) },
    user: { _id: U, plan, planActivo: true, trialAccepted: true, activo: true, publicationVersion: 0 },
    properties: [], reconciliations: [] };
  state.run.sourceIdentityHash = state.source.feedUrlHash;
  const effects = { fetch: 0, acquire: 0, release: 0, uploads: 0, downloads: 0, deletes: 0, writes: [],
    uploadedPublicIds: [], deletedPublicIds: [] };
  const faults = {};
  const current = session => session ? txn : state;
  const query = fn => {
    let session, ceiling = Infinity;
    return { select() { return this; }, lean() { return this; }, session(s) { session = s; return this; },
      limit(n) { ceiling = n; return this; }, then(resolve, reject) { return Promise.resolve().then(() => {
        const result = fn(session); return structuredClone(Array.isArray(result) ? result.slice(0, ceiling) : result);
      }).then(resolve, reject); } };
  };
  const sources = {
    init: async () => {},
    findOne(filter) { return query(session => matches(current(session).source, filter) ? current(session).source : null); },
    async findOneAndUpdate(filter, op) {
      effects.acquire++; if (!matches(state.source, filter)) return null;
      update(state.source, op); return structuredClone(state.source);
    },
    async updateOne(filter, op, options = {}) {
      if (op.$unset) effects.release++;
      const doc = current(options.session).source;
      if (!matches(doc, filter)) return { matchedCount: 0 };
      update(doc, op); return { matchedCount: 1 };
    }
  };
  const users = {
    findOne(filter) { return query(session => matches(current(session).user, filter) ? current(session).user : null); },
    findById(id) { return query(session => String(id) === U ? current(session).user : null); },
    async updateOne(filter, op, options) {
      const doc = current(options.session).user;
      if (!matches(doc, filter)) return { matchedCount: 0 };
      update(doc, op); return { matchedCount: 1 };
    },
    async startSession() { return { async withTransaction(callback) {
      if (faults.beforeTransaction) faults.beforeTransaction(state);
      txn = structuredClone(state);
      try {
        await callback();
        if (faults.retry) { txn = structuredClone(state); await callback(); }
        Object.assign(state, txn);
        if (faults.lostCommit) throw Object.assign(new Error("secret driver"), { hasErrorLabel: label => label === "UnknownTransactionCommitResult" });
      } finally { txn = undefined; }
    }, async endSession() {} }; }
  };
  const properties = {
    startSession: () => users.startSession(),
    async updateOne(filter, op, options) {
      assert.ok(options.session);
      const p = current(options.session).properties.find(p => matches(p, filter));
      if (!p) return { matchedCount: 0, modifiedCount: 0 };
      effects.writes.push({ op, session: true, model: "property" }); update(p, op);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    init: async () => {},
    find(filter) { return query(session => current(session).properties.filter(p => matches(p, filter))); },
    findById(id) {
      if (faults.unconfirmed) return Promise.reject(new Error("secret driver"));
      return query(session => current(session).properties.find(p => String(p._id) === String(id)) || null);
    },
    countDocuments(filter) { return query(session => current(session).properties.filter(p => matches(p, { usuarioId: filter.usuarioId })).length); },
    async create(rows, options) {
      assert.ok(options.session); const data = { ...rows[0], _id: String(rows[0]._id) };
      if (faults.failCreate || faults.unconfirmed) throw new Error("secret driver");
      const currentState = current(options.session);
      if (currentState.properties.some(p => p.externalId === data.externalId)) throw Object.assign(new Error(), { code: 11000 });
      currentState.properties.push(data); return [data];
    }
  };
  const reconciliations = {
    find(filter) { return query(session => current(session).reconciliations.filter(p => matches(p, filter))); },
    init: async () => {},
    findOne: async filter => structuredClone(state.reconciliations.find(p => matches(p, filter)) || null),
    async create(data) { state.reconciliations.push({ ...data, propiedadId: String(data.propiedadId) }); },
    async updateOne(filter, op) { const row = state.reconciliations.find(p => matches(p, filter)); if (row) update(row, op); },
    async deleteOne(filter) { state.reconciliations = state.reconciliations.filter(p => !matches(p, filter)); }
  };
  const runs = {
    async create(data) { state.run = { _id: R, ...structuredClone(data) }; return structuredClone(state.run); },
    findOne(filter) { return query(session => matches(current(session).run, filter) ? current(session).run : null); },
    async updateOne(filter, op, options = {}) {
      if (op.$push) faults.beforeReceipt?.(op.$push["newImport.results"], state, current(options.session));
      if (faults.receipt && op.$push) throw new Error("receipt failure");
      if (faults.receiptExternalId && op.$push?.["newImport.results"]?.externalId === faults.receiptExternalId) throw new Error("receipt failure");
      if (faults.finish && op.$set?.["newImport.status"] === "completed") throw new Error("finish failure");
      const doc = current(options.session).run;
      if (!matches(doc, filter)) return { matchedCount: 0 };
      if (op.$push) { assert.ok(options.session); assert.equal(current(options.session).properties.length > 0, true); }
      effects.writes.push({ op, session: Boolean(options.session) }); update(doc, op); return { matchedCount: 1, modifiedCount: 1 };
    }
  };
  const selected = createSelectedImporter({ PropiedadModel: properties, UsuarioModel: users, ImportSourceModel: sources,
    ReconciliationModel: reconciliations, now: () => new Date(clock), env: testEnv,
    downloadImage: async url => { effects.downloads++; await faults.download?.(state, url); if (faults.photo) throw new Error("private url"); return Buffer.from("test"); },
    uploadImage: async () => {
      effects.uploads++; if (faults.upload) throw new Error("simulated upload failure");
      const publicId = `test-resource-${effects.uploads}`;
      effects.uploadedPublicIds.push(publicId);
      return { url: `https://cloudinary.example/${publicId}.jpg`, publicId };
    },
    deleteImage: async publicId => { effects.deletes++; effects.deletedPublicIds.push(publicId); return { ok: true }; } });
  const dependencies = { PropiedadModel: properties, UsuarioModel: users, ImportSourceModel: sources,
    ImportSyncRunModel: runs, ReconciliationModel: reconciliations, env: testEnv, now: () => new Date(clock), importSelected: selected,
    providerSnapshots: { bind() {}, get: () => buildFeedSnapshot(feed, { feedType }) },
    fetchXml: async (url, { budget }) => { effects.fetch++; await budget.run(() => faults.fetch?.(state)); return { xml: feed }; },
    budgetFactory: () => createImportBudget({ timeoutMs: faults.timeout || MAX_BATCH_MS }) };
  const run = createSyncNewImporter(dependencies);
  return { state, effects, faults, dependencies, run, request: { usuarioId: U, runId: R, externalIds: ["N-0"] },
    feed(value) { feed = value; }, advance(ms) { clock = new Date(+clock + ms); } };
}

const inmowebFixture = fs.readFileSync(new URL("./fixtures/crm/inmoweb-synthetic.xml", import.meta.url), "utf8");
function inmoXml(count = 1, photos = 0) {
  const record = inmowebFixture.match(/<propiedad\b[\s\S]*?<\/propiedad>/)[0];
  return `<properties>${Array.from({ length: count }, (_, i) => record.replace('id="0001"', `id="IW-${i}"`)
    .replace(/<imagenes>[\s\S]*?<\/imagenes>/, `<imagenes>${Array.from({ length: photos }, (_, n) =>
      `<imagen url="https://images.example/${i}/${n}.jpg" principal="${n === 1 ? 1 : 0}"/>`).join("")}</imagenes>`)).join("")}</properties>`;
}
function inmoHarness({ enabled = true, count = 1, photos = 0, feedXml, plan = "vip",
  allowlist = Array.from({ length: count }, (_, i) => `IW-${i}`).join(",") } = {}) {
  const h = harness({ feedXml: feedXml ?? inmoXml(count, photos), feedType: "inmoweb", inmowebEnabled: enabled, plan,
    inmowebAllowedExternalIds: allowlist });
  h.request.externalIds = Array.from({ length: count }, (_, i) => `IW-${i}`);
  return h;
}
test("InmoWeb OFF blocks before lock, fetch, images, receipt or property writes", async () => {
  const h = inmoHarness({ enabled: false, photos: 2 }); const before = structuredClone(h.state);
  await assert.rejects(() => h.run(h.request), { code: "INMOWEB_NEW_DISABLED" });
  assert.deepEqual(h.state, before);
  assert.deepEqual([h.effects.fetch, h.effects.acquire, h.effects.downloads, h.effects.uploads, h.effects.writes.length], [0, 0, 0, 0, 0]);
  const safe = safeRunSummary(h.state.run, new Date(), h.dependencies.env);
  assert.equal(safe.newImportEligible, false); assert.equal(safe.newImportBlockedReason, "INMOWEB_NEW_DISABLED");
  assert.equal(safe.snapshotComplete, false); assert.equal(safe.applyEligible, false);
});
for (const [name, allowlist, count] of [["empty allowlist", "", 1], ["unlisted ID", "OTHER", 1],
  ["wildcard", "*", 1], ["partially authorized batch", "IW-0", 2]]) {
  test(`InmoWeb ${name} denies the entire request before all side effects`, async () => {
    const h = inmoHarness({ allowlist, count, photos: 1 });
    const before = structuredClone(h.state), effects = structuredClone(h.effects);
    await assert.rejects(() => h.run(h.request), { code: "INMOWEB_NEW_EXTERNAL_ID_NOT_ALLOWED", status: 409 });
    assert.deepEqual(h.state, before); assert.deepEqual(h.effects, effects);
  });
}
test("InmoWeb batch with both exact IDs authorized continues through the existing mock pipeline", async () => {
  const h = inmoHarness({ count: 2, allowlist: " , IW-0, , IW-1 , ", photos: 1 });
  const result = await h.run(h.request);
  assert.equal(result.newImport.counts.imported, 2);
  assert.equal(h.effects.acquire, 1); assert.equal(h.effects.downloads, 2);
});
test("InmoWeb completed replay still requires the operational allowlist", async () => {
  const h = inmoHarness();
  await h.run(h.request);
  h.dependencies.env.INMOWEB_NEW_ALLOWED_EXTERNAL_IDS = "OTHER";
  const before = structuredClone(h.state), effects = structuredClone(h.effects);
  await assert.rejects(() => h.run(h.request), { code: "INMOWEB_NEW_EXTERNAL_ID_NOT_ALLOWED" });
  assert.deepEqual(h.state, before); assert.deepEqual(h.effects, effects);
});
test("both NEW gates enabled never enable InmoWeb UPDATE, MISSING, REAPPEARED or enrollment", async () => {
  const h = inmoHarness();
  const safe = safeRunSummary(h.state.run, h.dependencies.now(), h.dependencies.env);
  assert.equal(safe.applyEligible, false); assert.equal(safe.snapshotComplete, false);
  for (const factory of [createSyncApplier, createMissingHider, createReappearedRestorer]) {
    await assert.rejects(() => factory(h.dependencies)(h.request));
  }
  await assert.rejects(() => createSyncEnroller(h.dependencies)({ usuarioId: U, importSourceId: S,
    externalIds: ["IW-0"] }), { code: "SYNC_SOURCE_NOT_CONFIGURED" });
  assert.equal(h.effects.fetch, 0); assert.equal(h.effects.acquire, 0);
  assert.equal(h.effects.downloads, 0); assert.equal(h.effects.uploads, 0); assert.equal(h.effects.writes.length, 0);
});
test("InmoWeb synthetic ON reuses Phase 2, publication fence, one lease and atomic per-property receipt", async () => {
  const feedXml = inmoXml(1, 3).replace('<titulo>Piso sintético</titulo>', `<titulo>${"Texto comercial largo ".repeat(12)}</titulo>`)
    .replace('<estado id="SM"/>', '<estado/>').replace('<dormitorios>2</dormitorios>', '<dormitorios/>')
    .replace('<banos>1</banos>', '<banos/>').replace('<operacion id="1">', '<operacion id="2">');
  const h = inmoHarness({ feedXml }); const urls = []; h.faults.download = (_, url) => urls.push(url);
  const result = await h.run(h.request), p = h.state.properties[0];
  assert.equal(result.newImport.counts.imported, 1); assert.equal(p.externalId, "IW-0");
  assert.equal(p.referencia, "SYNTHETIC-REF-A"); assert.equal(p.importSourceId, S); assert.equal(p.usuarioId, U); assert.equal(p.source, "crm");
  assert.equal(p.precisionUbicacion, "aproximada"); assert.equal(p.direccion, ""); assert.equal(p.ubicacionPublica, "Zona ficticia, Municipio ficticio");
  assert.equal(p.periodicidadPrecio, "desconocida"); assert.equal(p.estado, "no_informado"); assert.equal(p.habitaciones, null);
  assert.equal(p.habitacionesEstado, "desconocido"); assert.equal(p.banos, null); assert.equal(p.moneda, "EUR");
  const persistedModel = new Propiedad(p); await persistedModel.validate();
  assert.equal(persistedModel.banos, null); assert.equal(persistedModel.habitaciones, null); assert.equal(persistedModel.syncEnabled, false);
  assert.equal(p.superficie, 90); assert.equal(p.superficieParcela, 150); assert.equal(p.precio, 210000);
  assert.equal(p.garaje, true); assert.equal(p.piscina, true); assert.equal(p.terraza, true);
  assert.equal(p.titulo, "Piso en alquiler en Zona ficticia, Municipio ficticio");
  assert.equal(urls[0], "https://images.example/0/1.jpg"); assert.equal(p.imagenes.length, 3);
  assert.equal(h.effects.acquire, 1); assert.equal(h.effects.release, 1); assert.equal(h.state.user.publicationVersion, 1);
  assert.equal(h.state.reconciliations.length, 0); assert.equal(h.state.run.newImport.results[0].propertyId, p._id);
  assert.equal(h.state.run.snapshotComplete, false);
  const before = structuredClone(h.effects); assert.equal((await h.run(h.request)).alreadyImported, true); assert.deepEqual(h.effects, before);
});
for (const [name, change] of [
  ["disappeared", xml => xml.replace('id="IW-0"', 'id="OTHER"')],
  ["ineligible", xml => xml.replace('<familia id="24">', '<familia id="999">')],
  ["price changed", xml => xml.replace('>210000</precio>', '>211000</precio>')],
  ["reference changed", xml => xml.replace('SYNTHETIC-REF-A', 'SYNTHETIC-REF-B')],
  ["plot surface changed", xml => xml.replace('<parcela>150</parcela>', '<parcela>151</parcela>')],
  ["public zone changed", xml => xml.replace('Zona ficticia', 'Otra zona ficticia')],
  ["duplicate ID", xml => xml.replace('</properties>', xml.match(/<propiedad\b[\s\S]*?<\/propiedad>/)[0] + '</properties>')]
]) test(`InmoWeb mismatched lease ${name} aborts before images/persistence`, async () => {
  const h = inmoHarness({ photos: 2 }); h.feed(change(inmoXml(1, 2)));
  await assert.rejects(() => h.run(h.request));
  assert.equal(h.effects.downloads, 0); assert.equal(h.effects.uploads, 0); assert.equal(h.state.properties.length, 0);
  assert.equal(h.state.run.newImport, undefined); assert.equal(h.state.source.importLockToken, undefined);
});
test("InmoWeb existing identity is ALREADY_EXISTS, never a second property", async () => {
  const h = inmoHarness({ photos: 2 }); h.state.properties.push({ _id: U, usuarioId: U, importSourceId: S, source: "crm", externalId: "IW-0" });
  const result = await h.run(h.request); assert.equal(result.newImport.counts.imported, 0);
  assert.equal(result.newImport.counts.alreadyExists, 1); assert.equal(h.effects.downloads, 0); assert.equal(h.state.properties.length, 1);
});
for (const mode of ["full", "inactive", "reconciliation"]) test(`InmoWeb shares ${mode} protection without images`, async () => {
  const h = inmoHarness({ plan: mode === "full" ? "gratis" : "vip", photos: 1 });
  if (mode === "full") h.state.properties.push({ usuarioId: U }, { usuarioId: U });
  if (mode === "inactive") h.state.user.planActivo = false;
  if (mode === "reconciliation") h.state.reconciliations.push({ usuarioId: U, importSourceId: S, externalId: "IW-0" });
  await assert.rejects(() => h.run(h.request), { code: mode === "full" ? "SYNC_NEW_PLAN_LIMIT"
    : mode === "inactive" ? "SYNC_NEW_PLAN_REQUIRED" : "SYNC_NEW_RECONCILIATION_PENDING" });
  assert.equal(h.effects.downloads, 0); assert.equal(h.effects.uploads, 0);
});
test("InmoWeb per-plan photo cap is reported, not silently truncated", async () => {
  const limit = getLimiteFotosPlan("gratis"), h = inmoHarness({ plan: "gratis", photos: limit + 2 });
  const result = await h.run(h.request);
  assert.equal(result.newImport.counts.importedImages, limit); assert.equal(result.newImport.counts.skippedImages, 2);
  assert.ok(result.newImport.results[0].imageWarnings > 0);
});
test("InmoWeb retains 10 properties/100 images/120s and rejects excess", async () => {
  const h = inmoHarness({ count: 10, photos: 10 });
  assert.equal((await h.run(h.request)).newImport.counts.imported, 10); assert.equal(h.effects.uploads, 100);
  const many = inmoHarness({ count: 11 }); await assert.rejects(() => many.run(many.request), { code: "SYNC_NEW_SELECTION_INVALID" });
  const photos = inmoHarness({ count: 2, photos: 51 }); await assert.rejects(() => photos.run(photos.request));
  assert.equal(photos.effects.uploads, 0); assert.deepEqual([MAX_BATCH_PROPERTIES, MAX_BATCH_PHOTOS, MAX_BATCH_MS], [10, 100, 120000]);
});
for (const mode of ["photo", "upload", "failCreate", "unconfirmed"]) test(`InmoWeb shared image/persistence failure ${mode}`, async () => {
  const h = inmoHarness({ photos: 2 }); h.faults[mode] = true;
  if (mode === "unconfirmed") {
    await assert.rejects(() => h.run(h.request), { code: "SYNC_NEW_UNCONFIRMED" });
    assert.equal(h.effects.deletes, 0); assert.equal(h.state.reconciliations[0].state, "unknown");
    const calls = h.effects.uploads; await assert.rejects(() => h.run(h.request), { code: "SYNC_NEW_UNCONFIRMED" }); assert.equal(h.effects.uploads, calls);
  } else {
    const result = await h.run(h.request);
    assert.equal(result.newImport.counts.imported, mode === "failCreate" ? 0 : 1);
    if (mode === "failCreate") { assert.equal(h.effects.deletes, 2); assert.equal(h.state.properties.length, 0); }
    else { assert.equal(result.newImport.counts.importedImages, 0); assert.equal(result.newImport.counts.skippedImages, 2); }
    assert.equal(h.state.reconciliations.length, 0);
  }
});
test("InmoWeb image timeout retains the shared budget and unconfirmed receipt", async () => {
  const h = inmoHarness({ photos: 1 }); h.faults.timeout = 10; h.faults.download = () => new Promise(resolve => setTimeout(resolve, 30));
  await assert.rejects(() => h.run(h.request), { code: "SYNC_NEW_UNCONFIRMED" });
  assert.equal(h.state.source.importLockToken, undefined); assert.equal(h.state.properties.length, 0); assert.equal(h.effects.fetch, 0);
});
test("InmoWeb transactional callback retries do not repeat image uploads", async () => {
  const h = inmoHarness({ photos: 2 }); h.faults.retry = true;
  assert.equal((await h.run(h.request)).newImport.counts.imported, 1);
  assert.equal(h.effects.uploads, 2); assert.equal(h.effects.downloads, 2);
  assert.equal(h.state.properties.length, 1); assert.equal(h.state.run.newImport.results.length, 1);
});
test("InmoWeb simulation persists presence evidence but cannot produce MISSING or enable other actions", async () => {
  const h = inmoHarness({ enabled: false }); h.state.properties.push({ usuarioId: U, importSourceId: S, source: "crm", externalId: "ABSENT" });
  const response = await createSyncSimulator(h.dependencies)({ usuarioId: U, importSourceId: S });
  assert.equal(response.status, "simulated"); assert.equal(response.snapshotComplete, false); assert.equal(response.missingCount, 0);
  assert.equal(response.newCount, 1); assert.equal(response.newImportEligible, false); assert.equal(response.applyEligible, false);
  assert.equal(h.state.run.newSnapshotComplete, true); assert.equal(h.state.run.providerNormalizationVersion, 1);
  assert.deepEqual(response, safeRunSummary(h.state.run, h.dependencies.now(), h.dependencies.env));
  await assert.rejects(() => acquireSyncLock({ ...h.dependencies, usuarioId: U, importSourceId: S }), { code: "SYNC_SOURCE_NOT_CONFIGURED" });
  for (const factory of [createSyncApplier, createMissingHider, createReappearedRestorer]) {
    await assert.rejects(() => factory(h.dependencies)(h.request));
  }
  assert.equal(h.effects.downloads, 0); assert.equal(h.effects.uploads, 0); assert.equal(h.effects.writes.filter(w => w.model === "property").length, 0);
});

test("NEW blocked for UPDATE imports through actual Phase 2, one lock and transactional receipt", async () => {
  const h = harness({ photos: 2 });
  assert.equal(h.state.run.plan[0].blocked, true);
  const result = await h.run(h.request);
  assert.equal(result.newImport.counts.imported, 1);
  assert.equal(h.effects.uploads, 2); assert.equal(h.effects.acquire, 1); assert.equal(h.effects.release, 1);
  assert.equal(h.state.properties[0].source, "crm"); assert.equal(h.state.properties[0].importSourceId, S);
  assert.equal(h.state.properties[0].referencia, "");
  assert.equal(h.state.properties[0].syncEnabled, undefined);
  assert.equal(h.state.user.publicationVersion, 1);
  assert.equal(h.state.run.appliedCount, undefined); assert.equal(h.state.run.selectedExternalIds, undefined);
  assert.equal(h.state.reconciliations.length, 0);
  assert.equal(evaluateRunApplyEligibility(h.state.run).applyEligible, false);
  assert.doesNotMatch(JSON.stringify(safeRunSummary(h.state.run)), /secret|catalog.xml|cloudinary.example|Texto/);
});
test("lost HTTP response and completed replay cause no fetch/upload/write, even after expiry", async () => {
  const h = harness({ photos: 1 }); await h.run(h.request);
  const before = structuredClone(h.state), effects = structuredClone(h.effects); h.advance(3600000);
  assert.equal((await h.run(h.request)).alreadyImported, true);
  assert.deepEqual(h.state, before); assert.deepEqual(h.effects, effects);
});
for (const [name, change, code] of [
  ["foreign run", h => h.state.run.usuarioId = S, "SYNC_RUN_NOT_FOUND"],
  ["foreign source", h => h.state.source.usuarioId = S, "SYNC_SOURCE_NOT_FOUND"],
  ["hash", h => h.state.run.sourceIdentityHash = "0".repeat(64), "SYNC_NEW_SOURCE_CHANGED"],
  ["version", h => h.state.run.normalizationVersion = 99, "SYNC_NEW_RUN_CHANGED"],
  ["expired", h => h.advance(1200000), "RUN_EXPIRED"],
  ["truncated", h => h.state.run.planTruncated = true, "RUN_PLAN_TRUNCATED"],
  ["incomplete", h => h.state.run.snapshotComplete = false, "RUN_SNAPSHOT_INCOMPLETE"],
  ["applied", h => h.state.run.status = "applied", "RUN_STATUS_NOT_APPLICABLE"],
  ["UPDATE", h => h.state.run.plan[0].type = "UPDATE", "SYNC_NEW_SELECTION_INVALID"],
  ["missing entry", h => h.state.run.plan = [], "SYNC_NEW_SELECTION_INVALID"],
  ["repeated plan entry", h => h.state.run.plan.push(h.state.run.plan[0]), "SYNC_NEW_SELECTION_INVALID"],
  ["digest changed", h => h.feed(xml(2)), "SYNC_NEW_FEED_CHANGED"],
  ["lock occupied", h => h.state.source.importLockUntil = new Date(Date.now() + 60000), "SYNC_SOURCE_BUSY"],
  ["reconciliation", h => h.state.reconciliations.push({ usuarioId: U, importSourceId: S, externalId: "N-0", state: "unknown" }), "SYNC_NEW_RECONCILIATION_PENDING"],
  ["suspicious identity", h => h.state.properties.push({ usuarioId: U, importSourceId: S, source: "crm", externalId: "OTHER", referencia: "N-0" }), "SYNC_NEW_NOT_NEW"],
  ["user disabled", h => h.state.user.activo = false, "SYNC_NEW_FAILED"]
]) test(`NEW rejects ${name} without image upload`, async () => {
  const h = harness(); change(h);
  await assert.rejects(() => h.run(h.request), e => e.code === code);
  assert.equal(h.effects.uploads, 0);
});
test("mixed NEW/UPDATE selection rejects before feed download", async () => {
  const h = harness({ count: 2 }); h.state.run.plan[1].type = "UPDATE";
  await assert.rejects(() => h.run({ ...h.request, externalIds: ["N-0", "N-1"] }), { code: "SYNC_NEW_SELECTION_INVALID" });
  assert.equal(h.effects.fetch, 0);
});
for (const ids of [[], Array.from({ length: 11 }, (_, i) => `N-${i}`), ["N-0", "N-0"], [""], ["bad?token=secret"], ["absent"]]) {
  test(`NEW invalid selection ${JSON.stringify(ids)}`, async () => {
    const h = harness(); await assert.rejects(() => h.run({ ...h.request, externalIds: ids }), { code: "SYNC_NEW_SELECTION_INVALID" });
    assert.equal(h.effects.fetch, 0);
  });
}
test("already existing CRM identity is not attributed to this run", async () => {
  const h = harness(); h.state.properties.push({ _id: U, usuarioId: U, importSourceId: S, source: "crm", externalId: "N-0" });
  const result = await h.run(h.request);
  assert.equal(result.newImport.results[0].reason, "ALREADY_EXISTS");
  assert.equal(result.newImport.counts.imported, 0); assert.equal(result.newImport.counts.alreadyExists, 1);
  assert.equal(h.effects.uploads, 0);
});
for (const status of ["importing", "indeterminate", "failed", "completed"]) test(`${status} rejects a different frozen selection`, async () => {
  const h = harness(); h.state.run.newImport = { status, selectedExternalIds: ["other"], results: [] };
  await assert.rejects(() => h.run(h.request), { code: "SYNC_NEW_SELECTION_MISMATCH" });
  assert.equal(h.effects.fetch, 0);
});
for (const [status, code] of [["importing", "SYNC_NEW_IN_PROGRESS"], ["indeterminate", "SYNC_NEW_UNCONFIRMED"], ["failed", "SYNC_NEW_ALREADY_ATTEMPTED"]]) {
  test(`${status} is never retried automatically`, async () => {
    const h = harness(); h.state.run.newImport = { status, selectedExternalIds: ["N-0"] };
    await assert.rejects(() => h.run(h.request), { code }); assert.equal(h.effects.fetch, 0);
  });
}
test("plan full uses Phase 2 checks and produces no images", async () => {
  const h = harness({ plan: "gratis" });
  h.state.properties.push({ usuarioId: U }, { usuarioId: U });
  await assert.rejects(() => h.run(h.request), { code: "SYNC_NEW_PLAN_LIMIT" }); assert.equal(h.effects.uploads, 0);
  assert.equal(h.state.run.newImport.status, "failed");
});

test("inactive plan retains a safe code without changing Phase 2 eligibility", async () => {
  const h = harness(); h.state.user.planActivo = false;
  await assert.rejects(() => h.run(h.request), { code: "SYNC_NEW_PLAN_REQUIRED" });
  assert.equal(h.effects.uploads, 0); assert.equal(h.effects.downloads, 0);
  assert.equal(h.state.run.newImport.failureCode, "SYNC_NEW_PLAN_REQUIRED");
});

test("actual Phase 2 quota rejection -> HTTP safe code -> UI message and stored failed run", async () => {
  const old = Usuario.findById, secret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "test"; Usuario.findById = async () => ({ _id: U, activo: true });
  const h = harness({ plan: "gratis" }); h.state.properties.push({ usuarioId: U }, { usuarioId: U });
  const data = safeRunSummary(h.state.run);
  const app = express(), pass = (req, res, next) => next(); app.use(express.json());
  app.use("/api/crm-import", createCrmImportRouter({ ...h.dependencies, importNewSync: h.run,
    newImportRateLimitMiddleware: pass, newImportUserRateLimitMiddleware: pass }));
  const elements = new Map(), calls = [];
  const element = () => ({ children: [], listeners: {}, textContent: "", disabled: false, checked: false,
    classList: { add() {}, remove() {} }, append(value) { this.children.push(value); },
    replaceChildren() { this.children = []; }, setAttribute() {}, addEventListener(k, v) { this.listeners[k] = v; } });
  const all = node => [node, ...node.children.flatMap(all)];
  const context = vm.createContext({ window: {}, Date, confirm: () => true,
    document: { createElement: element, getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); } },
    fetch: async (url, options) => {
      calls.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : undefined });
      const result = url.endsWith("source") ? { status: 200, body: { configured: true, importSourceId: S } }
        : url.endsWith("simulate") ? { status: 200, body: data }
        : await http(app, options.method, url, options.body ? JSON.parse(options.body) : {});
      if (url.endsWith("import-new")) {
        assert.equal(result.body.code, "SYNC_NEW_PLAN_LIMIT");
        assert.doesNotMatch(JSON.stringify(result.body), /stack|feed.example|secret/);
      }
      return { ok: result.status < 300, status: result.status, json: async () => result.body };
    } });
  try {
    vm.runInContext(fs.readFileSync(new URL("../public/js/crm-sync-ui.js", import.meta.url), "utf8"), context);
    context.window.HomeClickCrmSync.iniciar(() => "mock-token"); await new Promise(resolve => setImmediate(resolve));
    await elements.get("crmSyncSimulate").listeners.click();
    const output = elements.get("crmSyncResults"), input = all(output).find(node => node.type === "checkbox");
    input.checked = true; input.listeners.change();
    await all(output).find(node => node.textContent === "Importar nuevos").listeners.click();
    assert.equal(elements.get("crmSyncStatus").textContent, "No hay cupo suficiente en tu plan para importar estos anuncios.");
    assert.equal(h.state.run.newImport.failureCode, "SYNC_NEW_PLAN_LIMIT");
    assert.equal(h.effects.uploads, 0); assert.equal(h.effects.downloads, 0);
    await all(output).find(node => node.textContent === "Consultar estado").listeners.click();
    assert.equal(elements.get("crmSyncStatus").textContent, "No hay cupo suficiente en tu plan para importar estos anuncios.");
    assert.equal(calls.filter(c => c.url.endsWith("import-new")).length, 1);
    assert.deepEqual(calls.find(c => c.url.endsWith("import-new")).body, { runId: R, externalIds: ["N-0"] });
  } finally { Usuario.findById = old; if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret; }
});
test("photo failure retains Phase 2 warnings/counts and allows publication", async () => {
  const h = harness({ photos: 2 }); h.faults.photo = true;
  const result = await h.run(h.request);
  assert.equal(result.newImport.counts.imported, 1); assert.equal(result.newImport.counts.skippedImages, 2);
  assert.equal(result.newImport.results[0].imageWarnings, 2);
});
test("transaction retries never redownload/reupload and receipt appears once", async () => {
  const h = harness({ photos: 1 }); h.faults.retry = true;
  await h.run(h.request);
  assert.equal(h.effects.uploads, 1); assert.equal(h.state.properties.length, 1);
  assert.equal(h.state.run.newImport.results.length, 1); assert.equal(h.state.user.publicationVersion, 1);
});
test("receipt failure rolls back property and cleans images", async () => {
  const h = harness({ photos: 1 }); h.faults.receipt = true;
  const result = await h.run(h.request);
  assert.equal(result.newImport.counts.imported, 0); assert.equal(h.state.properties.length, 0);
  assert.equal(h.effects.deletes, 1); assert.equal(h.state.run.newImport.results[0].reason, "CREATION_FAILED");
});
test("second receipt failure rolls back only its property/resources and keeps first confirmed", async () => {
  const h = harness({ count: 2, photos: 2 });
  let firstReceipt, firstProperty, failureReached = false;
  h.faults.receiptExternalId = "N-1";
  h.faults.beforeReceipt = (receipt, committed, transaction) => {
    if (receipt.externalId !== "N-1") return;
    failureReached = true;
    assert.equal(committed.properties.length, 1);
    assert.equal(transaction.properties.length, 2);
    firstReceipt = structuredClone(committed.run.newImport.results[0]);
    firstProperty = structuredClone(committed.properties[0]);
    assert.equal(firstReceipt.status, "imported");
  };
  const outcome = await h.run({ ...h.request, externalIds: ["N-0", "N-1"] });
  assert.equal(failureReached, true);
  assert.deepEqual(h.state.properties, [firstProperty]);
  assert.deepEqual(h.state.run.newImport.results[0], firstReceipt);
  assert.equal(h.state.run.newImport.results[1].status, "skipped");
  assert.equal(h.state.run.newImport.results[1].reason, "CREATION_FAILED");
  assert.equal(h.state.run.newImport.results[1].propertyId, undefined);
  assert.equal(h.state.run.newImport.status, "completed");
  assert.equal(outcome.newImport.counts.imported, 1); assert.equal(outcome.newImport.counts.skipped, 1);
  assert.equal(h.state.user.publicationVersion, 1);
  assert.equal(h.effects.uploads, 4); assert.equal(h.effects.deletes, 2);
  assert.deepEqual(h.effects.deletedPublicIds, h.effects.uploadedPublicIds.slice(2));
  assert.equal(firstProperty.imagenes.length, 2);
  assert.equal(h.state.reconciliations.length, 0);
  const beforeReplay = structuredClone(h.effects);
  assert.equal((await h.run({ ...h.request, externalIds: ["N-1", "N-0"] })).alreadyImported, true);
  assert.deepEqual(h.effects, beforeReplay);
});

const normalizationFeed = (type, condition) => xml().replace("<propertyType>piso</propertyType>",
  `<propertyType>${type}</propertyType>${condition === undefined ? "" : `<condition>${condition}</condition>`}`);
for (const [type, condition, expectedType, expectedCondition] of [
  ["house", "new", "casa", "obra_nueva"],
  ["apartment", "used", "apartamento", "segunda_mano"],
  ["flat", "second-hand", "piso", "segunda_mano"],
  ["country_house", "resale", "casa_campo", "segunda_mano"],
  ["Casa de campo", "Obra nueva", "casa_campo", "obra_nueva"],
  ["chalet", "Segunda mano", "chalet", "segunda_mano"],
  ["house", undefined, "casa", undefined]
]) test(`NEW snapshot and final property agree: ${type}/${condition ?? "absent"}`, async () => {
  const feedXml = normalizationFeed(type, condition), snapshot = buildSyncSnapshot(feedXml);
  const h = harness({ feedXml });
  await h.run(h.request);
  assert.equal(snapshot.snapshotComplete, true);
  assert.equal(snapshot.properties[0].data.tipoInmueble, expectedType);
  assert.equal(h.state.properties[0].tipoInmueble, expectedType);
  assert.equal(snapshot.properties[0].data.estado, expectedCondition);
  assert.equal(h.state.properties[0].estado, expectedCondition ?? "no_informado");
});
for (const [type, condition] of [["unknown_type", "used"], ["house", "unknown_condition"]]) {
  test(`NEW refuses invalid normalization ${type}/${condition} before resources`, async () => {
    const h = harness({ feedXml: normalizationFeed(type, condition) });
    await assert.rejects(() => h.run(h.request), { code: "RUN_SNAPSHOT_INCOMPLETE" });
    assert.equal(h.effects.fetch, 0); assert.equal(h.effects.uploads, 0);
    assert.equal(h.effects.writes.length, 0); assert.equal(h.state.properties.length, 0);
  });
}
test("unknown commit retains resources and reconciliation and blocks retry", async () => {
  const h = harness({ photos: 1 }); h.faults.unconfirmed = true;
  await assert.rejects(() => h.run(h.request), { code: "SYNC_NEW_UNCONFIRMED" });
  assert.equal(h.state.run.newImport.status, "indeterminate");
  assert.equal(h.state.reconciliations[0].state, "unknown"); assert.equal(h.effects.deletes, 0);
  const uploads = h.effects.uploads;
  await assert.rejects(() => h.run(h.request), { code: "SYNC_NEW_UNCONFIRMED" });
  assert.equal(h.effects.uploads, uploads);
});
test("commit acknowledgement lost but stored property/receipt is confirmed", async () => {
  const h = harness({ photos: 1 }); h.faults.lostCommit = true;
  assert.equal((await h.run(h.request)).newImport.counts.imported, 1);
  assert.equal(h.effects.deletes, 0); assert.equal(h.effects.uploads, 1);
});
test("failed final summary preserves receipt and returns unconfirmed without retry", async () => {
  const h = harness({ photos: 1 }); h.faults.finish = true;
  await assert.rejects(() => h.run(h.request), { code: "SYNC_NEW_UNCONFIRMED", status: 503 });
  assert.equal(h.state.properties.length, 1);
  assert.equal(h.state.run.newImport.results[0].status, "imported");
  assert.equal(h.state.run.newImport.status, "indeterminate");
  const effects = structuredClone(h.effects);
  await assert.rejects(() => h.run(h.request), { code: "SYNC_NEW_UNCONFIRMED" });
  assert.deepEqual(h.effects, effects);
});
test("identity created after initial check is already_exists, never attributed to this run", async () => {
  const h = harness({ photos: 1 });
  h.faults.download = state => state.properties.push({ _id: U, usuarioId: U, importSourceId: S, source: "crm", externalId: "N-0" });
  const result = await h.run(h.request);
  assert.equal(result.newImport.counts.imported, 0);
  assert.equal(result.newImport.results[0].status, "already_exists");
  assert.equal(h.state.properties.length, 1); assert.equal(h.effects.deletes, 1);
});
test("concurrent request cannot reuse an active source lease", async () => {
  const h = harness(); let resume, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  h.faults.fetch = () => { entered(); return new Promise(resolve => { resume = resolve; }); };
  const first = h.run(h.request);
  await waiting;
  await assert.rejects(() => h.run(h.request), { code: "SYNC_SOURCE_BUSY" });
  resume(); await first;
  assert.equal(h.state.properties.length, 1); assert.equal(h.effects.release, 1);
});
test("lost lock before persistence prevents create and cleans confirmed failed resources", async () => {
  const h = harness({ photos: 1 });
  h.faults.download = state => { state.source.importLockToken = "different-owner"; };
  await assert.rejects(() => h.run(h.request));
  assert.equal(h.state.properties.length, 0); assert.equal(h.effects.deletes, 1);
  assert.equal(h.state.source.importLockToken, "different-owner");
});
test("expiry during images rolls back creation and receipt", async () => {
  const h = harness({ photos: 1 }); h.faults.download = () => h.advance(21 * 60000);
  await assert.rejects(() => h.run(h.request)); assert.equal(h.state.properties.length, 0);
});
test("timeout releases own lease and does not start publication", async () => {
  const h = harness(); h.faults.timeout = 10; h.faults.fetch = () => new Promise(resolve => setTimeout(resolve, 30));
  await assert.rejects(() => h.run(h.request), { code: "IMPORT_TIMEOUT" });
  assert.equal(h.state.source.importLockToken, undefined); assert.equal(h.state.properties.length, 0);
});
for (const plan of ["vip", "vip_trial"]) test(`${plan}: 10 properties/100 photos allowed through shared service`, async () => {
  const h = harness({ count: 10, photos: 10, plan });
  const result = await h.run({ ...h.request, externalIds: Array.from({ length: 10 }, (_, i) => `N-${i}`) });
  assert.equal(result.newImport.counts.imported, 10); assert.equal(h.effects.uploads, 100);
});
test("101 photos rejected, technical budgets unchanged", async () => {
  const h = harness({ count: 2, photos: 51 });
  await assert.rejects(() => h.run({ ...h.request, externalIds: ["N-0", "N-1"] }));
  assert.equal(h.effects.uploads, 0);
  assert.deepEqual([MAX_BATCH_PROPERTIES, MAX_BATCH_PHOTOS, MAX_BATCH_MS], [10, 100, 120000]);
});
test("full snapshot mapping retains entries beyond preview cap; truncated runs stay blocked", async () => {
  const h = harness({ count: 501 });
  const { nodes, warnings } = parseGenericPropertyNodes(xml(501), 2001);
  assert.equal(warnings.length, 0);
  const properties = analyzeGenericPropertyNodes(nodes, { maxPhotos: Infinity });
  assert.equal(properties.length, 501); assert.equal(properties[500].externalId, "N-500");
  await assert.rejects(() => h.run(h.request), { code: "RUN_PLAN_TRUNCATED" });
  assert.equal(h.effects.fetch, 0);
});
test("legacy run serializes and new operation summary omits arbitrary text/secrets", () => {
  const h = harness(); assert.equal(safeRunSummary(h.state.run).newImport, undefined);
  h.state.run.newImport = { status: "completed", selectedExternalIds: ["N-0"], results: [
    { externalId: "N-0", status: "imported", warnings: ["secret"], xml: "secret", propertyId: U, errors: ["secret"] }
  ], failureCode: "secret", encryptedFeedUrl: "secret" };
  assert.doesNotMatch(JSON.stringify(safeRunSummary(h.state.run).newImport), /secret|xml|warnings|encrypted/);
  const valid = harness();
  valid.state.run.startedAt = new Date();
  valid.state.run.newImport = { status: "importing", selectedExternalIds: ["N-0"], results: [] };
  assert.equal(new ImportSyncRun(valid.state.run).validateSync(), undefined);
  valid.state.run.newImport.status = "invalid";
  assert.ok(new ImportSyncRun(valid.state.run).validateSync()?.errors["newImport.status"]);
});
function http(app, method, url, body, auth = true) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body), req = Readable.from([payload]);
    Object.assign(req, { method, url, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)),
      ...(auth ? { authorization: `Bearer ${jwt.sign({ id: U }, "test")}` } : {}) }, socket: new PassThrough() });
    req.socket.remoteAddress = "127.0.0.1"; req.connection = req.socket;
    const chunks = [], headers = {}, res = new Writable({ write(c, e, cb) { chunks.push(Buffer.from(c)); cb(); } });
    res.statusCode = 200; res.setHeader = (k, v) => headers[k] = v; res.getHeader = k => headers[k]; res.removeHeader = k => delete headers[k];
    res.end = c => { if (c) chunks.push(Buffer.from(c)); resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); };
    app.handle(req, res, reject);
  });
}
test("HTTP NEW requires auth, strict body and req.user ownership, GET returns receipts", async () => {
  const old = Usuario.findById, secret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "test"; Usuario.findById = async () => ({ _id: U, activo: true });
  const h = harness(), app = express(), pass = (req, res, next) => next(); app.use(express.json());
  app.use("/api/crm-import", createCrmImportRouter({ ...h.dependencies, importNewSync: h.run,
    newImportRateLimitMiddleware: pass, newImportUserRateLimitMiddleware: pass }));
  const url = "/api/crm-import/sync/import-new", body = { runId: R, externalIds: ["N-0"] };
  try {
    assert.equal((await http(app, "POST", url, body, false)).status, 401);
    for (const extra of [{ ownerId: U }, { usuarioId: U }, { sourceId: S }, { feedUrl: "https://feed.example" },
      { precio: 3 }, { fotos: [] }, { fingerprint: "secret" }, { internalContext: {} }]) {
      assert.equal((await http(app, "POST", url, { ...body, ...extra })).status, 400);
    }
    for (const externalIds of [[], ["N-0", "N-0"], [""], Array(11).fill("N"), ["bad?secret"]]) {
      assert.equal((await http(app, "POST", url, { ...body, externalIds })).status, 400);
    }
    assert.equal((await http(app, "POST", url, { ...body, runId: "bad" })).status, 400);
    assert.equal((await http(app, "POST", url, { ...body, runId: S })).status, 404);
    assert.equal((await http(app, "POST", url, body)).status, 200);
    assert.equal((await http(app, "POST", url, body)).body.alreadyImported, true);
    const result = await http(app, "GET", `/api/crm-import/sync/runs/${R}`, {});
    assert.equal(result.body.newImport.status, "completed");
    assert.equal(result.body.newImport.counts.imported, 1);
  } finally { Usuario.findById = old; if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret; }
});
test("HTTP InmoWeb OFF rejects NEW safely, GET preserves pending activation and no work starts", async () => {
  const old = Usuario.findById, secret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "test"; Usuario.findById = async () => ({ _id: U, activo: true });
  const h = inmoHarness({ enabled: false }), app = express(), pass = (req, res, next) => next(); app.use(express.json());
  app.use("/api/crm-import", createCrmImportRouter({ ...h.dependencies, importNewSync: h.run,
    newImportRateLimitMiddleware: pass, newImportUserRateLimitMiddleware: pass }));
  const body = { runId: R, externalIds: ["IW-0"] };
  try {
    const result = await http(app, "POST", "/api/crm-import/sync/import-new", body);
    assert.equal(result.status, 409); assert.equal(result.body.code, "INMOWEB_NEW_DISABLED");
    assert.equal(result.body.error, "Importación InmoWeb preparada. Activación pendiente.");
    assert.doesNotMatch(JSON.stringify(result.body), /feed\.example|secret|encrypted|stack/);
    assert.equal((await http(app, "POST", "/api/crm-import/sync/import-new", { ...body, INMOWEB_NEW_ENABLED: true })).status, 400);
    const read = await http(app, "GET", `/api/crm-import/sync/runs/${R}`, {});
    assert.equal(read.body.newImportEligible, false); assert.equal(read.body.applyEligible, false); assert.equal(read.body.snapshotComplete, false);
    assert.equal(h.effects.acquire, 0); assert.equal(h.effects.fetch, 0); assert.equal(h.effects.writes.length, 0);
  } finally { Usuario.findById = old; if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret; }
});
test("HTTP InmoWeb rejects a partially authorized batch with a safe code and no side effects", async () => {
  const old = Usuario.findById, secret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "test"; Usuario.findById = async () => ({ _id: U, activo: true });
  const h = inmoHarness({ count: 2, allowlist: "IW-0", photos: 1 });
  const before = structuredClone(h.state), effects = structuredClone(h.effects);
  const app = express(), pass = (req, res, next) => next(); app.use(express.json());
  app.use("/api/crm-import", createCrmImportRouter({ ...h.dependencies, importNewSync: h.run,
    newImportRateLimitMiddleware: pass, newImportUserRateLimitMiddleware: pass }));
  try {
    const result = await http(app, "POST", "/api/crm-import/sync/import-new", h.request);
    assert.equal(result.status, 400);
    const denied = await http(app, "POST", "/api/crm-import/sync/import-new", { runId: R, externalIds: ["IW-0", "IW-1"] });
    assert.equal(denied.status, 409);
    assert.deepEqual(denied.body, { code: "INMOWEB_NEW_EXTERNAL_ID_NOT_ALLOWED",
      error: "La selección no está autorizada para la prueba InmoWeb." });
    assert.doesNotMatch(JSON.stringify(denied.body), /IW-0|IW-1|feed\.example|secret|encrypted|stack|ALLOWED_EXTERNAL_IDS/);
    assert.deepEqual(h.state, before); assert.deepEqual(h.effects, effects);
  } finally { Usuario.findById = old; if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret; }
});
test("NEW uses independent user/IP 5 per hour rate limits", () => {
  assert.notEqual(securityRateLimits.crmSyncImportNew, securityRateLimits.crmSyncApply);
  assert.notEqual(securityRateLimits.crmSyncImportNewByUser, securityRateLimits.crmImportByUser);
  for (const middleware of [securityRateLimits.crmSyncImportNew, securityRateLimits.crmSyncImportNewByUser]) {
    assert.equal(middleware.getKey !== undefined, true);
  }
});
test("each NEW rate limiter rejects the sixth attempt with 429", async () => {
  for (const [middleware, key] of [
    [securityRateLimits.crmSyncImportNewByUser, `crm-sync-import-new:user:${U}`],
    [securityRateLimits.crmSyncImportNew, "crm-sync-import-new:127.0.0.1"]
  ]) {
    middleware.resetKey(key);
    const app = express();
    app.use((req, res, next) => { req.user = { id: U }; next(); });
    app.post("/limited", middleware, (req, res) => res.json({ ok: true }));
    try {
      for (let i = 0; i < 5; i++) assert.equal((await http(app, "POST", "/limited", {})).status, 200);
      assert.equal((await http(app, "POST", "/limited", {})).status, 429);
    } finally { middleware.resetKey(key); }
  }
});

for (const failure of ["changed", "blocked"]) test(`NEW fresh validation after cached preview: ${failure} prevents publication`, async () => {
  const h = harness();
  let calls = 0;
  const access = createFeedAccess({ log: () => {}, fetchXml: async () => {
    calls++;
    if (calls === 1) return { xml: xml() };
    if (failure === "blocked") throw Object.assign(new Error("provider denied"), { httpStatus: 403 });
    return { xml: xml().replace("Casa 0", "Changed title") };
  } });
  await access("https://feed.example/catalog.xml?token=secret", { usuarioId: U, fresh: false });
  const run = createSyncNewImporter({ ...h.dependencies, fetchXml: access });
  await assert.rejects(run(h.request), { code: failure === "blocked" ? PROVIDER_BLOCKED : "SYNC_NEW_FEED_CHANGED" });
  assert.equal(calls, 2);
  assert.equal(h.state.properties.length, 0);
  assert.equal(h.effects.uploads, 0);
});

async function realLeaseHarness({ photos = 0, persisted = false } = {}) {
  const h = inmoHarness({ photos });
  const evening = new Date(h.dependencies.now()); evening.setUTCHours(20, 0, 0, 0);
  h.advance(+evening - +h.dependencies.now());
  h.state.run.expiresAt = new Date(+evening + 1_200_000);
  let fetches = 0;
  const now = () => +h.dependencies.now();
  const snapshotDb = providerSnapshotStore();
  const createSnapshotCache = () => createProviderSnapshots({ now, env: h.dependencies.env,
    ...(persisted ? { SnapshotModel: snapshotDb.Model } : {}) });
  const providerSnapshots = createSnapshotCache();
  const fetchXml = createFeedAccess({ now, snapshots: providerSnapshots, log: () => {},
    fetchXml: async () => { fetches++; return { xml: inmoXml(1, photos) }; } });
  const dependencies = { ...h.dependencies, fetchXml, providerSnapshots };
  // Same access call as Analyze, then the actual simulator binds the run.
  const read = await fetchXml("https://feed.example/catalog.xml?token=secret", { usuarioId: U, feedType: "inmoweb", fresh: false });
  const preview = await createSyncSimulator(dependencies)({ usuarioId: U, importSourceId: S });
  return { ...h, dependencies, providerSnapshots, snapshotDb, createSnapshotCache, read, preview,
    run: createSyncNewImporter(dependencies), fetches: () => fetches };
}
test("InmoWeb Analyze -> Simulate -> NEW uses one download and actual transaction pipeline", async () => {
  const h = await realLeaseHarness();
  assert.equal(h.preview.feedFetchedAt, h.read.fetchedAt);
  const result = await h.run(h.request);
  assert.equal(result.newImport.counts.imported, 1);
  assert.equal(h.fetches(), 1); assert.equal(h.state.properties.length, 1);
  assert.equal(h.state.run.snapshotComplete, false);
});
for (const failure of ["expired", "restart", "digest", "identity", "user", "plan", "capacity", "gate", "allowlist"]) {
  test(`InmoWeb real lease ${failure} prevents publication without refetch`, async () => {
    const h = await realLeaseHarness();
    let run = h.run;
    if (failure === "expired") h.advance(300_001);
    if (failure === "restart") run = createSyncNewImporter({ ...h.dependencies, providerSnapshots: createProviderSnapshots() });
    if (failure === "digest") h.state.run.snapshotDigest = "f".repeat(64);
    if (failure === "identity") h.state.source.feedUrlHash = "f".repeat(64);
    if (failure === "user") h.state.user.activo = false;
    if (failure === "plan") h.state.user.planActivo = false;
    if (failure === "capacity") { h.state.user.plan = "gratis"; h.state.properties.push({ usuarioId: U }, { usuarioId: U }); }
    if (failure === "gate") h.dependencies.env.INMOWEB_NEW_ENABLED = "false";
    if (failure === "allowlist") h.dependencies.env.INMOWEB_NEW_ALLOWED_EXTERNAL_IDS = "OTHER";
    await assert.rejects(run(h.request));
    assert.equal(h.state.properties.filter(p => p.externalId === "IW-0").length, 0); assert.equal(h.fetches(), 1);
    assert.equal(h.effects.uploads, 0);
  });
}

for (const change of ["expiry", "user", "plan", "capacity"]) test(`InmoWeb ${change} during images is rechecked before persistence`, async () => {
  const h = await realLeaseHarness({ photos: 1 });
  h.faults.download = () => {
    if (change === "expiry") h.advance(300_001);
    if (change === "user") h.state.user.activo = false;
    if (change === "plan") h.state.user.planActivo = false;
    if (change === "capacity") { h.state.user.plan = "gratis"; h.state.properties.push({ usuarioId: U }, { usuarioId: U }); }
  };
  try { await h.run(h.request); } catch (error) { assert.ok(error.code); }
  assert.equal(h.state.properties.filter(p => p.externalId === "IW-0").length, 0);
  assert.equal(h.fetches(), 1);
  assert.equal(h.effects.uploads, h.effects.deletes);
});


test("persisted InmoWeb snapshot supports NEW after restart with no provider request, and replay stays idempotent", async () => {
  const h = await realLeaseHarness({ persisted: true });
  assert.equal(h.snapshotDb.effects.inserts, 1);
  const run = createSyncNewImporter({ ...h.dependencies, providerSnapshots: h.createSnapshotCache() });
  const result = await run(h.request);
  assert.equal(result.newImport.counts.imported, 1);
  assert.equal(h.state.properties.length, 1); assert.equal(h.fetches(), 1);
  assert.equal(h.snapshotDb.effects.reads, 1);
  assert.equal((await run(h.request)).alreadyImported, true);
  assert.equal(h.snapshotDb.effects.reads, 1); assert.equal(h.fetches(), 1);
});
for (const change of ["expired", "identity", "digest", "version", "gate", "allowlist", "user", "plan", "capacity"]) {
  test(`persisted InmoWeb NEW restart ${change} still blocks without refetch`, async () => {
    const h = await realLeaseHarness({ persisted: true });
    const run = createSyncNewImporter({ ...h.dependencies, providerSnapshots: h.createSnapshotCache() });
    if (change === "expired") h.advance(300_001);
    if (change === "identity") h.state.source.feedUrlHash = "f".repeat(64);
    if (change === "digest") h.state.run.snapshotDigest = "f".repeat(64);
    if (change === "version") h.state.run.providerNormalizationVersion++;
    if (change === "gate") h.dependencies.env.INMOWEB_NEW_ENABLED = "false";
    if (change === "allowlist") h.dependencies.env.INMOWEB_NEW_ALLOWED_EXTERNAL_IDS = "OTHER";
    if (change === "user") h.state.user.activo = false;
    if (change === "plan") h.state.user.planActivo = false;
    if (change === "capacity") { h.state.user.plan = "gratis"; h.state.properties.push({ usuarioId: U }, { usuarioId: U }); }
    await assert.rejects(run(h.request));
    assert.equal(h.state.properties.filter(p => p.externalId === "IW-0").length, 0);
    assert.equal(h.fetches(), 1); assert.equal(h.effects.uploads, 0);
    if (["gate", "allowlist"].includes(change)) assert.equal(h.snapshotDb.effects.reads, 0);
  });
}
test("persisted snapshot expiring during images is rejected inside transaction and uploaded resources cleaned", async () => {
  const h = await realLeaseHarness({ persisted: true, photos: 1 });
  const run = createSyncNewImporter({ ...h.dependencies, providerSnapshots: h.createSnapshotCache() });
  h.faults.download = () => h.advance(300_001);
  try { await run(h.request); } catch (error) { assert.ok(error.code); }
  assert.equal(h.state.properties.length, 0); assert.equal(h.fetches(), 1);
  assert.equal(h.effects.uploads, h.effects.deletes);
  assert.equal(h.snapshotDb.docs.size, 1); // TTL cleanup has not run; application still rejects.
});
test("generic XML NEW retains refetch and never accesses provider snapshot persistence", async () => {
  const h = harness();
  const run = createSyncNewImporter({ ...h.dependencies, providerSnapshots: {
    get() { assert.fail("generic XML must not use leases"); }, bind() { assert.fail("generic XML must not persist leases"); }
  } });
  assert.equal((await run(h.request)).newImport.counts.imported, 1);
  assert.equal(h.effects.fetch, 1);
});
