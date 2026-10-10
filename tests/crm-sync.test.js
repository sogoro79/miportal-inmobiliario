import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import mongoose from "mongoose";
import { encryptFeedUrl, decryptFeedUrl } from "../utils/import/feedUrlCrypto.js";
import { buildSyncSnapshot, normalizeSyncProperty, syncFingerprint, MAX_SYNC_PROPERTIES, SYNC_FINGERPRINT_VERSION } from "../utils/import/syncSnapshot.js";
import { compareSyncSnapshot } from "../utils/import/syncDiff.js";
import { createSyncSimulator, safeSimulationCode } from "../utils/import/syncSimulation.js";
import { fetchFeedXml } from "../utils/import/feedFetcher.js";
import { capturePropertyContent, markManualContentChanges } from "../utils/propertyContent.js";
import Propiedad from "../models/Propiedad.js";
import ImportSource from "../models/ImportSource.js";
import ImportSyncRun from "../models/ImportSyncRun.js";

const env = { CRM_FEED_URL_KEY_VERSION: "1", CRM_FEED_URL_KEY_V1: crypto.randomBytes(32).toString("base64") };
const url = "https://feeds.example/private-token.xml?token=secret-test";
const userId = "507f1f77bcf86cd799439099";
const sourceId = "507f1f77bcf86cd799439098";
const node = (extras = {}) => ({ id: "REF-1", title: "Casa de prueba", price: "245000", operation: "sale", address: "Calle de prueba", city: "Chipiona", bedrooms: "3", ...extras });
const data = extras => normalizeSyncProperty(node(extras)).data;
const property = extras => ({ ...data(), syncEnabled: true, source: "crm", ...extras });
const snapshot = (items, complete = true) => ({ properties: items.map(item => normalizeSyncProperty(item)), snapshotComplete: complete });
const xml = (count, metadata = "") => `<properties>${metadata}${Array.from({ length: count }, (_, i) => `<property><id>REF-${i}</id><title>Casa ${i}</title><price>245000</price></property>`).join("")}</properties>`;

test("URL cifrada autenticada, aleatoria y versionada sin texto plano", () => {
  const first = encryptFeedUrl(url, env);
  const second = encryptFeedUrl(url, env);
  assert.equal(decryptFeedUrl(first, env), url);
  assert.notEqual(first.encryptedFeedUrl, second.encryptedFeedUrl);
  assert.equal(first.feedUrlKeyVersion, "1");
  assert.equal(first.syncEnabled, false);
  assert.doesNotMatch(JSON.stringify(first), /private-token|secret-test/);
  const rotated = { CRM_FEED_URL_KEY_VERSION: "2", CRM_FEED_URL_KEY_V2: crypto.randomBytes(32).toString("base64"), ...env };
  rotated.CRM_FEED_URL_KEY_VERSION = "2";
  assert.equal(decryptFeedUrl(encryptFeedUrl(url, rotated), rotated), url);
});

test("cifrado rechaza clave incorrecta, ausente, manipulaciones y hash distinto", () => {
  const source = encryptFeedUrl(url, env);
  const wrong = { ...env, CRM_FEED_URL_KEY_V1: crypto.randomBytes(32).toString("base64") };
  for (const [item, keys] of [[source, wrong], [source, {}], [{ ...source, feedUrlKeyVersion: "2" }, env], [{ ...source, encryptedFeedUrl: source.encryptedFeedUrl.slice(1) }, env], [{ ...source, feedUrlHash: "wrong" }, env], [{}, env]]) {
    assert.throws(() => decryptFeedUrl(item, keys), { code: "SYNC_SOURCE_NOT_CONFIGURED" });
  }
});

test("normalización distingue ausencia, vacío, cero, false y null sin defaults", () => {
  assert.equal(Object.hasOwn(normalizeSyncProperty({ id: "X" }).data, "descripcion"), false);
  assert.equal(normalizeSyncProperty({ id: "X", description: "" }).data.descripcion, "");
  assert.equal(normalizeSyncProperty({ id: "X", description: null }).data.descripcion, null);
  assert.equal(data({ bathrooms: 0, pool: false }).banos, 0);
  assert.equal(data({ bathrooms: 0, pool: false }).piscina, false);
  assert.equal(data({ pool: true }).piscina, true);
  assert.equal(Object.hasOwn(data(), "piscina"), false);
  assert.equal(data({ price: "1.200,50" }).precio, 1200.5);
  assert.equal(data({ latitude: "0", longitude: "0" }).lat, 0);
  assert.equal(normalizeSyncProperty({ id: "X", bathrooms: "" }).data.banos, "");
  assert.ok(normalizeSyncProperty({ id: "X", bathrooms: "" }).errors.includes("INVALID_banos"));
});

