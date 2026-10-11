import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { XMLValidator } from "fast-xml-parser";
import { analyzeGenericXml } from "../utils/importers/genericXmlImporter.js";
import { buildSyncSnapshot } from "../utils/import/syncSnapshot.js";
import { managedFingerprint, managedChangedFields, SYNC_APPLY_V1_FIELDS } from "../utils/import/syncBaseline.js";
import { prepareSyncPlan } from "../utils/import/syncPlan.js";
import { feedHash, validateImportProperty } from "../utils/import/selectedImport.js";
import { buildPropiedadCreateData } from "../utils/propertyCreation.js";

const reference = "SYNC-APPLY-TEST-001";
const ORIGINAL_BASELINE_PRICE = 210000;
const SERVED_PRICE = 225000;
const read = version => fs.readFileSync(new URL(`../public/test-sync-apply/homeclick24-sync-apply-${version}.xml`, import.meta.url), "utf8");
// Retain the original baseline in memory, without another public feed.
const originalXml = () => read("v2").replace(`<precio>${SERVED_PRICE}</precio>`, `<precio>${ORIGINAL_BASELINE_PRICE}</precio>`);
const expectedFields = ["externalId", "titulo", "tipoOperacion", "tipoInmueble", "precio", "localidad", "provincia",
  "codigoPostal", "direccion", "habitaciones", "banos", "superficie", "garaje", "piscina", "terraza", "descripcion"].sort();

for (const [version, price] of [["v1", SERVED_PRICE], ["v2", SERVED_PRICE]]) {
  test(`${version}: XML valid, exactly one importable property and complete sync snapshot`, () => {
    const xml = read(version);
    assert.equal(XMLValidator.validate(xml), true);
    const preview = analyzeGenericXml(xml);
    assert.equal(preview.length, 1);
    assert.equal(preview[0].externalId, reference);
    assert.equal(preview[0].precio, price);
    assert.deepEqual(preview[0].errors, []);
    assert.deepEqual(preview[0].fotos, []);
    assert.deepEqual(validateImportProperty(preview[0]).errors, []);
    const snapshot = buildSyncSnapshot(xml);
    assert.equal(snapshot.snapshotComplete, true);
    assert.equal(snapshot.snapshotCount, 1);
    assert.equal(snapshot.properties.length, 1);
    assert.deepEqual(snapshot.warnings, []);
    assert.deepEqual(snapshot.properties[0].errors, []);
    const { data } = snapshot.properties[0];
    assert.deepEqual(Object.keys(data).sort(), expectedFields);
    assert.deepEqual(data, { externalId: reference, titulo: "Piso de prueba apply CRM en Chipiona",
      tipoOperacion: "venta", tipoInmueble: "piso", precio: price, localidad: "Chipiona", provincia: "Cádiz",
      codigoPostal: "11550", direccion: "Dirección de prueba apply CRM", habitaciones: 2, banos: 1,
      superficie: 75, garaje: false, piscina: false, terraza: true,
      descripcion: "Datos ficticios exclusivos para prueba controlada de apply CRM." });
    assert.ok(!Object.hasOwn(data, "imagenes") && !Object.hasOwn(data, "videoUrl"));
    assert.doesNotMatch(xml, /<(?:imagenes|images|photos|fotos|videoUrl|lat|lng)\b/i);
  });
}

test("stable v1 now serves v2; only price differs from the original internal baseline", () => {
  assert.equal(read("v1"), read("v2"));
  assert.equal(originalXml().replace(`<precio>${ORIGINAL_BASELINE_PRICE}</precio>`, `<precio>${SERVED_PRICE}</precio>`), read("v1"));
  const original = buildSyncSnapshot(originalXml());
  assert.equal(original.snapshotComplete, true);
  assert.equal(original.properties.length, 1);
  const baseline = original.properties[0].data;
  const served = buildSyncSnapshot(read("v1")).properties[0].data;
  assert.equal(baseline.precio, ORIGINAL_BASELINE_PRICE);
  assert.equal(served.precio, SERVED_PRICE);
  assert.deepEqual({ ...baseline, precio: SERVED_PRICE }, served);
  assert.deepEqual(managedChangedFields(baseline, served), ["precio"]);
  assert.notEqual(managedFingerprint(baseline), managedFingerprint(served));
  for (const field of SYNC_APPLY_V1_FIELDS.filter(field => field !== "precio")) {
    assert.deepEqual(baseline[field], served[field]);
  }
});

test("existing import builder is compatible with enrollment, UPDATE precio and final UNCHANGED", () => {
  const snapshot1 = buildSyncSnapshot(originalXml()), snapshot2 = buildSyncSnapshot(read("v1"));
  const validation = validateImportProperty(analyzeGenericXml(originalXml())[0]);
  assert.deepEqual(validation.errors, []);
  const property = { ...buildPropiedadCreateData(validation.data, { usuarioId: "test-owner", plan: "vip", imagenes: [] }),
    _id: "507f1f77bcf86cd799439001", source: "crm", importSourceId: "507f1f77bcf86cd799439002",
    externalId: reference, syncEnabled: true, syncOverrides: {}, contentRevision: 0, syncApplyFingerprintVersion: 1 };
  property.syncApplyFingerprint = managedFingerprint(property);
  assert.equal(property.precio, ORIGINAL_BASELINE_PRICE);
  assert.equal(prepareSyncPlan(snapshot1, [property]).plan[0].type, "UNCHANGED");
  const planned = prepareSyncPlan(snapshot2, [property]).plan[0];
  assert.equal(planned.type, "UPDATE");
  assert.equal(planned.blocked, false);
  assert.deepEqual(planned.changedFields, ["precio"]);
  assert.equal(planned.expectedBaselineFingerprint, property.syncApplyFingerprint);
  const accepted = { ...property, precio: 225000, contentRevision: 1,
    syncApplyFingerprint: planned.proposedBaselineFingerprint };
  assert.equal(accepted.syncApplyFingerprint, managedFingerprint(accepted));
  assert.equal(prepareSyncPlan(snapshot2, [accepted]).plan[0].type, "UNCHANGED");
  assert.deepEqual(accepted.imagenes, []);
  assert.deepEqual(accepted.syncOverrides, {});
});

test("two fixture URLs have different source identities; replacing content at one URL preserves identity", () => {
  const v1 = "https://www.homeclick24.com/test-sync-apply/homeclick24-sync-apply-v1.xml";
  const v2 = "https://www.homeclick24.com/test-sync-apply/homeclick24-sync-apply-v2.xml";
  assert.notEqual(feedHash(v1), feedHash(v2));
  const initialHash = feedHash(v1);
  read("v1"); read("v2");
  assert.equal(feedHash(v1), initialHash);
});
