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
import { createCrmImportRouter } from "../routes/crmImport.js";
import { createSyncSimulator } from "../utils/import/syncSimulation.js";
import { createSyncApplier } from "../utils/import/syncApply.js";
import { encryptFeedUrl } from "../utils/import/feedUrlCrypto.js";
import { managedFingerprint } from "../utils/import/syncBaseline.js";
import { buildSyncSnapshot } from "../utils/import/syncSnapshot.js";
import { securityRateLimits } from "../utils/security.js";
import { guardManualPropertyRevision, isPropertyRevisionConflict } from "../utils/propertyRevision.js";
import { capturePropertyContent, markManualContentChanges } from "../utils/propertyContent.js";

const U = "507f1f77bcf86cd799439099", S = "507f1f77bcf86cd799439098", R = "507f1f77bcf86cd799439096";
const env = { CRM_FEED_URL_KEY_V1: crypto.randomBytes(32).toString("base64") };
const xml = (count = 1, price = 120) => `<properties>${Array.from({ length: count }, (_, i) =>
  `<property><id>R-${i}</id><title>Casa</title><description>Texto</description><price>${price}</price><bedrooms>1</bedrooms></property>`).join("")}</properties>`;
function matches(doc, filter) {
  return Boolean(doc) && Object.entries(filter).every(([key, value]) => {
    if (key === "$or") return value.some(part => matches(doc, part));
    if (value && typeof value === "object") {
      if ("$in" in value) return value.$in.includes(doc[key]);
      if ("$gt" in value) return doc[key] > value.$gt;
      if ("$lte" in value) return doc[key] <= value.$lte;
      if ("$ne" in value) return doc[key] !== value.$ne;
      if ("$exists" in value) return (doc[key] !== undefined) === value.$exists;
    }
    return value === null ? doc[key] == null : String(doc[key]) === String(value);
  });
}
function harness(count = 1) {
  let clock = new Date("2026-10-11T10:00:00Z"), transaction, beforeTransaction = () => {}, beforeWrite = () => {};
  let feed = xml(count), pausedFetch, retryCallback = false;
  const state = { source: { _id: S, usuarioId: U, activo: true, feedType: "generic_xml",
    ...encryptFeedUrl("https://feed.example/private.xml", env) },
    properties: Array.from({ length: count }, (_, i) => {
      const p = { _id: `${i}`.padStart(24, "0"), usuarioId: U, importSourceId: S, source: "crm", externalId: `R-${i}`,
        titulo: "Casa", descripcion: "Texto", precio: 100, habitaciones: 1, syncEnabled: true, syncOverrides: {},
        contentRevision: 2, syncApplyFingerprintVersion: 1, direccion: "Direccion original", imagenes: ["portal-image"],
        visitas: 9, syncFingerprint: "full-baseline", updatedAt: new Date("2026-01-01") };
      p.syncApplyFingerprint = managedFingerprint(p); return p;
    }), runs: [], user: { publicationVersion: 8 } };
  const writes = [], fetches = [];
  const current = session => session && transaction ? transaction : state;
  function query(fn) {
    let session;
    return { select() { return this; }, lean() { return this; }, limit() { return this; }, session(s) { session = s; return this; },
      then(resolve, reject) { return Promise.resolve().then(() => structuredClone(fn(session))).then(resolve, reject); } };
  }
  function update(doc, operation) {
    Object.assign(doc, operation.$set || {});
    for (const [key, value] of Object.entries(operation.$inc || {})) doc[key] = (doc[key] || 0) + value;
    for (const key of Object.keys(operation.$unset || {})) delete doc[key];
  }
  const sources = {
    findOne(filter) { return query(session => matches(current(session).source, filter) ? current(session).source : null); },
    async findOneAndUpdate(filter, operation) {
      if (!matches(state.source, filter)) return null;
      update(state.source, operation); return structuredClone(state.source);
    },
    async updateOne(filter, operation, options = {}) {
      const source = current(options.session).source;
      if (!matches(source, filter)) return { matchedCount: 0 };
      update(source, operation); return { matchedCount: 1 };
    }
  };
  const properties = {
    find(filter) { return query(session => current(session).properties.filter(p => matches(p, filter))); },
    async updateOne(filter, operation, options) {
      assert.ok(options.session); assert.equal(options.runValidators, true);
      writes.push({ model: "property", filter, operation });
      const p = current(options.session).properties.find(p => matches(p, filter));
      if (!p) return { matchedCount: 0 };
      beforeWrite(p, current(options.session)); update(p, operation); p.updatedAt = new Date(clock);
      return { matchedCount: 1 };
    },
    async startSession() { return { async withTransaction(callback) {
      beforeTransaction(); transaction = structuredClone(state);
      try {
        await callback();
        if (retryCallback) { transaction = structuredClone(state); await callback(); }
        Object.assign(state, transaction);
      } finally { transaction = undefined; }
    }, async endSession() {} }; }
  };
  const runs = {
    findOne(filter) { return query(session => current(session).runs.find(r => matches(r, filter)) || null); },
    async create(data) { const run = { _id: R, ...data }; state.runs.push(run); return structuredClone(run); },
    async updateOne(filter, operation, options = {}) {
      const run = current(options.session).runs.find(r => matches(r, filter));
      if (!run) return { matchedCount: 0 };
      writes.push({ model: "run", operation }); update(run, operation); return { matchedCount: 1 };
    }
  };
  const dependencies = { PropiedadModel: properties, ImportSourceModel: sources, ImportSyncRunModel: runs,
    ReconciliationModel: { find: async () => [] },
    env, now: () => new Date(clock), fetchXml: async (...args) => {
      fetches.push(args); if (pausedFetch) await pausedFetch(); return { xml: feed };
    } };
  return { state, writes, fetches, dependencies, simulate: createSyncSimulator(dependencies), apply: createSyncApplier(dependencies),
    feed(value) { feed = value; }, advance(ms) { clock = new Date(clock.getTime() + ms); },
    before(fn) { beforeTransaction = fn; }, writeHook(fn) { beforeWrite = fn; }, pause(fn) { pausedFetch = fn; },
    retry() { retryCallback = true; } };
}
const request = { usuarioId: U, runId: R, externalIds: ["R-0"] };
async function ready(count = 1) {
  const h = harness(count); await h.simulate({ usuarioId: U, importSourceId: S }); h.writes.length = 0; h.fetches.length = 0;
  return h;
}