test("XML nil explícito permanece null y tag vacío no se transforma en cero", () => {
  const result = buildSyncSnapshot('<properties><property><id>X</id><description xsi:nil="true"/><price>0</price><bathrooms/></property></properties>');
  assert.equal(result.properties[0].data.descripcion, null);
  assert.equal(result.properties[0].data.precio, 0);
  assert.equal(result.properties[0].data.banos, "");
  assert.equal(result.snapshotComplete, false);
});

test("snapshot completo procesa más de 500 sin truncar", () => {
  const result = buildSyncSnapshot(xml(601));
  assert.equal(result.snapshotCount, 601);
  assert.equal(result.snapshotComplete, true);
  assert.equal(result.properties[600].data.externalId, "REF-600");
});

test("límite snapshot explícito e incompleto sin MISSING", () => {
  const full = buildSyncSnapshot(xml(MAX_SYNC_PROPERTIES));
  assert.equal(full.snapshotComplete, true);
  const result = buildSyncSnapshot(xml(MAX_SYNC_PROPERTIES + 1));
  assert.equal(result.snapshotCount, MAX_SYNC_PROPERTIES);
  assert.equal(result.snapshotComplete, false);
  assert.ok(result.warnings.includes("SNAPSHOT_LIMIT_EXCEEDED"));
  assert.equal(compareSyncSnapshot(result, [{ externalId: "OLD" }]).missingCount, 0);
});

test("feed vacío, desconocido, paginado, duplicado y registro malformado bloquean MISSING", () => {
  for (const input of ["<properties/>", "<unknown/>", xml(1, "<nextPage>https://feeds.example/page2</nextPage>"), xml(1, "<total>10</total>"), "<properties><property><id>X</id></property><property><id>X</id></property></properties>", "<properties><property/></properties>"]) {
    const result = buildSyncSnapshot(input);
    assert.equal(result.snapshotComplete, false, input);
    assert.ok(result.warnings.includes("MISSING_DISABLED_INCOMPLETE_SNAPSHOT"));
    assert.equal(compareSyncSnapshot(result, [{ externalId: "OLD" }]).missingCount, 0);
  }
});

test("snapshot mantiene tamaño, XML seguro y rechazo DOCTYPE/ENTITY completos", () => {
  for (const declaration of ["<!DOCTYPE x>", "<!ENTITY x SYSTEM 'file:///secret'>"]) {
    assert.throws(() => buildSyncSnapshot(" ".repeat(5000) + declaration + "<properties/>"));
  }
  assert.throws(() => buildSyncSnapshot(" ".repeat(5 * 1024 * 1024 + 1)), { code: "FEED_TOO_LARGE" });
  assert.throws(() => buildSyncSnapshot("<properties>"), { code: "XML_INVALID" });
});

test("fingerprint estable, versionado, distingue precio, ausencia, null y orden fotos", () => {
  const original = data({ images: { image: ["https://img.example/1", "https://img.example/2"] } });
  assert.equal(syncFingerprint(original), syncFingerprint({ ...original }));
  assert.notEqual(syncFingerprint(original), syncFingerprint({ ...original, precio: 239000 }));
  assert.notEqual(syncFingerprint(original), syncFingerprint({ ...original, imagenes: [...original.imagenes].reverse() }));
  assert.notEqual(syncFingerprint(original), syncFingerprint(original, 2));
  assert.notEqual(syncFingerprint(original), syncFingerprint({ ...original, descripcion: null }));
  assert.equal(SYNC_FINGERPRINT_VERSION, 1);
});

test("diff clasifica UNCHANGED, UPDATE, NEW, MISSING, INVALID sin mutar propiedades", () => {
  const existing = [property(), { ...property(), externalId: "OLD" }];
  const before = structuredClone(existing);
  let result = compareSyncSnapshot(snapshot([node()]), existing);
  assert.equal(result.unchangedCount, 1);
  assert.equal(result.missingCount, 1);
  result = compareSyncSnapshot(snapshot([node({ price: "239000" }), node({ id: "NEW", title: "Casa nueva" }), node({ id: "BAD", price: "invalid" })]), existing);
  assert.equal(result.updateCount, 1);
  assert.deepEqual(result.results[0].changes.precio, { old: 245000, new: 239000, blockedByOverride: false });
  assert.equal(result.newCount, 1);
  assert.equal(result.results[1].publishableByData, true);
  assert.equal(result.errorCount, 1);
  assert.deepEqual(existing, before);
});

