import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { canonicalizeInmowebTitle } from "../utils/import/inmowebTitle.js";
import { analyzeInmowebXml } from "../utils/import/adapters/inmoweb.js";
import { evaluateInmowebNewEligibility } from "../utils/import/inmowebNewEligibility.js";
import { safeInmowebPreview } from "../utils/import/inmowebPreview.js";

const fixture = fs.readFileSync(new URL("./fixtures/crm/inmoweb-synthetic.xml", import.meta.url), "utf8");
const longTitle = "Texto comercial que no debe formar parte del título canónico. ".repeat(4);
const base = { titulo: longTitle, tipoInmueble: "casa_campo", tipoOperacion: "venta", localidad: "Chipiona", provincia: "Cádiz" };

for (const titulo of ["Título intacto", "a".repeat(160)]) test(`short title preserved exactly (${titulo.length})`, () => {
  assert.deepEqual(canonicalizeInmowebTitle({ ...base, titulo }), { titulo, normalized: false });
});

for (const [name, change, expected] of [
  ["locality", {}, "Casa de campo en venta en Chipiona"],
  ["zone and locality", { zona: "Montijo" }, "Casa de campo en venta en Montijo, Chipiona"],
  ["duplicate zone", { zona: " CHIPIONA " }, "Casa de campo en venta en Chipiona"],
  ["duplicate province", { localidad: "Rota", provincia: "Rota", zona: "Rota" }, "Casa de campo en venta en Rota"],
  ["province fallback", { localidad: "", provincia: "Cádiz" }, "Casa de campo en venta en Cádiz"],
  ["long zone fallback", { zona: "z".repeat(200) }, "Casa de campo en venta en Chipiona"],
  ["long locality fallback", { localidad: "x".repeat(200) }, "Casa de campo en venta en Cádiz"],
  ["shortest fallback", { localidad: "x".repeat(200), provincia: "y".repeat(200) }, "Casa de campo en venta"],
  ["rental", { tipoOperacion: "alquiler" }, "Casa de campo en alquiler en Chipiona"],
  ["second long case", { localidad: "Arroyomolinos de León", provincia: "Huelva" }, "Casa de campo en venta en Arroyomolinos de León"]
]) test(`structured title: ${name}`, () => {
  const input = { ...base, ...change, descripcion: "Ideal para camping con licencias y vistas al mar" };
  const before = structuredClone(input);
  const result = canonicalizeInmowebTitle(input);
  assert.deepEqual(result, { titulo: expected, normalized: true });
  assert.ok(result.titulo.length <= 160);
  assert.deepEqual(canonicalizeInmowebTitle(input), result);
  assert.deepEqual(input, before);
  assert.doesNotMatch(result.titulo, /camping|licencias|vistas|Texto comercial/);
});

for (const change of [{ localidad: "", provincia: "", zona: "Centro" }, { tipoInmueble: "constructor" }, { tipoOperacion: "vacacional" }]) {
  test(`unreliable structured fields do not fabricate a title: ${JSON.stringify(change)}`, () => {
    assert.deepEqual(canonicalizeInmowebTitle({ ...base, ...change }), { titulo: longTitle, normalized: false });
  });
}

for (const locality of ["Chipiona", "Arroyomolinos de León"]) test(`adapter, eligibility and safe preview agree for long title in ${locality}`, () => {
  const xml = fixture.replace("Piso sintético", longTitle).replace('<familia id="24">', '<familia id="16">')
    .replace("Municipio ficticio", locality).replace("Zona ficticia", "");
  const analyzed = analyzeInmowebXml(xml);
  const p = analyzed.properties[0];
  const expected = `Casa de campo en venta en ${locality}`;
  assert.equal(p.titulo, expected);
  assert.equal(p.metadata.traducciones.es.titulo, longTitle.trim());
  assert.equal(p.publishableByData, true);
  assert.deepEqual(p.errors, []);
  assert.ok(p.warnings.includes("INMOWEB_TITLE_NORMALIZED"));
  const direct = evaluateInmowebNewEligibility({ ...p, titulo: longTitle });
  assert.equal(direct.eligible, true);
  assert.ok(direct.warnings.includes("INMOWEB_TITLE_NORMALIZED"));
  const preview = safeInmowebPreview(analyzed);
  assert.equal(preview.properties[0].titulo, expected);
  assert.equal(preview.properties[0].futureNewEligible, true);
  assert.ok(preview.properties[0].issues.some(i => i.code === "INMOWEB_TITLE_NORMALIZED" && i.severity === "warning"));
  assert.equal(preview.previewOnly, true);
  for (const flag of ["importEnabled", "syncEnabled", "puedePublicarAhora", "snapshotComplete"]) assert.equal(preview[flag], false);
  assert.doesNotMatch(JSON.stringify(preview), /Texto comercial|traducciones|metadata/);
});

test("long title with no location remains blocked; missing title is never generated", () => {
  for (const xml of [fixture.replace("Piso sintético", longTitle).replace("Municipio ficticio", "").replace("Provincia ficticia", ""), fixture.replace("Piso sintético", "")]) {
    assert.equal(analyzeInmowebXml(xml).properties[0].publishableByData, false);
  }
});