test("apply updates only changed V1 fields and metadata, atomically with the run", async () => {
  const h = await ready(); const before = structuredClone(h.state);
  const result = await h.apply(request);
  assert.equal(result.appliedCount, 1); assert.equal(h.state.runs[0].status, "applied");
  const p = h.state.properties[0]; assert.equal(p.precio, 120); assert.equal(p.contentRevision, 3);
  assert.equal(p.syncApplyFingerprint, managedFingerprint(p));
  assert.deepEqual(p.syncOverrides, {}); assert.deepEqual(h.state.user, before.user);
  for (const field of ["imagenes", "direccion", "titulo", "habitaciones", "syncFingerprint", "visitas"]) assert.deepEqual(p[field], before.properties[0][field]);
  assert.deepEqual(Object.keys(h.writes.find(w => w.model === "property").operation.$set).sort(),
    ["lastSeenAt", "lastSyncedAt", "precio", "syncApplyFingerprint", "syncApplyFingerprintVersion"].sort());
  assert.equal(h.fetches.length, 1);
  assert.doesNotMatch(JSON.stringify(h.state.runs), /Texto|portal-image|private.xml/);
});

test("applied run is idempotent without fetch, property writes, revisions or timestamps", async () => {
  const h = await ready(); await h.apply(request); const before = structuredClone(h.state.properties);
  h.writes.length = 0; h.fetches.length = 0; h.advance(3600000);
  assert.equal((await h.apply(request)).alreadyApplied, true);
  assert.equal(h.writes.length, 0); assert.equal(h.fetches.length, 0); assert.deepEqual(h.state.properties, before);
  await assert.rejects(() => h.apply({ ...request, externalIds: ["other"] }), { code: "SYNC_APPLY_SELECTION_MISMATCH" });
});

