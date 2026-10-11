import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { analyzeGenericXml } from "../utils/importers/genericXmlImporter.js";
import { buildSyncSnapshot } from "../utils/import/syncSnapshot.js";
import { compareSyncSnapshot } from "../utils/import/syncDiff.js";
import { prepareSyncPlan } from "../utils/import/syncPlan.js";
import { validateImportProperty } from "../utils/import/selectedImport.js";
import { buildPropiedadCreateData } from "../utils/propertyCreation.js";

const xml = readFileSync(new URL("../public/test-sync-new/homeclick24-sync-new-test.xml", import.meta.url), "utf8");
const expected = {
  titulo: "Piso de prueba NEW CRM en Chipiona",
  descripcion: "Datos ficticios exclusivos para prueba controlada NEW CRM. No usar como anuncio real.",
  tipoOperacion: "venta", precio: 198000, tipoInmueble: "piso", estado: "segunda_mano",
  habitaciones: 2, banos: 1, superficie: 72, direccion: "Dirección de prueba",
  localidad: "Chipiona", provincia: "Cádiz", codigoPostal: "11550",
  garaje: false, piscina: false, terraza: true
};

test("controlled NEW XML is valid and contains exactly one supported property", () => {
  assert.equal(XMLValidator.validate(xml), true);
  const raw = new XMLParser({ parseTagValue: false }).parse(xml).properties.property;
  assert.equal(Array.isArray(raw), false);
  assert.equal(raw.externalId, "SYNC-NEW-TEST-001");
  assert.deepEqual(Object.keys(raw).sort(), ["externalId", "title", "description", "operation", "price",
    "address", "city", "province", "postalCode", "bedrooms", "bathrooms", "surface",
    "propertyType", "condition", "garage", "pool", "terrace"].sort());
  const mapped = analyzeGenericXml(xml);
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].externalId, "SYNC-NEW-TEST-001");
});

test("controlled NEW snapshot is complete and normalizes all supplied fields", () => {
  const snapshot = buildSyncSnapshot(xml);
  assert.equal(snapshot.snapshotComplete, true);
  assert.equal(snapshot.properties.length, 1);
  assert.deepEqual(snapshot.properties[0].errors, []);
  assert.equal(snapshot.properties[0].data.externalId, "SYNC-NEW-TEST-001");
  for (const [field, value] of Object.entries(expected)) assert.equal(snapshot.properties[0].data[field], value, field);
});

test("controlled NEW is publishable by shared validation and individually eligible in plan", () => {
  const snapshot = buildSyncSnapshot(xml);
  const diff = compareSyncSnapshot(snapshot, []);
  assert.equal(diff.results.length, 1);
  assert.equal(diff.results[0].type, "NEW");
  assert.equal(diff.results[0].publishableByData, true);
  const plan = prepareSyncPlan(snapshot, []);
  assert.equal(plan.newCount, 1);
  assert.equal(plan.resultsTruncated, false);
  assert.equal(plan.plan[0].importNewEligible, true);
  assert.equal(plan.plan[0].importNewBlockCode, null);
});

test("Phase 2 mapper, validation and creation agree semantically with NEW snapshot", () => {
  const mapped = analyzeGenericXml(xml)[0];
  const validation = validateImportProperty(mapped);
  assert.deepEqual(validation.errors, []);
  const created = buildPropiedadCreateData(validation.data);
  const snapshot = buildSyncSnapshot(xml).properties[0].data;
  for (const [field, value] of Object.entries(expected)) {
    assert.equal(created[field], value, field);
    assert.equal(created[field], snapshot[field], field);
  }
});

test("controlled NEW has no photos, video or geolocation in either path", () => {
  const mapped = analyzeGenericXml(xml)[0];
  const snapshot = buildSyncSnapshot(xml).properties[0].data;
  const created = buildPropiedadCreateData(validateImportProperty(mapped).data);
  assert.deepEqual(mapped.fotos, []);
  assert.equal((snapshot.imagenes || []).length, 0);
  assert.deepEqual(created.imagenes, []);
  assert.equal(created.videoUrl, "");
  assert.equal(snapshot.videoUrl || "", "");
  assert.equal(created.lat, null);
  assert.equal(created.lng, null);
  assert.equal(snapshot.lat ?? null, null);
  assert.equal(snapshot.lng ?? null, null);
});

test("controlled feed contains no users, real IDs, contacts or external resources", () => {
  assert.doesNotMatch(xml, /[a-f0-9]{24}|https?:\/\/|@|usuarioId|userId|ownerId|importSourceId|feedUrl|<referencia\b/i);
  assert.doesNotMatch(xml, /<(?:images?|photos?|fotos?|video\w*|lat|lng|latitude|longitude)\b/i);
});
