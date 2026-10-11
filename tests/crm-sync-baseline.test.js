import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import jwt from "jsonwebtoken";
import { Readable, Writable, PassThrough } from "node:stream";
import fs from "node:fs";
import vm from "node:vm";
import Usuario from "../models/Usuario.js";
import Propiedad from "../models/Propiedad.js";
import ImportSyncRun from "../models/ImportSyncRun.js";
import { createCrmImportRouter } from "../routes/crmImport.js";
import { encryptFeedUrl } from "../utils/import/feedUrlCrypto.js";
import { createSyncEnroller } from "../utils/import/syncEnroll.js";
import { createSyncSimulator } from "../utils/import/syncSimulation.js";
import { createSyncSourceManager } from "../utils/import/syncSource.js";
import { managedFingerprint, SYNC_APPLY_V1_FIELDS, validManagedData } from "../utils/import/syncBaseline.js";
import { snapshotDigest, safeRunSummary, evaluateRunApplyEligibility } from "../utils/import/syncPlan.js";
import { buildSyncSnapshot } from "../utils/import/syncSnapshot.js";

const U = "507f1f77bcf86cd799439099", S = "507f1f77bcf86cd799439098", P = "507f1f77bcf86cd799439097";
const env = { CRM_FEED_URL_KEY_V1: crypto.randomBytes(32).toString("base64") };
const url = "https://feeds.example/private-token.xml?token=never-print";
const item = (ref = "REF-1") => `<property><id>${ref}</id><title>Casa</title><price>245000</price><description>Descripcion privada</description><bedrooms>0</bedrooms></property>`;
const feed = (count = 1) => `<properties>${Array.from({ length: count }, (_, i) => item(`REF-${i + 1}`)).join("")}</properties>`;
const property = (extra = {}) => ({ _id: P, usuarioId: U, importSourceId: S, externalId: "REF-1", source: "crm",
  syncEnabled: false, syncOverrides: {}, contentRevision: 3, syncFingerprint: "legacy-full-fingerprint", syncFingerprintVersion: 1,
  titulo: "Casa", precio: 245000, descripcion: "Descripcion privada", habitaciones: 0,
  banos: 0, garaje: false, piscina: false, terraza: false, imagenes: ["https://res.cloudinary.com/example/image"], visitas: 8, contactos: 2, ...extra });
const call = { usuarioId: U, importSourceId: S, externalIds: ["REF-1"] };
function matches(doc, filter) {
  if (!doc) return false;
  return Object.entries(filter).every(([key, value]) => {
    if (key === "$or") return value.some(part => matches(doc, part));
    if (value && typeof value === "object") {
      if ("$in" in value) return value.$in.includes(doc[key]);
      if ("$gt" in value) return doc[key] > value.$gt;
      if ("$lte" in value) return doc[key] <= value.$lte;
      if ("$exists" in value) return (doc[key] !== undefined) === value.$exists;
      if ("$ne" in value) return doc[key] !== value.$ne;
    }
    return value === null ? doc[key] == null : doc[key] === value;
  });
}

function harness({ xml = feed(), fetcher, properties = [property()], beforePropertyWrite = () => {},
  startedAt = new Date("2026-10-10T10:00:00Z") } = {}) {
  let time = new Date(startedAt);
  const store = { source: { _id: S, usuarioId: U, activo: true, feedType: "generic_xml", ...encryptFeedUrl(url, env) },
    properties, runs: [], user: { _id: U, publicationVersion: 7 } };
  const writes = [], reads = [], requests = [];
  let transaction;
  let beforeTransaction = () => {};
  const current = session => session && transaction ? transaction : store;
  function query(fn) {
    let session;
    return { select() { return this; }, lean() { return this; }, limit() { return this; }, session(value) { session = value; return this; },
      then(resolve, reject) { return Promise.resolve().then(() => structuredClone(fn(session))).then(resolve, reject); } };
  }
  const sources = {
    findOne(filter) { reads.push(filter); return query(session => matches(current(session).source, filter) ? current(session).source : null); },
    async findOneAndUpdate(filter, update) {
      writes.push({ model: "source", filter, update });
      if (!matches(store.source, filter)) return null;
      Object.assign(store.source, update.$set);
      return structuredClone(store.source);
    },
    async updateOne(filter, update, options = {}) {
      writes.push({ model: "source", filter, update, options });
      if (!matches(current(options.session).source, filter)) return { matchedCount: 0 };
      Object.assign(current(options.session).source, update.$set || {});
      for (const key of Object.keys(update.$unset || {})) delete current(options.session).source[key];
      return { matchedCount: 1 };
    }
  };
  const props = {
    find(filter) { return query(session => current(session).properties.filter(p => matches(p, filter))); },
    exists(filter) { return query(() => store.properties.some(p => matches(p, filter))); },
    async updateOne(filter, update, options) {
      writes.push({ model: "property", filter, update, options });
      assert.ok(options.session, "enrollment metadata requires transaction");
      assert.deepEqual(Object.keys(update.$set).sort(), ["syncApplyFingerprint", "syncApplyFingerprintVersion", "syncEnabled"]);
      const found = current(options.session).properties.find(p => matches(p, filter));
      if (!found) return { matchedCount: 0 };
      await beforePropertyWrite(found, current(options.session));
      Object.assign(found, update.$set);
      return { matchedCount: 1 };
    },
    async startSession() {
      return { async withTransaction(callback) {
        beforeTransaction();
        transaction = structuredClone(store);
        try { await callback(); Object.assign(store, transaction); } finally { transaction = undefined; }
      }, async endSession() {} };
    }
  };
  const runs = {
    async create(data) { const run = { _id: P, createdAt: new Date(time), ...data }; store.runs.push(run); return structuredClone(run); },
    async updateOne(filter, update) {
      const run = store.runs.find(r => matches(r, filter));
      if (!run) return { matchedCount: 0 };
      Object.assign(run, update.$set);
      for (const key of Object.keys(update.$unset || {})) delete run[key];
      return { matchedCount: 1 };
    },
    findOne(filter) { return query(() => store.runs.find(r => matches(r, filter)) || null); }
  };
  const dependencies = { ImportSourceModel: sources, PropiedadModel: props, ImportSyncRunModel: runs, env, now: () => new Date(time),
    fetchXml: async (...args) => { requests.push(args); return fetcher ? fetcher(...args, store) : { xml }; } };
  return { store, writes, reads, requests, dependencies,
    enroll: createSyncEnroller(dependencies), simulate: createSyncSimulator(dependencies),
    advance(ms) { time = new Date(time.getTime() + ms); }, before(fn) { beforeTransaction = fn; },
    propertyWrites() { return writes.filter(w => w.model === "property"); } };
}