for (const [name, change, code] of [
  ["foreign run", h => h.state.runs[0].usuarioId = S, "SYNC_RUN_NOT_FOUND"],
  ["foreign source", h => h.state.source.usuarioId = S, "SYNC_SOURCE_NOT_FOUND"],
  ["expired", h => h.advance(1200000), "RUN_EXPIRED"],
  ["truncated", h => h.state.runs[0].planTruncated = true, "RUN_PLAN_TRUNCATED"],
  ["incomplete", h => h.state.runs[0].snapshotComplete = false, "RUN_SNAPSHOT_INCOMPLETE"],
  ["global blocked", h => h.state.runs[0].errorCode = "blocked", "RUN_BLOCKED"],
  ["applying", h => h.state.runs[0].status = "applying", "RUN_STATUS_NOT_APPLICABLE"],
  ["failed", h => h.state.runs[0].status = "failed", "RUN_STATUS_NOT_APPLICABLE"],
  ["identity changed", h => h.state.source.feedUrlHash = "new", "SYNC_APPLY_SOURCE_CHANGED"],
  ["feed changed", h => h.feed(xml(1, 130)), "SYNC_APPLY_FEED_CHANGED"],
  ["incomplete new feed", h => h.feed("<properties/>"), "RUN_SNAPSHOT_INCOMPLETE"],
  ["proposed altered", h => h.state.runs[0].plan[0].proposedBaselineFingerprint = "0".repeat(64), "SYNC_APPLY_PROPERTY_CHANGED"],
  ["revision changed", h => h.state.properties[0].contentRevision++, "SYNC_APPLY_PROPERTY_CHANGED"],
  ["baseline changed", h => h.state.properties[0].syncApplyFingerprint = "0".repeat(64), "SYNC_APPLY_PROPERTY_CHANGED"],
  ["override", h => h.state.properties[0].syncOverrides.precio = true, "SYNC_APPLY_PROPERTY_CHANGED"],
  ["excluded override", h => h.state.properties[0].syncOverrides.direccion = true, "SYNC_APPLY_PROPERTY_CHANGED"],
  ["deleted", h => h.state.properties = [], "SYNC_APPLY_PROPERTY_CHANGED"],
  ["disabled", h => h.state.properties[0].syncEnabled = false, "SYNC_APPLY_PROPERTY_CHANGED"],
  ["property source changed", h => h.state.properties[0].importSourceId = U, "SYNC_APPLY_PROPERTY_CHANGED"],
  ["fields altered", h => h.state.runs[0].plan[0].changedFields = ["titulo"], "SYNC_APPLY_PROPERTY_CHANGED"]
]) test(`apply rejects ${name} without writing properties`, async () => {
  const h = await ready(); change(h); const before = structuredClone(h.state.properties);
  await assert.rejects(() => h.apply(request), { code });
  assert.deepEqual(h.state.properties, before); assert.equal(h.writes.filter(w => w.model === "property").length, 0);
});

for (const type of ["NEW", "MISSING", "CONFLICT", "INVALID", "UNCHANGED"]) test(`selection rejects ${type}`, async () => {
  const h = await ready(); h.state.runs[0].plan[0].type = type;
  await assert.rejects(() => h.apply(request), { code: "SYNC_APPLY_SELECTION_INVALID" });
});
for (const ids of [[], Array.from({ length: 11 }, (_, i) => `R-${i}`), ["R-0", "R-0"], ["outside"]]) {
  test(`selection rejects ${JSON.stringify(ids)}`, async () => {
    const h = await ready(); await assert.rejects(() => h.apply({ ...request, externalIds: ids }), { code: "SYNC_APPLY_SELECTION_INVALID" });
    assert.equal(h.fetches.length, 0);
  });
}

