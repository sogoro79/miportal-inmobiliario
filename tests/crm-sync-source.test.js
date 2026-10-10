import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";
import { createSyncSourceManager, safeSourceStatus } from "../utils/import/syncSource.js";
import { decryptFeedUrl, encryptFeedUrl } from "../utils/import/feedUrlCrypto.js";
import { assertPublicFeedTarget } from "../utils/import/feedSecurity.js";

const env = { CRM_FEED_URL_KEY_VERSION: "1", CRM_FEED_URL_KEY_V1: crypto.randomBytes(32).toString("base64") };
const feedUrl = "https://feeds.example/private-token.xml?token=secret-test";
const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
function harness(initial, options = {}) {
  let source = initial;
  const writes = [];
  const associations = [];
  const properties = [];
  function matches(filter) {
    if (!source) return false;
    if (filter.usuarioId && source.usuarioId !== filter.usuarioId) return false;
    if (filter._id && source._id !== filter._id) return false;
    if (filter.feedUrlHash && source.feedUrlHash !== filter.feedUrlHash) return false;
    if (filter.importLockToken && source.importLockToken !== filter.importLockToken) return false;
    if (filter.$or && source.importLockUntil > new Date()) return false;
    if (filter.importLockUntil?.$gt && !(source.importLockUntil > filter.importLockUntil.$gt)) return false;
    return true;
  }
  const ImportSourceModel = {
    findOne: async filter => source?.usuarioId === filter.usuarioId ? source : null,
    findOneAndUpdate: async (filter, update, settings = {}) => {
      writes.push({ filter, update, settings });
      if (!matches(filter)) {
        if (!settings.upsert) return null;
        if (source) throw Object.assign(new Error("duplicate"), { code: 11000 });
        source = { _id: "source-id", ...update.$setOnInsert };
      }
      Object.assign(source, update.$set);
      return structuredClone(source);
    },
    updateOne: async (filter, update) => {
      if (matches(filter)) for (const key of Object.keys(update.$unset || {})) delete source[key];
    }
  };
  const manager = createSyncSourceManager({ env, validateTarget: async url => {
    await assertPublicFeedTarget(url, { lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
  }, ImportSourceModel, PropiedadModel: { exists: async filter => {
    associations.push(filter);
    return properties.some(item => Object.entries(filter).every(([key, value]) => item[key] === value));
  } }, ...options });
  return { manager, writes, associations, properties, ImportSourceModel, get source() { return source; } };
}

const legacy = () => ({ _id: "existing", usuarioId: "owner", feedType: "generic_xml", ...encryptFeedUrl(feedUrl, env) });
const associated = () => ({ usuarioId: "owner", importSourceId: "existing", source: "crm", externalId: "LEGACY" });

test("misma URL con propiedades legacy permite cifrar conservando identidad", async () => {
  const initial = legacy();
  delete initial.encryptedFeedUrl;
  delete initial.feedUrlKeyVersion;
  const h = harness(initial);
  h.properties.push(associated());
  const before = structuredClone(h.source);
  const status = await h.manager.configure("owner", feedUrl);
  assert.equal(status.configured, true);
  assert.equal(status.importSourceId, before._id);
  assert.equal(h.source.feedUrlHash, before.feedUrlHash);
  assert.equal(h.source.syncEnabled, false);
  assert.ok(h.source.encryptedFeedUrl);
  assert.equal(h.source.feedUrlKeyVersion, "1");
  assert.equal(decryptFeedUrl(h.source, env), feedUrl);
  assert.equal(h.source.importLockToken, undefined);
  assert.deepEqual(h.properties, [associated()]);
});

test("URL distinta con propiedades rechaza sin cambiar ningun campo protegido", async () => {
  const h = harness({ ...legacy(), syncEnabled: true });
  h.properties.push(associated());
  const before = structuredClone(h.source);
  await assert.rejects(() => h.manager.configure("owner", "https://feeds.example/other.xml"), { code: "SYNC_SOURCE_URL_MISMATCH" });
  assert.deepEqual(h.source, before);
  assert.deepEqual(h.associations, [{ usuarioId: "owner", importSourceId: "existing", source: "crm" }]);
  assert.deepEqual(h.properties, [associated()]);
});

test("URL distinta sin propiedades cambia configuracion pero no importSourceId", async () => {
  const h = harness(legacy());
  const before = structuredClone(h.source);
  const url = "https://feeds.example/other.xml";
  await h.manager.configure("owner", url);
  assert.equal(h.source._id, before._id);
  assert.notEqual(h.source.feedUrlHash, before.feedUrlHash);
  assert.equal(decryptFeedUrl(h.source, env), url);
  assert.equal(h.source.syncEnabled, false);
  assert.equal(h.source.importLockToken, undefined);
});

test("configuracion toma lock antes de comprobar propiedades y bloquea import concurrente", async () => {
  let resume;
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const pause = new Promise(resolve => { resume = resolve; });
  const h = harness(legacy(), { PropiedadModel: { exists: async () => { entered(); await pause; return false; } } });
  const configuring = h.manager.configure("owner", "https://feeds.example/other.xml");
  await ready;
  const originalHash = h.source.feedUrlHash;
  const filter = { _id: "existing", activo: true, feedUrlHash: originalHash,
    $or: [{ importLockUntil: { $exists: false } }, { importLockUntil: null }, { importLockUntil: { $lte: new Date() } }] };
  assert.equal(await h.ImportSourceModel.findOneAndUpdate(filter, { $set: { importLockToken: "import" } }), null);
  resume();
  await configuring;
  assert.equal(h.source.importLockToken, undefined);
  assert.equal(await h.ImportSourceModel.findOneAndUpdate(filter, { $set: { importLockToken: "import" } }), null);
});

test("importacion primero bloquea configurar; tras crear inmueble se rechaza cambio", async () => {
  const h = harness({ ...legacy(), importLockToken: "import", importLockUntil: new Date(Date.now() + 60000) });
  const before = structuredClone(h.source);
  await assert.rejects(() => h.manager.configure("owner", "https://feeds.example/other.xml"), { code: "SYNC_SOURCE_BUSY" });
  assert.deepEqual(h.source, before);
  h.properties.push(associated());
  await h.ImportSourceModel.updateOne({ _id: "existing", importLockToken: "import" }, { $unset: { importLockToken: "", importLockUntil: "" } });
  await assert.rejects(() => h.manager.configure("owner", "https://feeds.example/other.xml"), { code: "SYNC_SOURCE_URL_MISMATCH" });
  assert.equal(h.source.feedUrlHash, before.feedUrlHash);
  assert.equal(h.source.importLockToken, undefined);
});

test("si se pierde el lock no actualiza identidad ni libera el lock de otro proceso", async () => {
  const h = harness(legacy(), { PropiedadModel: { exists: async () => {
    h.source.importLockToken = "replacement-import";
    return false;
  } } });
  const before = h.source.feedUrlHash;
  await assert.rejects(() => h.manager.configure("owner", "https://feeds.example/other.xml"), { code: "SYNC_SOURCE_BUSY" });
  assert.equal(h.source.feedUrlHash, before);
  assert.equal(h.source.importLockToken, "replacement-import");
});

test("configurar crea solo fuente propia cifrada y desactiva sync", async () => {
  const h = harness();
  const status = await h.manager.configure("owner", feedUrl);
  assert.equal(status.configured, true);
  assert.equal(status.syncEnabled, false);
  assert.equal(h.source.usuarioId, "owner");
  assert.equal(h.source.feedType, "generic_xml");
  assert.equal(decryptFeedUrl(h.source, env), feedUrl);
  assert.doesNotMatch(JSON.stringify({ status, writes: h.writes }), /private-token|secret-test/);
  assert.equal(h.writes[0].filter.usuarioId, "owner");
  assert.equal(h.writes[0].filter.$or.length, 3);
});

test("configurar actualiza fuente existente sin cambiar id ni metadatos de importacion", async () => {
  const h = harness({ _id: "existing", usuarioId: "owner", feedType: "generic_xml", syncEnabled: true, lastImportedAt: new Date(0) });
  await h.manager.configure("owner", feedUrl);
  assert.equal(h.source._id, "existing");
  assert.equal(h.source.syncEnabled, false);
  assert.equal(h.source.lastImportedAt.getTime(), 0);
  assert.equal(decryptFeedUrl(h.source, env), feedUrl);
});

test("GET propio excluye URL completa, hash, ciphertext y datos ajenos", async () => {
  const h = harness();
  await h.manager.configure("owner", feedUrl);
  const status = await h.manager.get("owner");
  assert.equal(status.importSourceId, "source-id");
  assert.doesNotMatch(JSON.stringify(status), /private-token|secret-test|encryptedFeedUrl|feedUrlHash|feedUrlKeyVersion/);
  assert.equal((await h.manager.get("other")).configured, false);
  assert.equal(safeSourceStatus({ _id: "legacy", feedUrlMasked: feedUrl }).configured, false);
  assert.doesNotMatch(JSON.stringify(safeSourceStatus({ _id: "legacy", feedUrlMasked: feedUrl })), /private-token|secret-test/);
});

test("sin clave no hace DNS ni escrituras y no falla al construir manager", async () => {
  const h = harness(null, { env: {}, validateTarget: () => assert.fail("no DNS") });
  await assert.rejects(() => h.manager.configure("owner", feedUrl), { code: "SYNC_SOURCE_NOT_CONFIGURED" });
  assert.equal(h.writes.length, 0);
  assert.equal((await h.manager.get("owner")).configured, false);
});

test("fuente rechaza protocolos, credenciales y DNS mixto publico/privado antes de guardar", async () => {
  const h = harness(null, { validateTarget: url => assertPublicFeedTarget(url, { lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }] }) });
  for (const url of ["file:///tmp/feed", "ftp://example.com/feed", "https://user:password@example.com/feed", "http://127.0.0.1/feed", feedUrl]) {
    await assert.rejects(() => h.manager.configure("owner", url));
  }
  assert.equal(h.writes.length, 0);
});