test("NEW incompleto no se presenta como publicable ni reserva cupo", () => {
  const result = compareSyncSnapshot(snapshot([{ id: "NEW", title: "Casa" }]), []);
  assert.equal(result.results[0].type, "NEW");
  assert.equal(result.results[0].publishableByData, false);
});

test("conflictos por overrides, identidad, legacy y referencia sospechosa", () => {
  for (const [incoming, stored] of [[node({ price: "239000" }), property({ syncOverrides: { precio: true } })], [node({ city: "Rota" }), property()], [node({ operation: "rent" }), property()], [node(), property({ syncEnabled: false })], [node({ id: "REF-2" }), property()]]) {
    assert.equal(compareSyncSnapshot(snapshot([incoming]), [stored]).results[0].type, "CONFLICT");
  }
  const changes = compareSyncSnapshot(snapshot([node({ price: "239000" })]), [property({ syncOverrides: { precio: true } })]).results[0].changes;
  assert.equal(changes.precio.blockedByOverride, true);
});

test("estado comercial documentado y retiradas requieren revisión", () => {
  const statuses = { available: "Disponible", active: "Disponible", reserved: "Reservado", sold: "Vendido", rented: "Alquilado" };
  for (const [status, expected] of Object.entries(statuses)) assert.equal(data({ status }).estadoComercial, expected);
  for (const status of ["withdrawn", "inactive", "deleted"]) {
    assert.equal(data({ status }).crmWithdrawal, true);
    assert.equal(compareSyncSnapshot(snapshot([node({ status })]), [property()]).results[0].type, "CONFLICT");
  }
  assert.ok(normalizeSyncProperty(node({ status: "unknown" })).errors.includes("INVALID_estadoComercial"));
  assert.equal(data({ sold: "true" }).estadoComercial, "Vendido");
  assert.equal(compareSyncSnapshot(snapshot([node({ id: "NEW", sold: "true" })]), []).results[0].publishableByData, false);
  assert.ok(normalizeSyncProperty(node({ status: "active", sold: "true" })).errors.includes("CONTRADICTORY_COMMERCIAL_STATUS"));
});

test("valores suministrados inválidos no se clasifican como UPDATE válido", () => {
  for (const incoming of [node({ title: "" }), node({ price: null }), node({ price: false }), node({ status: null }), node({ id: "https://feeds.example/?token=secret" })]) {
    assert.ok(normalizeSyncProperty(incoming).errors.length > 0);
    assert.equal(compareSyncSnapshot(snapshot([incoming]), [property()]).results[0].type, "INVALID");
  }
});

test("override y diff tienen prioridad sobre fingerprint antiguo coincidente", () => {
  const incoming = data();
  const stored = property({ precio: 200000, syncOverrides: { precio: true }, syncFingerprint: syncFingerprint(incoming), syncFingerprintVersion: 1 });
  const result = compareSyncSnapshot(snapshot([node()]), [stored]).results[0];
  assert.equal(result.baselineMatches, true);
  assert.equal(result.type, "CONFLICT");
});

test("revisión manual incrementa solo cambios efectivos y protege CRM campo por campo", () => {
  const item = property({ imagenes: [], contentRevision: 0 });
  let before = capturePropertyContent(item);
  item.visitas = 7;
  item.contactos = 3;
  item.redesPublicadoCount = 2;
  item.imagenes = [];
  assert.deepEqual(markManualContentChanges(item, before), []);
  assert.equal(item.contentRevision, 0);
  before = capturePropertyContent(item);
  item.precio = 200000;
  assert.deepEqual(markManualContentChanges(item, before), ["precio"]);
  assert.equal(item.contentRevision, 1);
  assert.deepEqual(item.syncOverrides, { precio: true });
  item.source = "manual";
  before = capturePropertyContent(item);
  item.titulo = "Otro título";
  markManualContentChanges(item, before);
  assert.equal(item.contentRevision, 2);
  assert.equal(item.syncOverrides.titulo, undefined);
});

test("Mongoose usa incremento atómico y metadatos compatibles sin conexión", () => {
  const item = Propiedad.hydrate({ _id: new mongoose.Types.ObjectId(), titulo: "Casa", imagenes: ["https://img.example/1"], source: "crm", syncEnabled: true });
  const before = capturePropertyContent(item);
  item.precio = 245000;
  markManualContentChanges(item, before);
  assert.equal(item.getChanges().$inc.contentRevision, 1);
  assert.equal(item.syncOverrides.precio, true);
  assert.equal(new Propiedad().syncEnabled, false);
  assert.equal(new ImportSource().syncEnabled, false);
  assert.equal(ImportSource.schema.path("encryptedFeedUrl").options.select, false);
  assert.equal(new ImportSyncRun().mode, "simulation");
});