test("managed fields exactly match V1, with deterministic versioned fingerprints", () => {
  assert.deepEqual([...SYNC_APPLY_V1_FIELDS], ["precio", "titulo", "descripcion", "habitaciones", "banos", "superficie", "garaje", "piscina", "terraza"]);
  const data = { precio: 245000, titulo: "Casa", descripcion: "Texto", habitaciones: 0, piscina: false };
  assert.equal(managedFingerprint(data), managedFingerprint(Object.fromEntries(Object.entries(data).reverse())));
  assert.equal(managedFingerprint({ ...data, titulo: " Casa " }), managedFingerprint(data));
  assert.match(managedFingerprint(data), /^[a-f0-9]{64}$/);
});
for (const [field, values] of [["habitaciones", [undefined, null, "", 0]], ["piscina", [undefined, null, "", false]], ["descripcion", [undefined, null, "", "Texto"]]]) {
  test(`fingerprint distinguishes absence/null/empty/zero/false: ${field}`, () => {
    assert.equal(new Set(values.map(value => managedFingerprint({ [field]: value }))).size, 4);
  });
}
test("excluded fields and photos never change managed fingerprint", () => {
  const original = property();
  assert.equal(managedFingerprint(original), managedFingerprint({ ...original, imagenes: [url], localidad: "Rota", tipoOperacion: "alquiler",
    videoUrl: url, visiblePublicamente: false, publicationVersion: 99, estado: "obra_nueva" }));
  assert.equal(validManagedData({ habitaciones: 0, piscina: false, superficie: null, descripcion: null }), true);
  assert.equal(validManagedData({ habitaciones: null }), false);
  assert.equal(validManagedData({ piscina: null }), false);
});

test("enroll compatible CRM property, preserving all visible content/revisions/overrides/full fingerprint", async () => {
  const h = harness(); const before = structuredClone(h.store.properties[0]);
  const result = await h.enroll(call);
  assert.equal(result.enrolled, 1);
  const { syncEnabled, syncApplyFingerprint, syncApplyFingerprintVersion, ...remaining } = h.store.properties[0];
  const { syncEnabled: oldEnabled, ...oldRemaining } = before;
  assert.deepEqual(remaining, oldRemaining);
  assert.equal(syncEnabled, true);
  assert.equal(syncApplyFingerprintVersion, 1);
  assert.equal(syncApplyFingerprint, managedFingerprint(before));
  assert.equal(h.store.source.importLockToken, undefined);
  assert.equal(h.propertyWrites().length, 1);
  assert.ok(h.requests.every(([received]) => received === url));
});

test("second enrollment is idempotent: no property update, save, timestamps or revisions", async () => {
  const h = harness(); await h.enroll(call);
  const before = structuredClone(h.store.properties);
  h.writes.length = 0;
  const result = await h.enroll(call);
  assert.equal(result.alreadyEnrolled, true);
  assert.equal(result.enrolled, 0);
  assert.deepEqual(h.propertyWrites(), []);
  assert.deepEqual(h.store.properties, before);
});

for (const [name, mutate] of [
  ["partial snapshot", h => h.dependencies],
  ["missing externalId", h => h.store.properties[0].externalId = "NOT-IN-FEED"],
  ["different price", h => h.store.properties[0].precio = 240000],
  ["different identity", h => h.store.properties[0].localidad = "Rota"],
  ["foreign property", h => h.store.properties[0].usuarioId = "other"],
  ["manual property", h => h.store.properties[0].source = "manual"],
  ["override", h => h.store.properties[0].syncOverrides.descripcion = true]
]) test(`enroll rejects ${name} without property writes`, async () => {
  const xml = name === "partial snapshot" ? "<properties><property><id>X</id></property><unknown>branch</unknown></properties>"
    : name === "different identity" ? feed().replace("</property>", "<city>Chipiona</city></property>") : feed();
  const h = harness({ xml }); mutate(h);
  const before = structuredClone(h.store.properties);
  await assert.rejects(() => h.enroll(call), { status: 409 });
  assert.equal(h.propertyWrites().length, 0);
  assert.deepEqual(h.store.properties, before);
  assert.equal(h.store.source.importLockToken, undefined);
});