test("indice unico/lock activo devuelve conflicto sin reemplazar la fuente", async () => {
  const h = harness(null, { ImportSourceModel: { findOneAndUpdate: async () => { throw Object.assign(new Error("duplicate"), { code: 11000 }); } } });
  await assert.rejects(() => h.manager.configure("owner", feedUrl), { code: "SYNC_SOURCE_BUSY" });
});

function uiHarness(fetcher = async () => ({ ok: true, json: async () => ({ configured: false }) })) {
  const elements = new Map();
  function element() { return { value: "", textContent: "", disabled: false, children: [], listeners: {}, classList: { add() {}, remove() {} },
    replaceChildren() { this.children = []; }, append(child) { this.children.push(child); }, addEventListener(event, fn) { this.listeners[event] = fn; } }; }
  const document = { createElement: element, getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); } };
  const context = vm.createContext({ window: {}, document, fetch: fetcher });
  vm.runInContext(read("public/js/crm-sync-ui.js"), context);
  return { ui: context.window.HomeClickCrmSync, elements, document };
}

test("UI limita detalles a 100, muestra protecciones y resumen sin URLs originales", () => {
  const { ui, document } = uiHarness();
  const output = document.createElement();
  ui.renderizar({ snapshotComplete: false, snapshotCount: 101, newCount: 101, resultsTruncated: true, totalResults: 101,
    results: Array.from({ length: 101 }, () => ({ externalId: "DEMO", type: "CONFLICT", changes: { precio: { old: feedUrl, new: feedUrl, blockedByOverride: true } }, reason: feedUrl })) }, output);
  const allText = JSON.stringify(output);
  assert.doesNotMatch(allText, /private-token|secret-test/);
  assert.match(allText, /protegido por edición manual/);
  assert.match(allText, /Snapshot incompleto/);
  assert.match(allText, /100 detalles/);
  assert.equal(output.children[2].children.length, 100);
});

