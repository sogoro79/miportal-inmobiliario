import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";
import Propiedad from "../models/Propiedad.js";
import { propiedadCrmCreateSchema, propiedadUpdateSchema } from "../utils/propertySchemas.js";
import { buildPropiedadCreateData } from "../utils/propertyCreation.js";
import { capturePropertyContent, markManualContentChanges } from "../utils/propertyContent.js";
import { analyzeInmowebXml } from "../utils/import/adapters/inmoweb.js";
import { evaluateInmowebNewEligibility } from "../utils/import/inmowebNewEligibility.js";
import { safeInmowebPreview } from "../utils/import/inmowebPreview.js";
import { analyzeGenericXml } from "../utils/importers/genericXmlImporter.js";
import { validateImportProperty } from "../utils/import/selectedImport.js";
import { buildSyncSnapshot, syncFingerprint, SYNC_FIELDS } from "../utils/import/syncSnapshot.js";
import { compareSyncSnapshot } from "../utils/import/syncDiff.js";
import { managedFingerprint } from "../utils/import/syncBaseline.js";

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const fixture = read("tests/fixtures/crm/inmoweb-synthetic.xml");
const base = { titulo: "Casa de prueba", precio: 200000, tipoOperacion: "venta", habitaciones: 2, direccion: "Calle Test" };

for (const condition of ["obra_nueva", "segunda_mano", "no_informado"]) test(`condition persists explicitly: ${condition}`, async () => {
  const data = buildPropiedadCreateData(propiedadCrmCreateSchema.parse({ ...base, estado: condition }), { source: "crm" });
  const doc = new Propiedad(data); await doc.validate();
  assert.equal(doc.estado, condition);
});
test("only new documents materialize unknown; hydrated legacy absence and persisted values stay unchanged", async () => {
  const fresh = new Propiedad(base); await fresh.validate(); assert.equal(fresh.estado, "no_informado");
  assert.equal(buildPropiedadCreateData(base).estado, "no_informado");
  for (const estado of [undefined, "obra_nueva", "segunda_mano"]) {
    const legacy = Propiedad.hydrate({ ...base, ...(estado === undefined ? {} : { estado }) });
    legacy.descripcion = "Editada"; await legacy.validate();
    assert.equal(legacy.estado, estado);
    assert.equal(legacy.isModified("estado"), false);
  }
});
test("empty/null and unrecognized explicit conditions are not alternative unknown representations", async () => {
  for (const estado of [null, "", "constructor", "unknown"]) {
    assert.equal(propiedadCrmCreateSchema.safeParse({ ...base, estado }).success, false);
    await assert.rejects(new Propiedad({ ...base, estado }).validate());
  }
});

for (const [raw, expected] of [["ON", "obra_nueva"], ["SM", "segunda_mano"], ["", "no_informado"]]) test(`InmoWeb ${raw || "absent"} maps to ${expected} without guessing`, () => {
  const xml = fixture.replace('<estado id="SM"/>', raw ? `<estado id="${raw}"/>` : "");
  const analyzed = analyzeInmowebXml(xml), p = analyzed.properties[0];
  assert.equal(p.estado, expected); assert.equal(p.publishableByData, true);
  assert.equal(evaluateInmowebNewEligibility(p).eligible, true);
  const safe = safeInmowebPreview(analyzed);
  assert.equal(safe.properties[0].estado, expected);
  if (!raw) {
    assert.ok(p.warnings.includes("INMOWEB_CONDITION_UNKNOWN"));
    assert.ok(!p.errors.includes("INMOWEB_CONDITION_UNKNOWN"));
    const issue = safe.properties[0].issues.find(i => i.code === "INMOWEB_CONDITION_UNKNOWN");
    assert.equal(issue.severity, "warning");
    assert.equal(issue.message, "El proveedor no informa si el inmueble es obra nueva o segunda mano.");
  }
  assert.equal(safe.previewOnly, true);
  for (const flag of ["importEnabled", "syncEnabled", "puedePublicarAhora", "snapshotComplete"]) assert.equal(safe[flag], false);
});
test("structured building/reform hints never infer a missing condition; invalid condition IDs still block", () => {
  for (const hint of ["En buen estado", "Obra nueva", "Reformado en 2024"]) {
    const xml = fixture.replace('<estado id="SM"/>', '<estado/>').replace('Datos inventados exclusivamente para tests.', hint);
    assert.equal(analyzeInmowebXml(xml).properties[0].estado, "no_informado");
  }
  const invalid = analyzeInmowebXml(fixture.replace('<estado id="SM"/>', '<estado id="constructor"/>')).properties[0];
  assert.equal(invalid.publishableByData, false);
  assert.ok(invalid.errors.includes("INMOWEB_UNSUPPORTED_CONDITION"));
});

