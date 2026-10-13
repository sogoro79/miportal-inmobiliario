import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { XMLValidator } from "fast-xml-parser";
import { analyzeGenericXml } from "../utils/importers/genericXmlImporter.js";
import { buildSyncSnapshot } from "../utils/import/syncSnapshot.js";
import { compareSyncSnapshot } from "../utils/import/syncDiff.js";
import { validateImportProperty } from "../utils/import/selectedImport.js";
import { buildPropiedadCreateData } from "../utils/propertyCreation.js";
import { managedFingerprint } from "../utils/import/syncBaseline.js";
import { prepareSyncPlan } from "../utils/import/syncPlan.js";

const xml = fs.readFileSync(new URL("../public/test-sync-missing-ui/homeclick24-missing-ui.xml", import.meta.url), "utf8");
const EXTERNAL_ID = "SYNC-MISSING-UI-001";
const U = "000000000000000000000001", S = "000000000000000000000002", P = "000000000000000000000003";
const expected = {
  titulo: "Piso prueba UI MISSING en Rota", precio: 219000, tipoOperacion: "venta",
  direccion: "Dirección ficticia de prueba UI MISSING", localidad: "Rota", provincia: "Cádiz",
  tipoInmueble: "piso", estado: "segunda_mano", habitaciones: 2, banos: 1,
  superficie: 80, terraza: true, garaje: false, piscina: false
};
function created() {
  const validation = validateImportProperty(analyzeGenericXml(xml)[0]);
  assert.deepEqual(validation.errors, []);
  assert.ok(validation.data);
  return buildPropiedadCreateData(validation.data, { usuarioId: U, plan: "vip" });
}

test("UI MISSING BASE is valid XML with exactly one complete, publicable record", () => {
  assert.equal(XMLValidator.validate(xml), true);
  const snapshot = buildSyncSnapshot(xml), mapped = analyzeGenericXml(xml);
  assert.equal(snapshot.snapshotComplete, true);
  assert.equal(snapshot.properties.length, 1);
  assert.equal(mapped.length, 1);
  assert.equal(snapshot.properties[0].data.externalId, EXTERNAL_ID);
  assert.equal(mapped[0].externalId, EXTERNAL_ID);
  const diff = compareSyncSnapshot(snapshot, []);
  assert.equal(diff.results.length, 1);
  assert.equal(diff.results[0].publishableByData, true);
});
test("Fase 2 creation and snapshot agree on all intended semantic fields", () => {
  const property = created(), data = buildSyncSnapshot(xml).properties[0].data;
  for (const [field, value] of Object.entries(expected)) {
    assert.equal(property[field], value, field);
    assert.equal(data[field], value, field);
  }
  assert.equal(property.descripcion, data.descripcion);
  assert.match(property.descripcion, /Datos ficticios exclusivos/);
});
test("BASE has no photos, video, coordinates, external resources or real user IDs", () => {
  assert.deepEqual(analyzeGenericXml(xml)[0].fotos, []);
  const property = created();
  assert.deepEqual(property.imagenes, []);
  assert.equal(property.videoUrl, "");
  assert.equal(property.lat, null);
  assert.equal(property.lng, null);
  assert.doesNotMatch(xml, /https?:\/\/|[a-f0-9]{24}|@|usuarioId|ownerId|importSourceId|<images|<video/i);
});
test("unchanged enrolled BASE results in UNCHANGED linked, never MISSING", () => {
  const property = { ...created(), _id: P, usuarioId: U, importSourceId: S, source: "crm",
    externalId: EXTERNAL_ID, visiblePublicamente: true, syncEnabled: true, syncOverrides: {},
    contentRevision: 0, syncApplyFingerprintVersion: 1 };
  property.syncApplyFingerprint = managedFingerprint(property);
  const plan = prepareSyncPlan(buildSyncSnapshot(xml), [property],
    { usuarioId: U, importSourceId: S, reconciliations: [] });
  assert.equal(plan.plan.length, 1);
  assert.equal(plan.plan[0].externalId, EXTERNAL_ID);
  assert.equal(plan.plan[0].type, "UNCHANGED");
  assert.equal(plan.plan[0].linked, true);
  assert.equal(plan.missingCount, 0);
});