function harness({ feed = xml(1), existing = [], fetcher, source: sourceOverride } = {}) {
  const source = { _id: sourceId, usuarioId: userId, activo: true, feedType: "generic_xml", ...encryptFeedUrl(url, env), ...sourceOverride };
  const runs = [];
  const updates = [];
  const lookups = [];
  const simulate = createSyncSimulator({ env,
    ImportSourceModel: { findOne: async filter => { lookups.push(filter); return filter.usuarioId === userId && filter._id === sourceId ? source : null; } },
    ImportSyncRunModel: { create: async row => { runs.push(row); return { _id: "run-1" }; }, updateOne: async (...args) => { updates.push(args); } },
    PropiedadModel: { find: async filter => { assert.deepEqual(filter, { usuarioId: userId, importSourceId: sourceId, source: "crm" }); return existing; }, updateOne: () => assert.fail("no property writes"), create: () => assert.fail("no property creation") },
    fetchXml: fetcher || (async received => { assert.equal(received, url); return { xml: feed }; })
  });
  return { simulate, runs, updates, lookups };
}

test("simulación guarda exclusivamente run y respuesta no contiene URL/tokens", async () => {
  const { simulate, runs, updates } = harness();
  const response = await simulate({ usuarioId: userId, importSourceId: sourceId });
  assert.equal(response.mode, "simulation");
  assert.equal(response.snapshotComplete, true);
  assert.equal(runs.length, 1);
  assert.equal(updates.length, 1);
  assert.doesNotMatch(JSON.stringify({ response, runs, updates }), /private-token|secret-test|encryptedFeedUrl/);
});

test("fuente legacy devuelve error claro sin fetch ni escritura", async () => {
  const { simulate, runs } = harness({ source: { encryptedFeedUrl: undefined }, fetcher: () => assert.fail("no fetch") });
  await assert.rejects(() => simulate({ usuarioId: userId, importSourceId: sourceId }), { code: "SYNC_SOURCE_NOT_CONFIGURED" });
  assert.equal(runs.length, 0);
});

test("solo propietario puede simular fuente propia", async () => {
  const { simulate, runs } = harness();
  await assert.rejects(() => simulate({ usuarioId: "other-user", importSourceId: sourceId }), { code: "SYNC_SOURCE_NOT_FOUND" });
  assert.equal(runs.length, 0);
});

test("respuesta está limitada y los totales no se truncan", async () => {
  const { simulate } = harness({ feed: xml(601) });
  const response = await simulate({ usuarioId: userId, importSourceId: sourceId });
  assert.equal(response.newCount, 601);
  assert.equal(response.results.length, 100);
  assert.equal(response.resultsTruncated, true);
});

test("URLs de imágenes y enlaces en texto del feed no filtran tokens en diff", () => {
  const incoming = node({ description: `Ver ${url}`, images: { image: [url] } });
  const result = compareSyncSnapshot(snapshot([incoming]), [property({ descripcion: "Anterior", imagenes: [] })]);
  assert.doesNotMatch(JSON.stringify(result), /private-token|secret-test/);
  assert.equal(result.results[0].changes.imagenes.new.count, 1);
});

test("errores técnicos seguros sin mensajes ni códigos arbitrarios", async () => {
  const { simulate, updates } = harness({ fetcher: async () => { throw Object.assign(new Error(url), { code: url }); } });
  await assert.rejects(() => simulate({ usuarioId: userId, importSourceId: sourceId }), { code: "SYNC_RUN_FAILED" });
  assert.doesNotMatch(JSON.stringify(updates), /private-token|secret-test/);
  assert.equal(safeSimulationCode({ code: url }), "SYNC_RUN_FAILED");
});

test("simulación reutiliza bloqueo SSRF y redirects privados sin tocar red externa", async () => {
  for (const initialPrivate of [true, false]) {
    let calls = 0;
    const { simulate, updates } = harness({ fetcher: received => fetchFeedXml(received, {
      lookup: async host => [{ address: initialPrivate || host === "private.example" ? "10.0.0.1" : "93.184.216.34", family: 4 }],
      requestOnce: async () => { calls++; return { statusCode: 302, headers: { location: "https://private.example/feed.xml" }, body: "" }; }
    }) });
    await assert.rejects(() => simulate({ usuarioId: userId, importSourceId: sourceId }), { code: "PRIVATE_IP" });
    assert.equal(calls, initialPrivate ? 0 : 1);
    assert.equal(updates[0][1].$set.errorCode, "PRIVATE_IP");
  }
});
