import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { evaluateInmowebNewEligibility } from "../utils/import/inmowebNewEligibility.js";
import { analyzeInmowebXml } from "../utils/import/adapters/inmoweb.js";
import { safeInmowebPreview } from "../utils/import/inmowebPreview.js";
import { propiedadCrmCreateSchema } from "../utils/propertySchemas.js";
import { buildPropiedadCreateData } from "../utils/propertyCreation.js";

const xml = fs.readFileSync(new URL("./fixtures/crm/inmoweb-synthetic.xml", import.meta.url), "utf8");
const analyze = value => analyzeInmowebXml(value);
const base = analyze(xml).properties[0];

test("complete sale is future eligible, without authorizing any action", () => {
  assert.deepEqual(evaluateInmowebNewEligibility(base), { eligible: true, blockingIssues: [], warnings: [] });
  const preview = safeInmowebPreview(analyze(xml));
  assert.equal(preview.properties[0].futureNewStatus, "eligible");
  assert.equal(preview.properties[0].futureNewEligible, true);
  for (const flag of ["importEnabled", "syncEnabled", "puedePublicarAhora", "snapshotComplete"]) assert.equal(preview[flag], false);
  assert.equal(preview.previewOnly, true);
});

for (const [name, from, to, code] of [
  ["rental without periodicity", '<operacion id="1">Venta', '<operacion id="2">Alquiler', "INMOWEB_RENT_PERIOD_UNKNOWN"],
  ["empty condition", '<estado id="SM"/>', '<estado/>', "INMOWEB_CONDITION_UNKNOWN"],
  ["missing title", '<titulo>Piso sintético</titulo>', '<titulo/>', "INMOWEB_SPANISH_TITLE_MISSING"],
  ["unknown type", '<familia id="24">', '<familia id="999">', "INMOWEB_UNSUPPORTED_FAMILY"],
  ["missing locality", '<poblacion id="TEST">Municipio ficticio</poblacion>', '<poblacion/>', "INMOWEB_LOCATION_INSUFFICIENT"],
  ["missing bedrooms", '<dormitorios>2</dormitorios>', '<dormitorios/>', "INMOWEB_BEDROOMS_UNKNOWN"]
]) test(`${name} blocks only the affected record`, () => {
  const analyzed = analyze(xml.replace(from, to));
  const result = evaluateInmowebNewEligibility(analyzed.properties[0]);
  assert.equal(result.eligible, false);
  assert.ok(result.blockingIssues.includes(code));
  const p = safeInmowebPreview(analyzed).properties[0];
  assert.equal(p.futureNewEligible, false);
  assert.equal(p.futureNewStatus, "blocked");
  assert.ok(p.issues.some(issue => issue.code === code && issue.severity === "blocking"));
});

for (const price of [0, 1]) test(`price ${price} is preserved with a strong warning, not an invented threshold`, () => {
  const analyzed = analyze(xml.replace('>210000</precio>', `>${price}</precio>`));
  assert.equal(analyzed.properties[0].precio, price);
  const result = evaluateInmowebNewEligibility(analyzed.properties[0]);
  assert.equal(result.eligible, true);
  assert.ok(result.warnings.includes("INMOWEB_PRICE_REVIEW_REQUIRED"));
  assert.equal(safeInmowebPreview(analyzed).properties[0].futureNewStatus, "review");
});

for (const [name, value, code] of [
  ["images", xml.replace(/<imagenes>[\s\S]*?<\/imagenes>/, '<imagenes/>'), "INMOWEB_IMAGES_MISSING"],
  ["bathrooms", xml.replace('<banos>1</banos>', '<banos/>'), "INMOWEB_BATHROOMS_UNKNOWN"],
  ["built area", xml.replace('<construida>90</construida>', '<construida/>'), "INMOWEB_BUILT_AREA_UNKNOWN"]
]) test(`absent optional ${name} warns without inventing a value or blocking`, () => {
  const analyzed = analyze(value);
  const result = evaluateInmowebNewEligibility(analyzed.properties[0]);
  assert.equal(result.eligible, true);
  assert.ok(result.warnings.includes(code));
  assert.equal(analyzed.properties[0].publishableByData, true);
  assert.equal(safeInmowebPreview(analyzed).properties[0].futureNewStatus, "review");
});

test("warnings never override blockers and duplicate IDs remain blocked", () => {
  const p = { ...base, estado: null, precio: 1, errors: ["INMOWEB_DUPLICATE_ID"] };
  const before = structuredClone(p);
  const result = evaluateInmowebNewEligibility(p);
  assert.equal(result.eligible, false);
  assert.ok(result.blockingIssues.includes("INMOWEB_CONDITION_UNKNOWN"));
  assert.ok(result.blockingIssues.includes("INMOWEB_DUPLICATE_ID"));
  assert.ok(result.warnings.includes("INMOWEB_PRICE_REVIEW_REQUIRED"));
  assert.deepEqual(p, before);
});

test("unknown condition is blocked rather than falling through the creation default", () => {
  assert.equal(propiedadCrmCreateSchema.safeParse({ ...base, estado: undefined }).success, true);
  assert.equal(buildPropiedadCreateData({ ...base, estado: undefined }).estado, "segunda_mano");
  assert.equal(evaluateInmowebNewEligibility({ ...base, estado: undefined }).eligible, false);
});

test("explicit zero bedrooms remains valid; malformed optional values still block", () => {
  assert.equal(evaluateInmowebNewEligibility({ ...base, habitaciones: 0 }).eligible, true);
  const p = analyze(xml.replace('<banos>1</banos>', '<banos>invalid</banos>')).properties[0];
  assert.equal(evaluateInmowebNewEligibility(p).eligible, false);
  assert.ok(p.errors.includes("INMOWEB_INVALID_BATHROOMS"));
});

test("existing title length and numeric limits are not bypassed by future eligibility", () => {
  for (const change of [{ titulo: "x".repeat(161) }, { habitaciones: -1 }, { precio: -1 }]) {
    const p = { ...base, ...change };
    assert.equal(evaluateInmowebNewEligibility(p).eligible, false);
  }
});

test("currency and identity remain required without falling back to a reference", () => {
  for (const change of [{ externalId: "" }, { moneda: null }, { moneda: "USD" }]) {
    assert.equal(evaluateInmowebNewEligibility({ ...base, ...change }).eligible, false);
  }
});

test("preview renders all three safe labels without creating action controls", () => {
  const ctx = vm.createContext({ window: {} });
  vm.runInContext(fs.readFileSync(new URL('../public/js/crm-readonly-preview.js', import.meta.url), 'utf8'), ctx);
  for (const [status, label] of [["eligible", "Apto para futura importación"], ["review", "Requiere revisión"], ["blocked", "No apto"]]) {
    const html = ctx.window.HomeClickCrmReadOnlyPreview.rows({ properties: [{ futureNewStatus: status }] });
    assert.ok(html.includes(label));
    assert.doesNotMatch(html, /<input|<button|type="checkbox"/);
  }
});