const feed = estado => `<properties><property><id>A</id><title>Casa de prueba</title><operation>sale</operation><price>200000</price><address>Calle Test</address><bedrooms>2</bedrooms>${estado === undefined ? "" : `<condition>${estado}</condition>`}</property></properties>`;
test("generic imports without condition explicitly create unknown, while legacy snapshots retain absence", () => {
  const mapped = analyzeGenericXml(feed())[0];
  assert.equal(mapped.estado, "no_informado");
  const validation = validateImportProperty(mapped); assert.deepEqual(validation.errors, []);
  assert.equal(buildPropiedadCreateData(validation.data, { source: "crm" }).estado, "no_informado");
  const snapshot = buildSyncSnapshot(feed()); assert.equal(snapshot.snapshotComplete, true);
  const data = snapshot.properties[0].data;
  assert.equal(Object.hasOwn(data, "estado"), false);
  const oldValues = SYNC_FIELDS.filter(f => Object.hasOwn(data, f)).map(f => [f, data[f]]);
  const oldHash = crypto.createHash("sha256").update(JSON.stringify({ version: 1, values: oldValues })).digest("hex");
  assert.equal(syncFingerprint(data), oldHash);
  assert.equal(managedFingerprint(data), managedFingerprint({ ...data, estado: "no_informado" }));
});
for (const estado of ["segunda_mano", "obra_nueva"]) test(`unknown to ${estado} changes snapshot diff and content revision without rewriting baseline`, () => {
  const previous = buildSyncSnapshot(feed("no_informado")).properties[0].data;
  const next = buildSyncSnapshot(feed(estado)); assert.equal(next.snapshotComplete, true);
  const baseline = syncFingerprint(previous);
  assert.notEqual(syncFingerprint(next.properties[0].data), baseline);
  const property = { ...previous, source: "crm", syncEnabled: true, syncFingerprint: baseline, contentRevision: 3 };
  const result = compareSyncSnapshot(next, [property]).results[0];
  assert.equal(result.type, "UPDATE"); assert.deepEqual(Object.keys(result.changes), ["estado"]);
  const before = capturePropertyContent(property);
  Object.assign(property, propiedadUpdateSchema.parse({ estado }));
  assert.deepEqual(markManualContentChanges(property, before), ["estado"]);
  assert.equal(property.contentRevision, 4); assert.deepEqual(property.syncOverrides, { estado: true });
  assert.equal(property.syncFingerprint, baseline);
});

test("public detail omits unknown condition and SEO does not invent an item condition", () => {
  const scripts = [], container = { innerHTML: "" };
  const context = vm.createContext({ URLSearchParams, window: { location: { search: "" }, addEventListener() {} },
    document: { addEventListener() {}, querySelector: () => null, getElementById: id => id === "contenedor" ? container : null,
      createElement: () => ({}), head: { appendChild: script => scripts.push(script) } } });
  for (const file of ["public-location", "precios", "propiedad"]) vm.runInContext(read(`public/js/${file}.js`), context);
  context.input = { ...base, _id: "test", estado: "no_informado", imagenes: [] };
  vm.runInContext("propiedad = input; fotos = []; actualizarSEO();", context);
  const schema = JSON.parse(scripts.find(s => s.id === "schema-propiedad").textContent);
  assert.equal(schema.itemCondition, undefined); assert.equal(schema.offers.itemCondition, undefined);
  // Evaluate the real condition expression without invoking unrelated gallery/contact dependencies.
  const expression = read("public/js/propiedad.js").match(/const estadoPropiedad = (.*);/)[1];
  assert.equal(vm.runInContext(expression, context), "");
});
