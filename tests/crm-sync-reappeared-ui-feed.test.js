import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { XMLValidator } from "fast-xml-parser";
import { analyzeGenericXml } from "../utils/importers/genericXmlImporter.js";
import { buildSyncSnapshot } from "../utils/import/syncSnapshot.js";
import { compareSyncSnapshot } from "../utils/import/syncDiff.js";
import { validateImportProperty } from "../utils/import/selectedImport.js";
import { buildPropiedadCreateData } from "../utils/propertyCreation.js";
import { managedChangedFields } from "../utils/import/syncBaseline.js";

const path = "public/test-sync-reappeared-ui/homeclick24-reappeared-ui.xml";
const url = new URL(`../${path}`, import.meta.url);
const xml = fs.readFileSync(url, "utf8");
const target = "SYNC-REAPPEARED-UI-001";
const control = "SYNC-REAPPEARED-UI-CONTROL-001";
const expected = {
  externalId: target, titulo: "Piso prueba REAPPEARED en Rota",
  descripcion: "Propiedad temporal para prueba controlada REAPPEARED CRM.",
  tipoOperacion: "venta", precio: 231000, direccion: "Dirección de prueba REAPPEARED",
  localidad: "Rota", provincia: "Cádiz", codigoPostal: "11520",
  tipoInmueble: "piso", estado: "segunda_mano", estadoComercial: "Disponible",
  habitaciones: 2, banos: 1, superficie: 82, garaje: false, piscina: false, terraza: false
};

test("temporary BASE exists at the exact future public path and is valid XML", () => {
  assert.ok(fs.existsSync(url));
  assert.equal(XMLValidator.validate(xml), true);
  assert.equal(new URL(`/${path.slice("public/".length)}`, "https://www.homeclick24.com").href,
    "https://www.homeclick24.com/test-sync-reappeared-ui/homeclick24-reappeared-ui.xml");
});
test("BASE contains exactly the unique target, not control or old test identities", () => {
  const preview = analyzeGenericXml(xml);
  assert.equal(preview.length, 1);
  assert.deepEqual(preview.map(p => p.externalId), [target]);
  assert.equal(new Set(preview.map(p => p.externalId)).size, 1);
  assert.ok(!xml.includes(control));
  assert.doesNotMatch(xml, /SYNC-(?:MISSING|NEW|APPLY|DEMO)|HC24-DEMO|test-sync-(?:missing|new|apply)/);
});
test("complete snapshot has exact BASE fields and no invalid data", () => {
  const snapshot = buildSyncSnapshot(xml);
  assert.equal(snapshot.snapshotComplete, true);
  assert.deepEqual(snapshot.warnings, []);
  assert.equal(snapshot.properties.length, 1);
  assert.deepEqual(snapshot.properties[0].errors, []);
  assert.deepEqual(snapshot.properties[0].data, expected);
});
test("BASE is publishable using the real Phase 2 validator", () => {
  const preview = analyzeGenericXml(xml)[0];
  const validated = validateImportProperty(preview);
  assert.deepEqual(preview.errors, []);
  assert.deepEqual(validated.errors, []);
  const diff = compareSyncSnapshot(buildSyncSnapshot(xml), []);
  assert.equal(diff.newCount, 1);
  assert.equal(diff.results[0].publishableByData, true);
});
test("BASE has no photos, video, coordinates or embedded resources", () => {
  const preview = analyzeGenericXml(xml)[0];
  assert.deepEqual(preview.fotos, []);
  assert.equal(preview.lat, null); assert.equal(preview.lng, null);
  assert.doesNotMatch(xml, /<(?:images?|photos?|video|videoUrl|lat|lng|latitude|longitude)\b|https?:\/\//i);
});
test("Phase 2 mapper and creation helper preserve snapshot semantics without persistence", () => {
  const validated = validateImportProperty(analyzeGenericXml(xml)[0]);
  assert.deepEqual(validated.errors, []);
  const created = buildPropiedadCreateData(validated.data, { plan: "vip", imagenes: [] });
  for (const [field, value] of Object.entries(expected)) {
    if (field !== "externalId") assert.deepEqual(created[field], value, field);
  }
  assert.deepEqual(created.imagenes, []);
  assert.equal(created.videoUrl, "");
  assert.deepEqual(managedChangedFields(created, expected), []);
});
test("documented later control is valid and separate, not served in initial BASE", () => {
  const doc = fs.readFileSync(new URL("../docs/CRM_SYNC_REAPPEARED_UI_TEST.md", import.meta.url), "utf8");
  const controlXml = doc.match(/```xml\n([\s\S]*?)\n```/)[1];
  const snapshot = buildSyncSnapshot(controlXml);
  assert.equal(snapshot.snapshotComplete, true);
  assert.equal(snapshot.properties.length, 1);
  const data = snapshot.properties[0].data;
  assert.equal(data.externalId, control);
  assert.equal(data.titulo, "Control prueba REAPPEARED");
  assert.equal(data.precio, 226000); assert.equal(data.habitaciones, 1); assert.equal(data.banos, 1);
  assert.equal(data.superficie, 61); assert.equal(data.localidad, "Rota"); assert.equal(data.provincia, "Cádiz");
  assert.equal(data.tipoInmueble, "piso"); assert.equal(data.estado, "segunda_mano");
  assert.deepEqual(analyzeGenericXml(controlXml)[0].fotos, []);
  assert.deepEqual(validateImportProperty(analyzeGenericXml(controlXml)[0]).errors, []);
  assert.ok(!controlXml.includes(target));
});