for (const [name, mutate] of [
  ["fingerprint", p => p.syncApplyFingerprint = "0".repeat(64)],
  ["version", p => p.syncApplyFingerprintVersion = 2],
  ["content", p => p.descripcion = "Manual edit"],
  ["override", p => p.syncOverrides.precio = true]
]) test(`already enrolled discrepancy (${name}) is rejected, never repaired`, async () => {
  const h = harness(); await h.enroll(call); mutate(h.store.properties[0]); h.writes.length = 0;
  const before = structuredClone(h.store.properties);
  await assert.rejects(() => h.enroll(call), { code: "SYNC_ENROLL_BASELINE_MISMATCH", status: 409 });
  assert.deepEqual(h.store.properties, before);
  assert.equal(h.propertyWrites().length, 0);
});

test("ten enrollments allowed; eleven rejected before fetch/lock", async () => {
  const properties = Array.from({ length: 10 }, (_, i) => property({ _id: `${i}`.padStart(24, "0"), externalId: `REF-${i + 1}` }));
  const h = harness({ properties, xml: feed(10) });
  assert.equal((await h.enroll({ ...call, externalIds: properties.map(p => p.externalId) })).enrolled, 10);
  const next = harness();
  await assert.rejects(() => next.enroll({ ...call, externalIds: Array.from({ length: 11 }, (_, i) => `REF-${i}`) }), { code: "SYNC_ENROLL_SELECTION_INVALID" });
  assert.equal(next.requests.length, 0); assert.equal(next.writes.length, 0);
});

test("own source required; foreign/missing source never fetches or writes", async () => {
  const h = harness();
  await assert.rejects(() => h.enroll({ ...call, usuarioId: "other" }), { code: "SYNC_SOURCE_NOT_FOUND", status: 404 });
  assert.equal(h.requests.length, 0); assert.equal(h.writes.length, 0);
});

test("live shared lock blocks enroll and simulate", async () => {
  const h = harness(); Object.assign(h.store.source, { importLockToken: "import", importLockUntil: new Date("2026-10-10T11:00:00Z") });
  await assert.rejects(() => h.enroll(call), { code: "SYNC_SOURCE_BUSY" });
  await assert.rejects(() => h.simulate(call), { code: "SYNC_SOURCE_BUSY" });
  assert.equal(h.requests.length, 0); assert.equal(h.propertyWrites().length, 0);
  assert.equal(h.store.source.importLockToken, "import");
});

test("lock lost/expired after fetch prevents enrollment and cannot release somebody else's token", async () => {
  for (const stolen of [true, false]) {
    const h = harness({ fetcher: async (received, settings, store) => {
      if (stolen) store.source.importLockToken = "another-owner";
      else store.source.importLockUntil = new Date(0);
      return { xml: feed() };
    } });
    await assert.rejects(() => h.enroll(call), { code: "SYNC_SOURCE_BUSY" });
    assert.equal(h.propertyWrites().length, 0);
    if (stolen) assert.equal(h.store.source.importLockToken, "another-owner");
  }
});

test("transaction revalidates content before metadata writes", async () => {
  const h = harness();
  h.before(() => { h.store.properties[0].descripcion = "Edited concurrently"; h.store.properties[0].contentRevision++; });
  await assert.rejects(() => h.enroll(call), { code: "SYNC_ENROLL_BASELINE_MISMATCH" });
  assert.equal(h.propertyWrites().length, 0);
  assert.equal(h.store.properties[0].syncEnabled, false);
});

test("simulate holds the same lock against enrollment and source configuration", async () => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const paused = new Promise(resolve => { release = resolve; });
  const h = harness({ fetcher: async () => { entered(); await paused; return { xml: feed() }; } });
  const pending = h.simulate(call); await ready;
  await assert.rejects(() => h.enroll(call), { code: "SYNC_SOURCE_BUSY" });
  const manager = createSyncSourceManager({ ...h.dependencies, validateTarget: async () => {} });
  await assert.rejects(() => manager.configure(U, url), { code: "SYNC_SOURCE_BUSY" });
  release(); await pending;
  assert.equal(h.propertyWrites().length, 0);
  assert.equal(h.store.source.importLockToken, undefined);
});

test("unlinked simulation remains blocked but offers enrollment only with matching content", async () => {
  const h = harness();
  const response = await h.simulate(call);
  assert.equal(response.status, "simulated");
  assert.equal(response.results[0].type, "CONFLICT");
  assert.equal(response.results[0].reason, "PROPERTY_SYNC_DISABLED");
  assert.equal(response.results[0].enrollmentEligible, true);
  assert.equal(response.results[0].blocked, true);
  assert.equal(response.updateCount, 0);
  assert.equal(h.propertyWrites().length, 0);
  h.store.properties[0].precio = 230000;
  assert.equal((await h.simulate(call)).results[0].enrollmentEligible, false);
});

