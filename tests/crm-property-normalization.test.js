import test from "node:test";
import assert from "node:assert/strict";
import { analyzeGenericXml } from "../utils/importers/genericXmlImporter.js";
import { buildSyncSnapshot } from "../utils/import/syncSnapshot.js";
import { validateImportProperty } from "../utils/import/selectedImport.js";
import { buildPropiedadCreateData } from "../utils/propertyCreation.js";

const feed = (type, condition) => `<properties><property><id>A</id><title>Casa</title><price>210000</price>
  <operation>sale</operation><address>Chipiona</address><bedrooms>2</bedrooms>
  <propertyType>${type}</propertyType>${condition === undefined ? "" : `<condition>${condition}</condition>`}
  </property></properties>`;

for (const [type, condition, expectedType, expectedCondition] of [
  ["house", "new", "casa", "obra_nueva"],
  ["apartment", "used", "apartamento", "segunda_mano"],
  ["flat", "second-hand", "piso", "segunda_mano"],
  ["country_house", "resale", "casa_campo", "segunda_mano"],
  ["Casa de campo", "OBRA NUEVA", "casa_campo", "obra_nueva"],
  ["piso", "segunda_mano", "piso", "segunda_mano"],
  ["chalet", "second hand", "chalet", "segunda_mano"]
]) test(`Phase 2 creation and snapshot normalize ${type}/${condition} equally`, () => {
  const xml = feed(type, condition), snapshot = buildSyncSnapshot(xml);
  const mapped = analyzeGenericXml(xml)[0], validation = validateImportProperty(mapped);
  assert.equal(snapshot.snapshotComplete, true); assert.deepEqual(validation.errors, []);
  const created = buildPropiedadCreateData(validation.data);
  for (const [field, expected] of [["tipoInmueble", expectedType], ["estado", expectedCondition]]) {
    assert.equal(snapshot.properties[0].data[field], expected);
    assert.equal(created[field], expected);
  }
});

test("absent condition stays omitted; manual and Phase 2 creation retain second-hand default", () => {
  const xml = feed("house"), snapshot = buildSyncSnapshot(xml), mapped = analyzeGenericXml(xml)[0];
  assert.equal(Object.hasOwn(snapshot.properties[0].data, "estado"), false);
  assert.equal(Object.hasOwn(mapped, "estado"), false);
  assert.equal(buildPropiedadCreateData(validateImportProperty(mapped).data).estado, "segunda_mano");
  assert.equal(buildPropiedadCreateData({ tipoInmueble: "casa", habitaciones: 2, precio: 1 }).estado, "segunda_mano");
});

test("unknown type retains legacy Phase 2 fallback, but sync marks it invalid", () => {
  const xml = feed("unknown_type", "used"), mapped = analyzeGenericXml(xml)[0], snapshot = buildSyncSnapshot(xml);
  assert.equal(mapped.tipoInmueble, "piso");
  assert.equal(snapshot.snapshotComplete, false);
  assert.ok(snapshot.properties[0].errors.includes("INVALID_tipoInmueble"));
});

for (const value of ["unknown_condition", "constructor", "__proto__", "prototype", "toString", "valueOf", ""]) {
  test(`explicit invalid condition ${JSON.stringify(value)} is never defaulted silently`, () => {
    const xml = feed("house", value), mapped = analyzeGenericXml(xml)[0], snapshot = buildSyncSnapshot(xml);
    assert.equal(snapshot.snapshotComplete, false);
    assert.ok(snapshot.properties[0].errors.includes("INVALID_estado"));
    assert.ok(validateImportProperty(mapped).errors.length > 0);
    assert.equal(Object.hasOwn(mapped, "estado"), false);
  });
}

test("case-insensitive type/condition tags agree with snapshot", () => {
  const xml = feed("house", "new").replaceAll("propertyType", "PROPERTYTYPE").replaceAll("condition", "CONDITION");
  const snapshot = buildSyncSnapshot(xml), mapped = analyzeGenericXml(xml)[0];
  assert.equal(mapped.tipoInmueble, snapshot.properties[0].data.tipoInmueble);
  assert.equal(mapped.estado, snapshot.properties[0].data.estado);
});