test("UI configura y simula solo su id, limpia URL y nunca llama import", async () => {
  const calls = [];
  const { ui, elements } = uiHarness(async (path, options) => {
    calls.push({ path, options });
    return { ok: true, json: async () => path.endsWith("source") ? { configured: true, importSourceId: "own-id", feedUrlMasked: "https://feeds.example/...?..." }
      : { snapshotComplete: true, snapshotCount: 4, newCount: 4, results: [] } };
  });
  ui.iniciar(() => "mock-token");
  await new Promise(resolve => setImmediate(resolve));
  elements.get("crmSyncFeedUrl").value = feedUrl;
  await elements.get("crmSyncSave").listeners.click();
  assert.equal(elements.get("crmSyncFeedUrl").value, "");
  await elements.get("crmSyncSimulate").listeners.click();
  assert.deepEqual(calls.map(item => item.options.method), ["GET", "PUT", "POST"]);
  assert.deepEqual(JSON.parse(calls[2].options.body), { importSourceId: "own-id" });
  assert.ok(calls.every(item => item.options.headers.Authorization === "Bearer mock-token"));
  assert.ok(calls.every(item => !item.path.endsWith("/import")));
  assert.deepEqual([...elements.keys()].sort(), ["crmSyncFeedUrl", "crmSyncSave", "crmSyncSimulate", "crmSyncStatus", "crmSyncMasked", "crmSyncResults"].sort());
  assert.doesNotMatch(JSON.stringify([...elements.values()]), /private-token|secret-test/);
});

test("UI muestra mensaje seguro de mismatch sin hash ni configuracion original", async () => {
  const message = "Esta cuenta ya tiene inmuebles vinculados a otra fuente CRM. En esta fase solo puedes configurar la misma fuente.";
  const { ui, elements } = uiHarness(async (path, options) => ({
    ok: options.method === "GET", status: options.method === "GET" ? 200 : 409,
    json: async () => options.method === "GET" ? { configured: false } : { code: "SYNC_SOURCE_URL_MISMATCH", error: message }
  }));
  ui.iniciar(() => "mock-token");
  await new Promise(resolve => setImmediate(resolve));
  elements.get("crmSyncFeedUrl").value = "https://feeds.example/other.xml";
  await elements.get("crmSyncSave").listeners.click();
  assert.equal(elements.get("crmSyncStatus").textContent, message);
  assert.doesNotMatch(elements.get("crmSyncStatus").textContent, /feedUrlHash|encryptedFeedUrl|https?:/);
});

test("scripts inline del perfil siguen siendo sintacticamente validos", () => {
  for (const match of read("public/perfil.html").matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\bsrc\s*=/.test(match[1]) && match[2].trim()) new vm.Script(match[2]);
  }
});