test("prepared UPDATE plan stores only safe names, IDs, versions and preconditions", async () => {
  const h = harness({ xml: feed().replace("245000", "239000") });
  const p = h.store.properties[0]; p.syncEnabled = true; p.syncApplyFingerprint = managedFingerprint(p); p.syncApplyFingerprintVersion = 1;
  const before = structuredClone(h.store.properties);
  const response = await h.simulate(call);
  const run = h.store.runs[0], entry = run.plan[0];
  assert.equal(entry.type, "UPDATE"); assert.equal(entry.blocked, false);
  assert.equal(entry.propiedadId, P); assert.equal(entry.expectedContentRevision, 3);
  assert.equal(entry.expectedBaselineFingerprint, p.syncApplyFingerprint);
  assert.notEqual(entry.proposedBaselineFingerprint, p.syncApplyFingerprint);
  assert.deepEqual(entry.changedFields, ["precio"]);
  assert.equal(run.snapshotVersion, 1); assert.equal(run.normalizationVersion, 1); assert.equal(run.applyFieldsVersion, 1);
  assert.equal(run.sourceIdentityHash, h.store.source.feedUrlHash);
  assert.match(run.snapshotDigest, /^[a-f0-9]{64}$/);
  assert.ok(run.expiresAt > run.createdAt);
  assert.equal(run.errorCode, undefined);
  assert.doesNotMatch(JSON.stringify(run), /Descripcion privada|private-token|never-print|cloudinary|encryptedFeedUrl|239000|245000/);
  assert.doesNotMatch(JSON.stringify(response), /Fingerprint|sourceIdentityHash|snapshotDigest/);
  assert.deepEqual(h.store.properties, before); assert.equal(h.propertyWrites().length, 0);
  assert.equal(safeRunSummary(run, new Date("2026-10-10T11:00:00Z")).expired, true);
});

test("incomplete snapshot produces blocked plan, no eligible update and no MISSING", async () => {
  const h = harness({ xml: feed().replace("245000", "239000").replace("</properties>", "<unknown>branch</unknown></properties>") });
  const p = h.store.properties[0]; p.syncEnabled = true; p.syncApplyFingerprint = managedFingerprint(p); p.syncApplyFingerprintVersion = 1;
  const response = await h.simulate(call);
  assert.equal(response.status, "blocked"); assert.equal(response.snapshotComplete, false);
  assert.equal(response.missingCount, 0); assert.equal(response.results[0].blocked, true);
  assert.equal(h.store.runs[0].plan[0].expectedBaselineFingerprint, undefined);
});

test("override conflict and baseline drift never produce applicable UPDATE", async () => {
  for (const override of [true, false]) {
    const h = harness(); const p = h.store.properties[0];
    p.syncEnabled = true; p.syncApplyFingerprint = managedFingerprint(p); p.syncApplyFingerprintVersion = 1;
    if (override) p.syncOverrides.descripcion = true; else p.precio = 240000;
    const result = (await h.simulate(call)).results[0];
    assert.equal(result.type, "CONFLICT"); assert.equal(result.blocked, true);
  }
});

test("UNCHANGED does not change property timestamps, revisions or metadata", async () => {
  const h = harness(); await h.enroll(call); h.writes.length = 0;
  const before = structuredClone(h.store.properties);
  const result = (await h.simulate(call)).results[0];
  assert.equal(result.type, "UNCHANGED"); assert.equal(result.linked, true);
  assert.deepEqual(h.store.properties, before); assert.deepEqual(h.propertyWrites(), []);
});

test("snapshot digest is stable under order and changes when feed changes", () => {
  const a = buildSyncSnapshot(`<properties>${item("A")}${item("B")}</properties>`);
  const b = buildSyncSnapshot(`<properties>${item("B")}${item("A")}</properties>`);
  assert.equal(snapshotDigest(a), snapshotDigest(b));
  assert.notEqual(snapshotDigest(a), snapshotDigest(buildSyncSnapshot(feed().replace("245000", "239000"))));
});

test("model changes are backward compatible and baseline is distinct from full fingerprint", async () => {
  assert.equal(new Propiedad().syncApplyFingerprint, undefined);
  assert.equal(ImportSyncRun.schema.path("plan").options.select, false);
  for (const status of ["running", "completed", "incomplete", "simulated", "applying", "applied", "blocked", "failed", "aborted"]) {
    const run = new ImportSyncRun({ usuarioId: U, importSourceId: S, status, startedAt: new Date() });
    await run.validate();
  }
});

