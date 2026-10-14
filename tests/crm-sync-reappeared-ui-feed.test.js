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
// Exact BASE block from cfc5a53ce5b7b677bd1c6a0fcde85ddd0ee0e9ef, referenced in the test guide.
const baselineBlock = `  <property>
    <externalId>SYNC-REAPPEARED-UI-001</externalId>
    <title>Piso prueba REAPPEARED en Rota</title>
    <description>Propiedad temporal para prueba controlada REAPPEARED CRM.</description>
    <operation>venta</operation>
    <price>231000</price>
    <address>Dirección de prueba REAPPEARED</address>
    <city>Rota</city>
    <province>Cádiz</province>
    <postalCode>11520</postalCode>
    <propertyType>piso</propertyType>
    <condition>used</condition>
    <commercialStatus>available</commercialStatus>
    <bedrooms>2</bedrooms>
    <bathrooms>1</bathrooms>
    <surface>82</surface>
    <garage>false</garage>
    <pool>false</pool>
    <terrace>false</terrace>
  </property>`;
const baselineXml = `<?xml version="1.0" encoding="UTF-8"?>\n<properties>\n${baselineBlock}\n</properties>\n`;
const targetExpected = {
  externalId: target, titulo: "Piso prueba REAPPEARED en Rota",
  descripcion: "Propiedad temporal para prueba controlada REAPPEARED CRM.",
  tipoOperacion: "venta", precio: 231000, direccion: "Dirección de prueba REAPPEARED",
  localidad: "Rota", provincia: "Cádiz", codigoPostal: "11520",
  tipoInmueble: "piso", estado: "segunda_mano", estadoComercial: "Disponible",
  habitaciones: 2, banos: 1, superficie: 82, garaje: false, piscina: false, terraza: false
};
const expected = {
  externalId: control, titulo: "Control prueba REAPPEARED",
  descripcion: "Registro de control temporal para prueba REAPPEARED CRM.",
  tipoOperacion: "venta", precio: 226000, direccion: "Dirección de control REAPPEARED",
  localidad: "Rota", provincia: "Cádiz", codigoPostal: "11520",
  tipoInmueble: "piso", estado: "segunda_mano", estadoComercial: "Disponible",
  habitaciones: 1, banos: 1, superficie: 61, garaje: false, piscina: false, terraza: false
};

test("REAPPEARED scenario keeps the exact public path and valid XML", () => {
  assert.ok(fs.existsSync(url));
  assert.equal(XMLValidator.validate(xml), true);
  assert.equal(new URL(`/${path.slice("public/".length)}`, "https://www.homeclick24.com").href,
    "https://www.homeclick24.com/test-sync-reappeared-ui/homeclick24-reappeared-ui.xml");
});
test("REAPPEARED scenario contains exactly the unique target and control, without old test identities", () => {
  const preview = analyzeGenericXml(xml);
  assert.equal(preview.length, 2);
  assert.deepEqual(preview.map(p => p.externalId), [target, control]);
  assert.equal(new Set(preview.map(p => p.externalId)).size, 2);
  assert.doesNotMatch(xml, /SYNC-(?:MISSING|NEW|APPLY|DEMO)|HC24-DEMO|test-sync-(?:missing|new|apply)/);
});
test("complete snapshot has exact target and control fields and no invalid data", () => {
  const snapshot = buildSyncSnapshot(xml);
  assert.equal(snapshot.snapshotComplete, true);
  assert.deepEqual(snapshot.warnings, []);
  assert.equal(snapshot.properties.length, 2);
  assert.ok(snapshot.properties.every(item => item.errors.length === 0));
  assert.deepEqual(snapshot.properties[0].data, targetExpected);
  assert.deepEqual(snapshot.properties[1].data, expected);
});
test("both records are publishable using the real Phase 2 validator", () => {
  for (const preview of analyzeGenericXml(xml)) {
    const validated = validateImportProperty(preview);
    assert.deepEqual(preview.errors, []);
    assert.deepEqual(validated.errors, []);
  }
  const diff = compareSyncSnapshot(buildSyncSnapshot(xml), []);
  assert.equal(diff.newCount, 2);
  assert.ok(diff.results.every(item => item.publishableByData === true));
});
test("neither record has photos, video, coordinates or embedded resources", () => {
  for (const preview of analyzeGenericXml(xml)) {
    assert.deepEqual(preview.fotos, []);
    assert.equal(preview.lat, null); assert.equal(preview.lng, null);
  }
  assert.doesNotMatch(xml, /<(?:images?|photos?|video|videoUrl|lat|lng|latitude|longitude)\b|https?:\/\//i);
});
test("Phase 2 mapper and creation helper preserve snapshot semantics without persistence", () => {
  for (const preview of analyzeGenericXml(xml)) {
    const validated = validateImportProperty(preview);
    assert.deepEqual(validated.errors, []);
    const created = buildPropiedadCreateData(validated.data, { plan: "vip", imagenes: [] });
    const expectedRecord = preview.externalId === target ? targetExpected : expected;
    for (const [field, value] of Object.entries(expectedRecord)) {
      if (field !== "externalId") assert.deepEqual(created[field], value, field);
    }
    assert.deepEqual(created.imagenes, []);
    assert.equal(created.videoUrl, "");
    assert.deepEqual(managedChangedFields(created, expectedRecord), []);
  }
});
test("served control matches the documented MISSING scenario", () => {
  const doc = fs.readFileSync(new URL("../docs/CRM_SYNC_REAPPEARED_UI_TEST.md", import.meta.url), "utf8");
  const controlXml = doc.match(/```xml\n([\s\S]*?)\n```/)[1];
  const snapshot = buildSyncSnapshot(controlXml);
  assert.equal(snapshot.snapshotComplete, true);
  assert.equal(snapshot.properties.length, 1);
  const data = snapshot.properties[0].data;
  assert.deepEqual(data, buildSyncSnapshot(xml).properties.find(item => item.data.externalId === control).data);
  assert.equal(data.externalId, control);
  assert.equal(data.titulo, "Control prueba REAPPEARED");
  assert.equal(data.precio, 226000); assert.equal(data.habitaciones, 1); assert.equal(data.banos, 1);
  assert.equal(data.superficie, 61); assert.equal(data.localidad, "Rota"); assert.equal(data.provincia, "Cádiz");
  assert.equal(data.tipoInmueble, "piso"); assert.equal(data.estado, "segunda_mano");
  assert.deepEqual(analyzeGenericXml(controlXml)[0].fotos, []);
  assert.deepEqual(validateImportProperty(analyzeGenericXml(controlXml)[0]).errors, []);
  assert.ok(!controlXml.includes(target));
});

test("reintroduced target is byte-identical and semantically identical to the original BASE", () => {
  const blocks = xml.match(/  <property>[\s\S]*?  <\/property>/g);
  assert.equal(blocks.filter(block => block.includes(`<externalId>${target}</externalId>`)).length, 1);
  assert.equal(blocks.find(block => block.includes(`<externalId>${target}</externalId>`)), baselineBlock);
  const baseline = buildSyncSnapshot(baselineXml).properties[0].data;
  const current = buildSyncSnapshot(xml).properties.find(item => item.data.externalId === target).data;
  assert.deepEqual(current, baseline);
  assert.deepEqual(managedChangedFields(baseline, current), []);
  assert.deepEqual(analyzeGenericXml(xml).find(item => item.externalId === target), analyzeGenericXml(baselineXml)[0]);
});
