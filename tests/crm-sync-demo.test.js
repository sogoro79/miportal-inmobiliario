import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { createSyncDemo, demoAllowed, DEMO_V1_URL, DEMO_V2_URL } from "../utils/import/syncDemo.js";
import { encryptFeedUrl } from "../utils/import/feedUrlCrypto.js";
import { buildSyncSnapshot } from "../utils/import/syncSnapshot.js";
import { capturePropertyContent, markManualContentChanges } from "../utils/propertyContent.js";

const USER = "507f1f77bcf86cd799439099";
const SOURCE = "507f1f77bcf86cd799439098";
const v1 = fs.readFileSync(new URL("../public/test-sync/homeclick24-sync-simulation.xml", import.meta.url), "utf8");
const v2 = fs.readFileSync(new URL("../public/test-sync/homeclick24-sync-simulation-v2.xml", import.meta.url), "utf8");
function fixture({ extra = false, retry = false } = {}) {
  const env = { CRM_SYNC_TEST_ENABLED: "true", CRM_SYNC_TEST_USER_ID: USER, CRM_FEED_URL_KEY_VERSION: "1", CRM_FEED_URL_KEY_V1: crypto.randomBytes(32).toString("base64") };
  const source = { _id: SOURCE, usuarioId: USER, activo: true, feedType: "generic_xml", ...encryptFeedUrl(DEMO_V1_URL, env) };
  const rows = buildSyncSnapshot(v1).properties.map(({ data }, index) => ({ ...data, _id: String(index), usuarioId: USER, importSourceId: SOURCE, source: "crm", syncEnabled: false, contentRevision: 0, syncOverrides: {} }));
  if (extra) rows.push({ externalId: "REAL", usuarioId: USER, importSourceId: SOURCE, source: "crm" });
  const fetched = [];
  const updates = [];
  const lockWrites = [];
  const matches = (row, filter) => Object.entries(filter).every(([key, value]) => {
    if (key === "$or") return !row.importLockUntil || row.importLockUntil <= new Date();
    if (value?.$gt) return row[key] > value.$gt;
    if (value?.$ne !== undefined) return row[key] !== value.$ne;
    return row[key] === value;
  });
  function query(value) { return { select() { return this; }, session() { return this; }, limit() { return this; }, lean() { return Promise.resolve(value); }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } }; }
  const ImportSourceModel = {
    findOne: filter => query(matches(source, filter) ? source : null),
    findOneAndUpdate: async (filter, update, options) => { lockWrites.push({ filter, update, options }); if (!matches(source, filter)) return null; Object.assign(source, update.$set); return source; },
    updateOne: async (filter, update, options) => { lockWrites.push({ filter, update, options }); if (matches(source, filter)) for (const key of Object.keys(update.$unset || {})) delete source[key]; }
  };
  const PropiedadModel = {
    find: filter => query(rows.filter(row => matches(row, filter))),
    updateOne: async (filter, update) => { updates.push(update); const row = rows.find(row => matches(row, filter)); if (!row) return { matchedCount: 0 }; Object.assign(row, update.$set); return { matchedCount: 1 }; },
    create: () => assert.fail("no creation"),
    db: { startSession: async () => ({ endSession: async () => {}, withTransaction: async callback => {
      const before = structuredClone(rows);
      try { let result = await callback(); if (retry) { rows.splice(0, rows.length, ...structuredClone(before)); result = await callback(); } return result; }
      catch (error) { rows.splice(0, rows.length, ...before); throw error; }
    } }) }
  };
  const demo = createSyncDemo({ env, ImportSourceModel, PropiedadModel,
    ImportSyncRunModel: { create: async () => ({ _id: "run" }), updateOne: async () => {} },
    fetchXml: async url => { fetched.push(url); return { xml: url === DEMO_V1_URL ? v1 : v2 }; }
  });
  return { demo, rows, source, env, fetched, updates, lockWrites, PropiedadModel, input: { usuarioId: USER, importSourceId: SOURCE } };
}