function httpRequest(app, path, { method = "POST", body, auth = true } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const req = new Readable({ read() { this.push(payload); this.push(null); } });
    Object.assign(req, { method, url: path, originalUrl: path, complete: true,
      headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)),
        ...(auth ? { authorization: `Bearer ${jwt.sign({ id: U }, "baseline-test-secret")}` } : {}) }, socket: new PassThrough() });
    req.socket.remoteAddress = "127.0.0.1"; req.connection = req.socket;
    const chunks = [], headers = {};
    const res = new Writable({ write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    res.statusCode = 200;
    res.setHeader = (key, value) => headers[key.toLowerCase()] = value;
    res.getHeader = key => headers[key.toLowerCase()];
    res.removeHeader = key => delete headers[key.toLowerCase()];
    const end = res.end.bind(res);
    res.end = chunk => { if (chunk) chunks.push(Buffer.from(chunk)); end(); const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, body: text && JSON.parse(text) }); };
    app.handle(req, res, reject);
  });
}
async function withHttp(task, options = {}) {
  const previous = Usuario.findById, secret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "baseline-test-secret";
  Usuario.findById = async () => ({ _id: U, activo: true, plan: "vip" });
  const h = harness(options); const app = express(); app.use(express.json());
  const pass = (req, res, next) => next();
  app.use("/api/crm-import", createCrmImportRouter({ ...h.dependencies, fetchFeedXml: h.dependencies.fetchXml,
    enrollSync: h.enroll, simulateSync: h.simulate, rateLimitMiddleware: pass, userRateLimitMiddleware: pass }));
  try { await task(h, app); }
  finally { Usuario.findById = previous; if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret; }
}

const controlledNewXml = fs.readFileSync(new URL("../public/test-sync-new/homeclick24-sync-new-test.xml", import.meta.url), "utf8");
const newEligibility = data => ({ status: data.status, newImportEligible: data.newImportEligible,
  newImportBlockedReason: data.newImportBlockedReason, results: data.results.map(entry => ({
    externalId: entry.externalId, type: entry.type, importNewEligible: entry.importNewEligible,
    importNewBlockCode: entry.importNewBlockCode })) });

for (const publicable of [true, false]) test(`actual simulate HTTP -> GET -> UI NEW eligibility, publicable=${publicable}`, async () => withHttp(async (h, app) => {
  const elements = new Map(), calls = [];
  const element = () => ({ children: [], listeners: {}, textContent: "", disabled: false,
    classList: { add() {}, remove() {} }, append(value) { this.children.push(value); },
    replaceChildren() { this.children = []; }, setAttribute() {}, addEventListener(k, v) { this.listeners[k] = v; } });
  const all = node => [node, ...node.children.flatMap(all)];
  const clock = new Date(h.store.runs[0]?.startedAt || h.dependencies.now());
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return +clock; }
  }
  let post;
  const context = vm.createContext({ window: {}, Date: Clock,
    document: { createElement: element, getElementById(id) {
      if (!elements.has(id)) elements.set(id, element()); return elements.get(id);
    } }, fetch: async (url, options) => {
      calls.push({ url, method: options.method });
      const result = url.endsWith("/source") ? { status: 200, body: { configured: true, importSourceId: S } }
        : await httpRequest(app, url, { method: options.method, body: options.body ? JSON.parse(options.body) : undefined });
      if (url.endsWith("/simulate")) post = result;
      return { ok: result.status < 300, status: result.status, json: async () => result.body };
    } });
  vm.runInContext(fs.readFileSync(new URL("../public/js/crm-sync-ui.js", import.meta.url), "utf8"), context);
  context.window.HomeClickCrmSync.iniciar(() => "test-token");
  await new Promise(resolve => setImmediate(resolve));
  await elements.get("crmSyncSimulate").listeners.click();
  assert.equal(post.status, 200);
  assert.deepEqual(newEligibility(post.body), { status: "simulated", newImportEligible: true,
    newImportBlockedReason: null, results: [{ externalId: "SYNC-NEW-TEST-001", type: "NEW",
      importNewEligible: publicable, importNewBlockCode: publicable ? null : "SYNC_NEW_INVALID_DATA" }] });
  const nodes = all(elements.get("crmSyncResults"));
  assert.equal(nodes.filter(node => node.type === "checkbox").length, publicable ? 1 : 0);
  if (publicable) assert.ok(nodes.some(node => node.textContent === "Importar nuevos"));
  else assert.match(nodes.map(node => node.textContent).join("\n"), /datos que no permiten publicar/);
  assert.equal(calls.some(call => call.url.includes("/runs/")), false, "UI eligibility needs no GET refresh");
  const get = await httpRequest(app, `/api/crm-import/sync/runs/${post.body.runId}`, { method: "GET" });
  assert.equal(get.status, 200);
  assert.deepEqual(newEligibility(get.body), newEligibility(post.body));
  assert.equal(h.store.runs[0].plan[0].importNewEligible, publicable);
  assert.doesNotMatch(JSON.stringify(post.body), /sourceIdentityHash|snapshotDigest|importSourceId|snapshotVersion|normalizationVersion|applyFieldsVersion|encryptedFeedUrl|never-print/);

  for (const field of ["importSourceId", "sourceIdentityHash", "snapshotVersion", "normalizationVersion", "applyFieldsVersion"]) {
    const incomplete = { ...h.store.runs[0] }; delete incomplete[field];
    const safe = safeRunSummary(incomplete, new Clock());
    assert.equal(safe.newImportEligible, false, field);
    assert.equal(safe.newImportBlockedReason, "SYNC_NEW_RUN_CHANGED", field);
  }
  assert.equal(safeRunSummary(h.store.runs[0], new Date(+clock + 3600000)).newImportBlockedReason, "RUN_EXPIRED");
}, { xml: publicable ? controlledNewXml : controlledNewXml.replace("<bedrooms>2</bedrooms>", ""),
  properties: [], startedAt: new Date() }));