test("manual edit between preflight and transaction is revalidated", async () => {
  const h = await ready(); h.before(() => { h.state.properties[0].contentRevision++; });
  await assert.rejects(() => h.apply(request), { code: "SYNC_APPLY_PROPERTY_CHANGED" });
  assert.equal(h.state.properties[0].precio, 100); assert.equal(h.state.runs[0].status, "simulated");
});

test("two-property apply rolls back the first update, fingerprints, revisions and claim", async () => {
  const h = await ready(2); const before = structuredClone(h.state.properties); let attempts = 0;
  h.writeHook((p, transaction) => {
    if (++attempts === 2) {
      assert.equal(transaction.properties[0].precio, 120); assert.equal(transaction.runs[0].status, "applying");
      throw new Error("controlled");
    }
  });
  await assert.rejects(() => h.apply({ ...request, externalIds: ["R-0", "R-1"] }));
  assert.deepEqual(h.state.properties, before); assert.equal(h.state.runs[0].status, "simulated");
  assert.equal(h.state.runs[0].appliedAt, undefined); assert.equal(h.state.source.importLockToken, undefined);
});

test("concurrent apply uses the shared source lock and the second cannot write", async () => {
  const h = await ready(); let release, entered;
  const waiting = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  h.pause(async () => { entered(); await waiting; });
  const first = h.apply(request); await started;
  await assert.rejects(() => h.apply(request), { code: "SYNC_SOURCE_BUSY" });
  release(); await first; assert.equal(h.state.properties[0].contentRevision, 3);
});

test("lease or run expiry during fetch prevents all writes", async () => {
  for (const ms of [16 * 60000, 21 * 60000]) {
    const h = await ready(); h.pause(async () => { h.advance(ms); });
    await assert.rejects(() => h.apply(request)); assert.equal(h.state.properties[0].precio, 100);
  }
});

test("ten UPDATE entries apply together within the selection limit", async () => {
  const h = await ready(10);
  const result = await h.apply({ ...request, externalIds: h.state.properties.map(p => p.externalId) });
  assert.equal(result.appliedCount, 10);
  assert.ok(h.state.properties.every(p => p.precio === 120 && p.contentRevision === 3));
});

test("transaction callback retry does not redownload or increment revisions twice", async () => {
  const h = await ready(); h.retry();
  await h.apply(request);
  assert.equal(h.fetches.length, 1);
  assert.equal(h.state.properties[0].contentRevision, 3);
  assert.equal(h.state.runs[0].appliedCount, 1);
});

test("expiry or lost lease after a property write rolls back the whole transaction", async () => {
  for (const loseToken of [false, true]) {
    const h = await ready(); const before = structuredClone(h.state.properties);
    h.writeHook((p, transaction) => {
      if (loseToken) transaction.source.importLockToken = "different-owner";
      else h.advance(21 * 60000);
    });
    await assert.rejects(() => h.apply(request));
    assert.deepEqual(h.state.properties, before);
    assert.equal(h.state.runs[0].status, "simulated");
  }
});

test("scalar nil surface does not conceal an unknown nested XML branch", () => {
  const valid = xml().replace("</property>", '<surface xsi:nil="true"/></property>');
  assert.equal(buildSyncSnapshot(valid).snapshotComplete, true);
  const nested = xml().replace("</property>", '<surface xsi:nil="true"><unknown><id>other</id></unknown></surface></property>');
  assert.equal(buildSyncSnapshot(nested).snapshotComplete, false);
});