test("demo desactivada por defecto y restringida a un solo ID explicito", () => {
  assert.equal(demoAllowed(USER, {}), false);
  assert.equal(demoAllowed(USER, { CRM_SYNC_TEST_ENABLED: "true" }), false);
  assert.equal(demoAllowed("other", { CRM_SYNC_TEST_ENABLED: "true", CRM_SYNC_TEST_USER_ID: USER }), false);
});

test("cuenta/fuente ajena o URL distinta no pueden habilitar anuncios", async () => {
  const f = fixture();
  for (const input of [{ ...f.input, usuarioId: "other" }, { ...f.input, importSourceId: "other" }]) await assert.rejects(() => f.demo.enroll(input));
  Object.assign(f.source, encryptFeedUrl("https://feeds.example/real.xml", f.env));
  await assert.rejects(() => f.demo.enroll(f.input));
  assert.equal(f.updates.length, 0);
  assert.equal(f.fetched.length, 0);
});

test("vinculacion solo metadatos de cuatro anuncios, sin activar fuente automatica", async () => {
  const f = fixture();
  const before = structuredClone(f.rows);
  const result = await f.demo.enroll(f.input);
  assert.equal(result.alreadyEnrolled, false);
  assert.equal(f.source.syncEnabled, false);
  assert.equal(f.source.importLockToken, undefined);
  for (const update of f.updates) assert.deepEqual(Object.keys(update.$set).sort(), ["syncEnabled", "syncFingerprint", "syncFingerprintVersion"]);
  f.rows.forEach((row, index) => {
    assert.equal(row.syncEnabled, true);
    assert.equal(row.contentRevision, 0);
    for (const [field, value] of Object.entries(before[index])) if (field !== "syncEnabled") assert.deepEqual(row[field], value);
  });
});

test("otra propiedad o baseline modificado impiden vinculacion sin writes", async () => {
  for (const f of [fixture({ extra: true }), fixture()]) {
    if (f.rows.length === 4) f.rows[0].precio = 1;
    await assert.rejects(() => f.demo.enroll(f.input));
    assert.equal(f.updates.length, 0);
    assert.equal(f.source.importLockToken, undefined);
  }
});

test("segunda vinculacion identica devuelve exito sin persistir propiedades ni timestamps", async () => {
  const f = fixture();
  await f.demo.enroll(f.input);
  f.rows.forEach(row => { row.updatedAt = new Date("2026-01-01T00:00:00Z"); });
  f.source.updatedAt = new Date("2026-01-01T00:00:00Z");
  const before = structuredClone(f.rows);
  const source = structuredClone(f.source);
  const writes = f.updates.length;
  const locks = f.lockWrites.length;
  f.PropiedadModel.updateOne = () => assert.fail("idempotent path must not update properties");
  const result = await f.demo.enroll(f.input);
  assert.equal(result.ok, true);
  assert.equal(result.alreadyEnrolled, true);
  assert.equal(f.updates.length, writes);
  assert.deepEqual(f.rows, before);
  assert.deepEqual(f.source, source);
  assert.deepEqual(f.fetched, [DEMO_V1_URL, DEMO_V1_URL]);
  const coordination = f.lockWrites.slice(locks);
  assert.equal(coordination.length, 2);
  assert.ok(coordination.every(write => write.options.timestamps === false));
  assert.equal(coordination[0].update.$set.importLockToken, coordination[1].filter.importLockToken);
});

for (const [name, change] of [
  ["fingerprint distinto", f => { f.rows[0].syncFingerprint = "mismatch"; }],
  ["override", f => { f.rows[0].syncOverrides.descripcion = true; }],
  ["override no vacio aunque false", f => { f.rows[0].syncOverrides.descripcion = false; }],
  ["contenido editado", f => { f.rows[0].descripcion = "Edicion manual"; }],
  ["version distinta", f => { f.rows[0].syncFingerprintVersion = 2; }],
  ["anuncio faltante", f => { f.rows.pop(); }],
  ["externalId distinto", f => { f.rows[0].externalId = "OTHER"; }],
  ["importSourceId distinto", f => { f.rows[0].importSourceId = "OTHER"; }],
  ["source no CRM", f => { f.rows[0].source = "manual"; }],
  ["syncEnabled mixto", f => { f.rows[0].syncEnabled = false; }],
  ["syncEnabled inconsistente", f => { f.rows[0].syncEnabled = null; }]
]) {
  test(`segunda vinculacion rechaza ${name} sin reparar baseline`, async () => {
    const f = fixture();
    await f.demo.enroll(f.input);
    change(f);
    const before = structuredClone(f.rows);
    const source = structuredClone(f.source);
    const writes = f.updates.length;
    await assert.rejects(() => f.demo.enroll(f.input), { code: "SYNC_TEST_BASELINE_MISMATCH", status: 409 });
    assert.equal(f.updates.length, writes);
    assert.deepEqual(f.rows, before);
    assert.deepEqual(f.source, source);
  });
}