test("enroll HTTP requires auth, strict body, own source and bounded selection", async () => withHttp(async (h, app) => {
  const path = "/api/crm-import/sync/enroll", body = { importSourceId: S, externalIds: ["REF-1"] };
  assert.equal((await httpRequest(app, path, { body, auth: false })).status, 401);
  for (const extra of [{ ownerId: U }, { usuarioId: U }, { feedUrl: url }, { precio: 1 }, { fingerprint: "fake" }]) {
    assert.equal((await httpRequest(app, path, { body: { ...body, ...extra } })).status, 400);
  }
  assert.equal((await httpRequest(app, path, { body: { ...body, importSourceId: P } })).status, 404);
  assert.equal((await httpRequest(app, path, { body: { ...body, externalIds: Array.from({ length: 11 }, (_, i) => `${i}`) } })).status, 400);
  assert.equal((await httpRequest(app, path, { body: { ...body, externalIds: ["REF-1", "REF-1"] } })).status, 400);
  assert.equal((await httpRequest(app, path, { body })).status, 200);
  h.store.properties[0].syncApplyFingerprint = "bad";
  assert.equal((await httpRequest(app, path, { body })).status, 409);
}));

test("GET run is authenticated/owner scoped and returns only safe bounded details", async () => withHttp(async (h, app) => {
  await h.simulate(call);
  const path = `/api/crm-import/sync/runs/${P}`;
  assert.equal((await httpRequest(app, path, { method: "GET", auth: false })).status, 401);
  const own = await httpRequest(app, path, { method: "GET" });
  assert.equal(own.status, 200); assert.equal(own.body.status, "simulated");
  assert.doesNotMatch(JSON.stringify(own.body), /private-token|never-print|encryptedFeedUrl|sourceIdentityHash|snapshotDigest|Descripcion privada/);
  h.store.runs[0].usuarioId = S;
  assert.equal((await httpRequest(app, path, { method: "GET" })).status, 404);
  assert.equal((await httpRequest(app, `${path}?ownerId=${U}`, { method: "GET" })).status, 400);
}));

test("safe run reader sanitizes legacy documents and caps details", () => {
  const run = { _id: P, status: "completed", startedAt: new Date(), secret: url, ciphertext: url,
    warnings: [url], plan: Array.from({ length: 110 }, () => ({ externalId: "REF", type: "CONFLICT", changedFields: ["precio", url], safeReasonCode: url, descripcion: url })) };
  const response = safeRunSummary(run);
  assert.equal(response.results.length, 100); assert.equal(response.expired, true);
  assert.doesNotMatch(JSON.stringify(response), /private-token|never-print/);
});

test("UI shows enrollment only for matching unlinked property, never NEW/MISSING/INVALID/conflicts", () => {
  function element() { return { children: [], textContent: "", listeners: {}, append(value) { this.children.push(value); }, replaceChildren() { this.children = []; }, addEventListener(name, callback) { this.listeners[name] = callback; } }; }
  const context = vm.createContext({ window: {}, document: { createElement: element } });
  vm.runInContext(fs.readFileSync(new URL("../public/js/crm-sync-ui.js", import.meta.url), "utf8"), context);
  const output = element(), chosen = [];
  context.window.HomeClickCrmSync.renderizar({ snapshotComplete: true, results: [
    { externalId: "REF", type: "CONFLICT", reason: "PROPERTY_SYNC_DISABLED", enrollmentEligible: true },
    ...["NEW", "MISSING", "INVALID", "CONFLICT"].map(type => ({ externalId: type, type, blocked: true, enrollmentEligible: false }))
  ] }, output, value => chosen.push(value));
  const rows = output.children[1].children;
  assert.equal(rows[0].children.length, 1); rows[0].children[0].listeners.click();
  assert.deepEqual(chosen, ["REF"]);
  assert.ok(rows.slice(1).every(row => row.children.length === 0));
});

const eligibilityNow = new Date("2026-10-10T10:00:00Z");
const eligibleRun = () => ({ status: "simulated", snapshotComplete: true, planTruncated: false,
  expiresAt: new Date("2026-10-10T10:20:00Z"), totalResults: 0, plan: [] });

test("global eligibility is deterministic and independent of entry-level conflicts", () => {
  const run = eligibleRun();
  run.plan = [{ type: "CONFLICT", blocked: true, safeReasonCode: "MANUAL_OVERRIDE" }];
  assert.deepEqual(evaluateRunApplyEligibility(run, eligibilityNow), {
    expired: false, applyEligible: true, applyBlockedReason: null
  });
  assert.deepEqual(evaluateRunApplyEligibility(run, eligibilityNow), evaluateRunApplyEligibility(run, eligibilityNow));
});