test("apply has distinct authenticated-user and IP rate-limit middleware", () => {
  const router = createCrmImportRouter();
  const apply = router.stack.find(layer => layer.route?.path === "/sync/apply").route.stack.map(layer => layer.handle);
  assert.ok(apply.includes(securityRateLimits.crmSyncApply));
  assert.ok(apply.includes(securityRateLimits.crmSyncApplyByUser));
  assert.ok(!apply.includes(securityRateLimits.crmImportAnalyze));
  assert.ok(!apply.includes(securityRateLimits.crmImportAnalyzeByUser));
  const security = fs.readFileSync(new URL("../utils/security.js", import.meta.url), "utf8");
  assert.match(security, /crmSyncApply:.*max: 5/);
  assert.match(security, /crmSyncApplyByUser:.*max: 5/);
});

test("V1 writes zero, false, empty description and nullable surface without excluded fields", async () => {
  const h = harness(); Object.assign(h.state.properties[0], { garaje: true, superficie: 60 });
  h.state.properties[0].syncApplyFingerprint = managedFingerprint(h.state.properties[0]);
  const feed = xml().replace("<title>Casa</title>", "<title>Nueva casa</title>").replace("<description>Texto</description>", "<description/>")
    .replace("<bedrooms>1</bedrooms>", "<bedrooms>0</bedrooms><garage>false</garage><surface xsi:nil=\"true\"/>");
  h.feed(feed); await h.simulate({ usuarioId: U, importSourceId: S }); await h.apply(request);
  const p = h.state.properties[0]; assert.equal(p.titulo, "Nueva casa"); assert.equal(p.descripcion, "");
  assert.equal(p.habitaciones, 0); assert.equal(p.garaje, false); assert.equal(p.superficie, null);
  assert.equal(p.contentRevision, 3); assert.equal(p.syncApplyFingerprint, managedFingerprint(p));
});

test("apply has no Cloudinary imports/calls or property insertion/deletion", () => {
  const code = fs.readFileSync(new URL("../utils/import/syncApply.js", import.meta.url), "utf8");
  assert.doesNotMatch(code, /cloudinary|uploadBuffer|destroyByPublicId|PropiedadModel\.(create|delete|insert)/i);
});

function http(app, body, auth = true) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body), req = new Readable({ read() { this.push(payload); this.push(null); } });
    Object.assign(req, { method: "POST", url: "/api/crm-import/sync/apply", headers: { "content-type": "application/json",
      "content-length": String(Buffer.byteLength(payload)), ...(auth ? { authorization: `Bearer ${jwt.sign({ id: U }, "test")}` } : {}) }, socket: new PassThrough() });
    req.socket.remoteAddress = "127.0.0.1"; req.connection = req.socket;
    const chunks = [], headers = {}, res = new Writable({ write(c, e, cb) { chunks.push(Buffer.from(c)); cb(); } });
    res.statusCode = 200; res.setHeader = (k, v) => headers[k] = v; res.getHeader = k => headers[k]; res.removeHeader = k => delete headers[k];
    res.end = c => { if (c) chunks.push(Buffer.from(c)); resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); };
    app.handle(req, res, reject);
  });
}
test("HTTP apply authenticates, strictly validates body and uses only req.user.id", async () => {
  const old = Usuario.findById, secret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "test"; Usuario.findById = async () => ({ _id: U, activo: true });
  const h = await ready(), app = express(), pass = (req, res, next) => next(); app.use(express.json());
  app.use("/api/crm-import", createCrmImportRouter({ ...h.dependencies, applySync: h.apply,
    applyRateLimitMiddleware: pass, applyUserRateLimitMiddleware: pass }));
  try {
    const body = { runId: R, externalIds: ["R-0"] };
    assert.equal((await http(app, body, false)).status, 401);
    for (const extra of [{ ownerId: U }, { usuarioId: U }, { precio: 7 }, { feedUrl: "https://example.com" }, { fingerprint: "x" }]) {
      assert.equal((await http(app, { ...body, ...extra })).status, 400);
    }
    assert.equal((await http(app, { ...body, runId: "invalid" })).status, 400);
    assert.equal((await http(app, { ...body, runId: S })).status, 404);
    assert.equal((await http(app, body)).status, 200);
    assert.equal((await http(app, body)).body.alreadyApplied, true);
  } finally { Usuario.findById = old; if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret; }
});