test("segunda vinculacion sigue bloqueada por importacion concurrente", async () => {
  const f = fixture();
  await f.demo.enroll(f.input);
  f.source.importLockToken = "import-active";
  f.source.importLockUntil = new Date(Date.now() + 60000);
  const writes = f.updates.length;
  await assert.rejects(() => f.demo.enroll(f.input), { code: "SYNC_DEMO_REJECTED" });
  assert.equal(f.source.importLockToken, "import-active");
  assert.equal(f.updates.length, writes);
});

test("retry transaccional no repite descarga ni cambia contenido", async () => {
  const f = fixture({ retry: true });
  await f.demo.enroll(f.input);
  assert.deepEqual(f.fetched, [DEMO_V1_URL]);
  assert.ok(f.rows.every(row => row.syncEnabled));
});

test("importacion activa bloquea vinculacion y conserva su lock", async () => {
  const f = fixture();
  f.source.importLockToken = "import-active";
  f.source.importLockUntil = new Date(Date.now() + 60000);
  await assert.rejects(() => f.demo.enroll(f.input));
  assert.equal(f.source.importLockToken, "import-active");
  assert.equal(f.updates.length, 0);
  assert.ok(f.rows.every(row => !row.syncEnabled));
});

test("fallo a mitad de vinculacion revierte los cuatro anuncios y libera lock", async () => {
  const f = fixture();
  const before = structuredClone(f.rows);
  const update = f.PropiedadModel.updateOne;
  let calls = 0;
  f.PropiedadModel.updateOne = async (...args) => {
    if (++calls === 2) throw new Error("mock transaction failure");
    return update(...args);
  };
  await assert.rejects(() => f.demo.enroll(f.input));
  assert.deepEqual(f.rows, before);
  assert.equal(f.source.importLockToken, undefined);
});

test("v2 conserva fuente v1, SSRF fetcher reutilizado y diff exacto sin writes", async () => {
  const f = fixture();
  await f.demo.enroll(f.input);
  const row = f.rows[2];
  const before = capturePropertyContent(row);
  row.descripcion = "Descripcion editada manualmente.";
  markManualContentChanges(row, before);
  assert.deepEqual(row.syncOverrides, { descripcion: true });
  const stored = JSON.stringify(f.rows);
  const source = JSON.stringify(f.source);
  const writes = f.updates.length;
  const result = await f.demo.simulateV2(f.input);
  assert.equal(result.snapshotCount, 4);
  assert.equal(result.snapshotComplete, true);
  for (const key of ["unchangedCount", "updateCount", "conflictCount", "missingCount", "newCount"]) assert.equal(result[key], 1);
  assert.equal(result.errorCount, 0);
  assert.equal(result.totalResults, 5);
  assert.equal(result.results.find(item => item.type === "CONFLICT").changes.descripcion.blockedByOverride, true);
  assert.deepEqual(f.fetched, [DEMO_V1_URL, DEMO_V2_URL]);
  assert.equal(JSON.stringify(f.rows), stored);
  assert.equal(JSON.stringify(f.source), source);
  assert.equal(f.updates.length, writes);
});

test("sin vincular la simulacion sigue respetando PROPERTY_SYNC_DISABLED", async () => {
  const f = fixture();
  const result = await f.demo.simulateV2(f.input);
  assert.equal(result.conflictCount, 3);
  assert.ok(result.results.filter(item => item.type === "CONFLICT").every(item => item.reason === "PROPERTY_SYNC_DISABLED"));
  assert.equal(f.updates.length, 0);
});