for (const [name, changes, reason] of [
  ["legacy without expiry", { expiresAt: undefined }, "RUN_EXPIRED"],
  ["invalid expiry", { expiresAt: "invalid" }, "RUN_EXPIRED"],
  ["expiry boundary", { expiresAt: eligibilityNow }, "RUN_EXPIRED"],
  ["truncated plan", { planTruncated: true }, "RUN_PLAN_TRUNCATED"],
  ["incomplete snapshot", { snapshotComplete: false }, "RUN_SNAPSHOT_INCOMPLETE"],
  ["failed status", { status: "failed" }, "RUN_STATUS_NOT_APPLICABLE"],
  ["explicit global block", { blocked: true }, "RUN_BLOCKED"],
  ["global error", { errorCode: "arbitrary-sensitive-error" }, "RUN_BLOCKED"],
  ["missing prepared plan", { plan: undefined }, "RUN_BLOCKED"]
]) test(`global eligibility rejects ${name} with a safe reason`, () => {
  const result = evaluateRunApplyEligibility({ ...eligibleRun(), ...changes }, eligibilityNow);
  assert.equal(result.applyEligible, false);
  assert.equal(result.applyBlockedReason, reason);
  assert.equal(result.expired, reason === "RUN_EXPIRED");
  assert.doesNotMatch(JSON.stringify(result), /arbitrary-sensitive-error/);
});

test("global block reasons have stable priority even when several conditions fail", () => {
  const run = { ...eligibleRun(), expiresAt: new Date(0), planTruncated: true,
    snapshotComplete: false, status: "blocked", errorCode: "error" };
  assert.equal(evaluateRunApplyEligibility(run, eligibilityNow).applyBlockedReason, "RUN_EXPIRED");
  run.expiresAt = eligibleRun().expiresAt;
  assert.equal(evaluateRunApplyEligibility(run, eligibilityNow).applyBlockedReason, "RUN_PLAN_TRUNCATED");
  run.planTruncated = false;
  assert.equal(evaluateRunApplyEligibility(run, eligibilityNow).applyBlockedReason, "RUN_SNAPSHOT_INCOMPLETE");
  run.snapshotComplete = true;
  assert.equal(evaluateRunApplyEligibility(run, eligibilityNow).applyBlockedReason, "RUN_STATUS_NOT_APPLICABLE");
  run.status = "simulated";
  assert.equal(evaluateRunApplyEligibility(run, eligibilityNow).applyBlockedReason, "RUN_BLOCKED");
  delete run.errorCode;
  assert.equal(evaluateRunApplyEligibility(run, eligibilityNow).applyEligible, true);
});

test("two enrollments roll back the first baseline when the second write fails", async () => {
  let attempts = 0, firstWasWritten = false;
  const h = harness({ xml: feed(2), properties: [property(), property({ _id: S, externalId: "REF-2" })],
    beforePropertyWrite(found, transaction) {
      assert.equal(found.syncEnabled, false);
      if (++attempts === 2) {
        firstWasWritten = transaction.properties[0].syncEnabled === true &&
          transaction.properties[0].syncApplyFingerprint === managedFingerprint(transaction.properties[0]);
        throw Object.assign(new Error("Controlled second write failure"), { code: "TEST_SECOND_WRITE" });
      }
    } });
  const before = structuredClone({ properties: h.store.properties, user: h.store.user });
  await assert.rejects(() => h.enroll({ ...call, externalIds: ["REF-1", "REF-2"] }), { code: "TEST_SECOND_WRITE" });
  assert.equal(firstWasWritten, true);
  assert.equal(attempts, 2);
  assert.deepEqual(h.store.properties, before.properties);
  assert.deepEqual(h.store.user, before.user);
  assert.ok(h.store.properties.every(p => !p.syncEnabled && p.syncApplyFingerprint === undefined));
  assert.equal(h.store.source.importLockToken, undefined);
});

test("override on excluded direccion blocks enrollment and prepared UPDATE", async () => {
  const h = harness();
  h.store.properties[0].syncOverrides.direccion = true;
  await assert.rejects(() => h.enroll(call), { code: "SYNC_ENROLL_BASELINE_MISMATCH" });
  assert.equal(h.propertyWrites().length, 0);
  const p = h.store.properties[0];
  p.syncEnabled = true; p.syncApplyFingerprint = managedFingerprint(p); p.syncApplyFingerprintVersion = 1;
  const before = structuredClone(p);
  const result = (await h.simulate(call)).results[0];
  assert.equal(result.type, "CONFLICT"); assert.equal(result.blocked, true);
  assert.equal(result.reason, "MANUAL_OVERRIDE");
  assert.deepEqual(h.store.properties[0], before);
});

test("GET invalid ObjectId returns controlled HTTP 400 without an internal error", async () => withHttp(async (h, app) => {
  const result = await httpRequest(app, "/api/crm-import/sync/runs/not-an-object-id", { method: "GET" });
  assert.equal(result.status, 400);
  assert.deepEqual(Object.keys(result.body), ["error"]);
  assert.doesNotMatch(JSON.stringify(result.body), /stack|CastError|Mongo|BSON/i);
}));