test("manual revision guard accepts current/legacy revision and rejects stale or invalid", () => {
  const p = { contentRevision: 3 }; guardManualPropertyRevision(p, "3"); assert.deepEqual(p.$where, { contentRevision: 3 });
  assert.throws(() => guardManualPropertyRevision(p, 2), { status: 409 });
  assert.throws(() => guardManualPropertyRevision(p, ""), { status: 400 });
  const legacy = {}; guardManualPropertyRevision(legacy); assert.ok(legacy.$where.$or);
});

test("Mongoose manual save uses revision CAS; a second stale document cannot overwrite", async () => {
  const original = Propiedad.collection.updateOne;
  let revision = 2, savedDescription = "old", calls = 0;
  Propiedad.collection.updateOne = async (filter, update) => {
    calls++; assert.equal(filter.contentRevision, 2);
    if (revision !== filter.contentRevision) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
    savedDescription = update.$set.descripcion; revision += update.$inc.contentRevision;
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  };
  try {
    const load = () => Propiedad.hydrate({ _id: R, usuarioId: U, titulo: "Casa", descripcion: "old", source: "crm",
      syncEnabled: true, contentRevision: 2, syncOverrides: {}, precio: 100, habitaciones: 0, direccion: "Calle", tipoOperacion: "venta" });
    const first = load(), stale = load();
    for (const [p, description] of [[first, "new"], [stale, "stale"]]) {
      guardManualPropertyRevision(p, 2); const before = capturePropertyContent(p); p.descripcion = description; markManualContentChanges(p, before);
    }
    await first.save({ validateBeforeSave: false });
    await assert.rejects(() => stale.save({ validateBeforeSave: false }), error => isPropertyRevisionConflict(error));
    assert.equal(calls, 2); assert.equal(revision, 3); assert.equal(savedDescription, "new");
    assert.equal(first.syncOverrides.descripcion, true);
  } finally { Propiedad.collection.updateOne = original; }
});

test("UI only offers apply for eligible UPDATE, selects IDs and no content", () => {
  const element = () => ({ children: [], listeners: {}, textContent: "", append(v) { this.children.push(v); }, replaceChildren() { this.children = []; },
    setAttribute() {}, addEventListener(k, fn) { this.listeners[k] = fn; } });
  const context = vm.createContext({ window: {}, document: { createElement: element }, Date });
  vm.runInContext(fs.readFileSync(new URL("../public/js/crm-sync-ui.js", import.meta.url), "utf8"), context);
  const out = element(), selected = [];
  const data = { status: "simulated", applyEligible: true, expired: false, snapshotComplete: true, expiresAt: new Date(Date.now() + 10000).toISOString(),
    results: [{ externalId: "R-0", type: "UPDATE", blocked: false }, ...["UNCHANGED", "NEW", "MISSING", "CONFLICT", "INVALID"].map(type => ({ externalId: type, type, blocked: false }))] };
  context.window.HomeClickCrmSync.renderizar(data, out, null, ids => selected.push(...ids));
  const list = out.children.find(e => e.children.length === 6), checkbox = list.children[0].children[0];
  assert.ok(list.children.slice(1).every(e => e.children.length === 0));
  checkbox.checked = true; checkbox.listeners.change();
  out.children.find(e => e.textContent === "Aplicar cambios").listeners.click(); assert.deepEqual(selected, ["R-0"]);
  for (const changes of [{ applyEligible: false }, { status: "applied" }, { expired: true }]) {
    context.window.HomeClickCrmSync.renderizar({ ...data, ...changes }, out, null, () => {});
    assert.ok(out.children.every(e => e.textContent !== "Aplicar cambios"));
  }
});
