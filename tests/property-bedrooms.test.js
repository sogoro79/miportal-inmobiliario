import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";
import Propiedad from "../models/Propiedad.js";
import { bedroomCreateData, applyBedroomEdit, bedroomDataValid } from "../utils/bedrooms.js";
import { propiedadCreateSchema, propiedadCrmCreateSchema } from "../utils/propertySchemas.js";
import { buildPropiedadCreateData } from "../utils/propertyCreation.js";
import { priceAlertFilter } from "../utils/pricePeriod.js";
import { analyzeInmowebXml } from "../utils/import/adapters/inmoweb.js";
import { safeInmowebPreview } from "../utils/import/inmowebPreview.js";
import { analyzeGenericXml } from "../utils/importers/genericXmlImporter.js";
import { validateImportProperty } from "../utils/import/selectedImport.js";
import { buildSyncSnapshot, syncFingerprint } from "../utils/import/syncSnapshot.js";
import { compareSyncSnapshot } from "../utils/import/syncDiff.js";
import { managedFingerprint, validManagedData } from "../utils/import/syncBaseline.js";
import { missingContentFingerprint } from "../utils/import/missingEligibility.js";
import { CONTENT_FIELDS, capturePropertyContent, markManualContentChanges } from "../utils/propertyContent.js";

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const base = { titulo: "Prueba", precio: 100000, tipoOperacion: "venta", tipoInmueble: "piso", direccion: "Calle Test" };
const fixture = read("tests/fixtures/crm/inmoweb-synthetic.xml");
for (const habitaciones of [0, 1, 3]) test(`explicit ${habitaciones} persists as informed, never unknown`, async () => {
  const data = buildPropiedadCreateData(propiedadCreateSchema.parse({ ...base, habitaciones }));
  assert.equal(data.habitaciones, habitaciones); assert.equal(data.habitacionesEstado, "informado");
  const doc = new Propiedad(data); await doc.validate(); assert.equal(doc.habitaciones, habitaciones);
});
test("missing CRM/model bedrooms are explicitly unknown without Number(null) or default zero", async () => {
  const data = buildPropiedadCreateData(propiedadCrmCreateSchema.parse(base), { source: "crm" });
  assert.deepEqual(bedroomCreateData({}), { habitaciones: null, habitacionesEstado: "desconocido" });
  assert.equal(data.habitaciones, null); assert.equal(data.habitacionesEstado, "desconocido");
  const model = new Propiedad(base); await model.validate(); assert.equal(model.habitaciones, null);
  assert.equal(model.habitacionesEstado, "desconocido");
  assert.deepEqual(bedroomCreateData({ habitaciones: "0" }), { habitaciones: 0, habitacionesEstado: "informado" });
});
test("legacy numeric zero and absent fields remain unchanged by hydration and partial editing", async () => {
  for (const habitaciones of [undefined, 0, 3]) {
    const model = Propiedad.hydrate({ ...base, ...(habitaciones === undefined ? {} : { habitaciones }) });
    applyBedroomEdit(model, { descripcion: "Nueva" }); await model.validate();
    assert.equal(model.habitaciones, habitaciones); assert.equal(model.habitacionesEstado, undefined);
    assert.equal(model.isModified("habitacionesEstado"), false);
  }
});
for (const tipoInmueble of ["piso", "estudio", "casa", "casa_campo"]) test(`manual ${tipoInmueble} still requires a numeric decision`, () => {
  assert.equal(propiedadCreateSchema.safeParse({ ...base, tipoInmueble }).success, false);
  assert.equal(propiedadCreateSchema.safeParse({ ...base, tipoInmueble, habitaciones: null, habitacionesEstado: "desconocido" }).success, false);
  assert.equal(propiedadCreateSchema.safeParse({ ...base, tipoInmueble, habitaciones: 0 }).success, true);
});
for (const tipoInmueble of ["local", "oficina", "nave", "terreno", "solar_urbano", "parcela", "garaje", "plaza_aparcamiento", "trastero"]) {
  test(`${tipoInmueble} permits explicit non-applicable`, async () => {
    const data = propiedadCreateSchema.parse({ ...base, tipoInmueble, habitacionesEstado: "no_aplicable" });
    const doc = new Propiedad(buildPropiedadCreateData(data)); await doc.validate();
    assert.equal(doc.habitaciones, null); assert.equal(doc.habitacionesEstado, "no_aplicable");
  });
}
test("finca rustica is not automatically non-applicable; contradictory states and invalid numbers reject", () => {
  const p = { ...base, tipoInmueble: "finca_rustica", habitaciones: null, habitacionesEstado: "desconocido" };
  assert.equal(propiedadCrmCreateSchema.safeParse(p).success, true);
  for (const change of [{ habitacionesEstado: "no_aplicable" }, { habitaciones: 0 }, { habitacionesEstado: "informado" },
    { habitaciones: -1, habitacionesEstado: "informado" }, { habitaciones: 1.5, habitacionesEstado: "informado" }]) {
    assert.equal(propiedadCrmCreateSchema.safeParse({ ...p, ...change }).success, false);
  }
});
test("InmoWeb finca with absent bedrooms becomes eligible with warning, no residential inference", () => {
  const result = analyzeInmowebXml(fixture.replace('<familia id="24">', '<familia id="9">').replace('<dormitorios>2</dormitorios>', '<dormitorios/>'));
  const p = result.properties[0]; assert.equal(p.habitaciones, null); assert.equal(p.habitacionesEstado, "desconocido");
  assert.equal(p.publishableByData, true); assert.ok(p.warnings.includes("INMOWEB_BEDROOMS_UNKNOWN"));
  const safe = safeInmowebPreview(result); assert.equal(safe.properties[0].futureNewEligible, true);
  assert.equal(safe.properties[0].issues.find(i => i.code === "INMOWEB_BEDROOMS_UNKNOWN").severity, "warning");
  assert.equal(safe.previewOnly, true); assert.equal(safe.importEnabled, false); assert.equal(safe.syncEnabled, false);
});
const feed = value => `<properties><property><id>A</id><title>Prueba</title><operation>sale</operation><price>100000</price><address>Calle Test</address>${value}</property></properties>`;
test("generic absence is unknown; explicit zero remains zero; malformed numbers do not become zero", () => {
  for (const [xml, rooms, state] of [[feed(""), null, "desconocido"], [feed('<bedrooms>0</bedrooms>'), 0, "informado"],
    [feed('<bedrooms>2</bedrooms>'), 2, "informado"]]) {
    const p = analyzeGenericXml(xml)[0]; assert.equal(p.habitaciones, rooms); assert.equal(p.habitacionesEstado, state);
    const valid = validateImportProperty(p); assert.deepEqual(valid.errors, []);
    assert.equal(buildPropiedadCreateData(valid.data, { source: "crm" }).habitaciones, rooms);
  }
  assert.ok(validateImportProperty(analyzeGenericXml(feed('<bedrooms>invalid</bedrooms>'))[0]).errors.length);
});
test("partial edits preserve unknown; explicit numbers replace it and create one effective revision", () => {
  const property = { ...base, source: "crm", syncEnabled: true, habitaciones: null, habitacionesEstado: "desconocido", contentRevision: 2 };
  applyBedroomEdit(property, { descripcion: "Nueva" }); assert.equal(property.habitaciones, null);
  const before = capturePropertyContent(property); applyBedroomEdit(property, { habitaciones: 3 });
  assert.equal(property.habitacionesEstado, "informado");
  assert.deepEqual(markManualContentChanges(property, before), ["habitaciones", "habitacionesEstado"]);
  assert.equal(property.contentRevision, 3);
  applyBedroomEdit(property, { habitacionesEstado: "desconocido" }); assert.equal(property.habitaciones, null);
});
test("snapshots require explicit state for new nullable contract and detect unknown <-> number", () => {
  const unknown = buildSyncSnapshot(feed('<habitacionesEstado>desconocido</habitacionesEstado>'));
  const known = buildSyncSnapshot(feed('<bedrooms>3</bedrooms><habitacionesEstado>informado</habitacionesEstado>'));
  assert.equal(unknown.snapshotComplete, true); assert.equal(known.snapshotComplete, true);
  for (const [a, b] of [[unknown, known], [known, unknown]]) {
    const p = { ...a.properties[0].data, syncEnabled: true };
    assert.equal(compareSyncSnapshot(b, [p]).results[0].type, "UPDATE");
    assert.notEqual(syncFingerprint(p), syncFingerprint(b.properties[0].data));
    assert.notEqual(managedFingerprint(p), managedFingerprint(b.properties[0].data));
    assert.equal(validManagedData(p), true);
  }
  assert.equal(buildSyncSnapshot(feed('<bedrooms/>')).snapshotComplete, false);
  for (const value of ["invalid", "-1", "1.5"]) {
    assert.equal(buildSyncSnapshot(feed(`<bedrooms>${value}</bedrooms><habitacionesEstado>desconocido</habitacionesEstado>`)).snapshotComplete, false);
  }
});
test("legacy snapshot, managed and MISSING fingerprints remain unchanged without state", () => {
  const p = buildSyncSnapshot(feed('<bedrooms>0</bedrooms>')).properties[0].data;
  assert.equal(Object.hasOwn(p, "habitacionesEstado"), false);
  const oldFields = CONTENT_FIELDS.filter(f => !["ubicacionPublica", "precisionUbicacion", "periodicidadPrecio", "habitacionesEstado"].includes(f));
  const old = crypto.createHash("sha256").update(JSON.stringify(oldFields.map(f => [f, p[f] === undefined ? ["absent"] : ["value", p[f]]]))).digest("hex");
  assert.equal(missingContentFingerprint(p), old);
  assert.equal(managedFingerprint(p), managedFingerprint({ ...p, habitacionesEstado: "informado" }));
});
function matches(query, doc) {
  return Object.entries(query).every(([key, value]) => key === "$and" ? value.every(q => matches(q, doc))
    : key === "$or" ? value.some(q => matches(q, doc)) : value && typeof value === "object"
      ? Object.entries(value).every(([op, n]) => op === "$exists" ? (doc[key] !== undefined) === n
        : op === "$lte" ? typeof doc[key] === "number" && doc[key] <= n : op === "$gte" ? doc[key] >= n : false)
      : value === null ? doc[key] == null : doc[key] === value);
}
test("unknown/non-applicable never satisfies a positive bedroom alert, but no minimum is allowed", () => {
  for (const habitaciones of [null, undefined, 0, 3]) {
    const filter = priceAlertFilter({ tipoOperacion: "venta", precio: 100, habitaciones });
    for (const min of [undefined, null, 0, 1, 2, 4]) {
      const alert = { activa: true, tipoOperacion: "venta", precioMax: 200, ...(min === undefined ? {} : { habitaciones: min }) };
      assert.equal(matches(filter, alert), min == null || min === 0 || typeof habitaciones === "number" && min <= habitaciones);
    }
  }
});
for (const [habitaciones, state, expected] of [[null, "desconocido", undefined], [null, "no_aplicable", undefined], [0, "informado", 0], [3, "informado", 3]]) {
  test(`SEO bedrooms ${state}/${habitaciones}: no fabricated rooms`, () => {
    const scripts = [];
    const ctx = vm.createContext({ URLSearchParams, window: { location: { search: "" }, addEventListener() {} },
      document: { addEventListener() {}, querySelector: () => null, getElementById: () => null, createElement: () => ({}), head: { appendChild: s => scripts.push(s) } },
      input: { ...base, habitaciones, habitacionesEstado: state } });
    for (const file of ["public-location", "precios", "propiedad"]) vm.runInContext(read(`public/js/${file}.js`), ctx);
    vm.runInContext("propiedad = input; fotos = []; actualizarSEO();", ctx);
    const schema = JSON.parse(scripts.find(s => s.id === "schema-propiedad").textContent);
    assert.equal(schema.numberOfRooms, expected);
    assert.equal(Object.hasOwn(schema, "numberOfRooms"), expected !== undefined);
  });
}