test("GET legacy run remains readable but globally expired and ineligible", async () => withHttp(async (h, app) => {
  h.store.runs.push({ _id: P, usuarioId: U, importSourceId: S, status: "completed", startedAt: eligibilityNow });
  const result = await httpRequest(app, `/api/crm-import/sync/runs/${P}`, { method: "GET" });
  assert.equal(result.status, 200);
  assert.equal(result.body.expired, true); assert.equal(result.body.applyEligible, false);
  assert.equal(result.body.applyBlockedReason, "RUN_EXPIRED");
  assert.equal(result.body.expiresAt, null); assert.deepEqual(result.body.results, []);
}));

test("101 UPDATE keeps full counters but blocks the whole stored and HTTP run", async () => withHttp(async (h, app) => {
  h.store.properties = Array.from({ length: 101 }, (_, i) => {
    const p = property({ _id: `${i}`.padStart(24, "0"), externalId: `REF-${i + 1}`, syncEnabled: true,
      syncApplyFingerprintVersion: 1 });
    p.syncApplyFingerprint = managedFingerprint(p);
    return p;
  });
  const simulate = createSyncSimulator({ ...h.dependencies, fetchXml: async () => ({ xml: feed(101).replaceAll("245000", "239000") }) });
  const response = await simulate(call);
  const run = h.store.runs[0];
  assert.equal(run.updateCount, 101); assert.equal(run.totalResults, 101);
  assert.equal(run.plan.length, 100); assert.equal(run.planTruncated, true);
  assert.ok(run.plan.every(entry => entry.blocked === false));
  assert.equal(response.applyEligible, false); assert.equal(response.applyBlockedReason, "RUN_PLAN_TRUNCATED");
  // Use the same logical clock as simulation to test truncation rather than expiry.
  run.expiresAt = new Date(Date.now() + 1200000);
  const result = await httpRequest(app, `/api/crm-import/sync/runs/${P}`, { method: "GET" });
  assert.equal(result.status, 200); assert.equal(result.body.updateCount, 101);
  assert.equal(result.body.results.length, 100); assert.equal(result.body.resultsTruncated, true);
  assert.equal(result.body.planTruncated, true); assert.equal(result.body.applyEligible, false);
  assert.equal(result.body.applyBlockedReason, "RUN_PLAN_TRUNCATED");
  assert.equal(h.propertyWrites().length, 0);
}));

test("price baseline 100 remains stored when feed proposes 120", async () => {
  const h = harness({ xml: feed().replace("245000", "100"), properties: [property({ precio: 100 })] });
  await h.enroll(call);
  const baseline = h.store.properties[0].syncApplyFingerprint;
  const before = structuredClone(h.store.properties);
  h.writes.length = 0;
  const simulate = createSyncSimulator({ ...h.dependencies, fetchXml: async () => ({ xml: feed().replace("245000", "120") }) });
  const result = await simulate(call);
  assert.equal(result.results[0].type, "UPDATE");
  assert.deepEqual(result.results[0].changedFields, ["precio"]);
  assert.equal(h.store.runs[0].plan[0].expectedBaselineFingerprint, baseline);
  assert.equal(h.store.runs[0].plan[0].proposedBaselineFingerprint, managedFingerprint({ ...before[0], precio: 120 }));
  assert.deepEqual(h.store.properties, before); assert.equal(h.propertyWrites().length, 0);
});

test("lease expiry through passage of time during fetch aborts before property writes", async () => {
  let h;
  h = harness({ fetcher: async () => { h.advance(16 * 60 * 1000); return { xml: feed() }; } });
  const before = structuredClone(h.store.properties);
  await assert.rejects(() => h.enroll(call), { code: "SYNC_SOURCE_BUSY" });
  assert.deepEqual(h.store.properties, before); assert.equal(h.propertyWrites().length, 0);
  assert.equal(h.store.source.importLockToken, undefined);
});

test("idempotent enrollment uses no property update/save and preserves existing timestamps", async () => {
  const stamp = new Date("2026-10-01T00:00:00Z");
  const h = harness({ properties: [property({ createdAt: stamp, updatedAt: stamp })] });
  await h.enroll(call);
  const before = structuredClone(h.store.properties[0]); h.writes.length = 0; h.advance(1000);
  assert.equal((await h.enroll(call)).alreadyEnrolled, true);
  assert.deepEqual(h.propertyWrites(), []);
  assert.deepEqual(h.store.properties[0], before);
  assert.equal(h.store.properties[0].updatedAt.getTime(), stamp.getTime());
});

test("UI explains global truncation and expiry without adding any Apply button", () => {
  function element() { return { children: [], textContent: "", append(value) { this.children.push(value); }, replaceChildren() { this.children = []; } }; }
  const context = vm.createContext({ window: {}, document: { createElement: element } });
  vm.runInContext(fs.readFileSync(new URL("../public/js/crm-sync-ui.js", import.meta.url), "utf8"), context);
  for (const [reason, text] of [["RUN_PLAN_TRUNCATED", "Vuelve a simular con un conjunto más pequeño"],
    ["RUN_EXPIRED", "La simulación ha caducado"], [null, "Simulación vigente"]]) {
    const output = element();
    context.window.HomeClickCrmSync.renderizar({ snapshotComplete: true, results: [], applyEligible: reason === null,
      applyBlockedReason: reason }, output);
    assert.ok(output.children.some(child => child.textContent.includes(text)));
    assert.ok(output.children.every(child => !child.listeners));
  }
});
