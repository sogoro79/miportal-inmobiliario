import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { analyzeFeedXml, buildFeedSnapshot } from "../utils/importers/importerRegistry.js";
import { safeInmowebPreview } from "../utils/import/inmowebPreview.js";
import { crearSlugPropiedad } from "../utils/seoSlug.js";
const fixture = fs.readFileSync(new URL("./fixtures/crm/inmoweb-synthetic.xml", import.meta.url), "utf8");
function xml(title, reference = "CV3", description = "Precio: 105.000€[IW]") {
  return fixture.replace("SYNTHETIC-REF-A", reference).replace("Piso sintético", title)
    .replace("Datos inventados exclusivamente para tests.", description);
}
for (const separator of [". ", " - ", ": ", " / "]) test(`literal reference with ${separator} is removed before publication`, () => {
  const source = xml(`CV3${separator}CASA RURAL`);
  const snapshot = buildFeedSnapshot(source, { feedType: "inmoweb" });
  const property = snapshot.properties[0].data;
  assert.equal(property.titulo, "CASA RURAL");
  assert.equal(property.referencia, "CV3"); assert.equal(property.externalId, "0001");
  assert.equal(property.descripcion, "Precio: 105.000€");
  assert.equal(crearSlugPropiedad(property), "casa-rural");
  const preview = safeInmowebPreview(analyzeFeedXml(source, { feedType: "inmoweb" }));
  assert.equal(preview.properties[0].titulo, "CASA RURAL");
});
for (const [title, reference] of [
  ["CASA RURAL CV3", "CV3"], ["CV3. CASA RURAL", "OTHER"],
  ["CV30. CASA RURAL", "CV3"], ["CV3 CASA RURAL", "CV3"],
  ["CV3-123 CASA RURAL", "CV3"], ["CV3.CASA RURAL", "CV3"],
  ["cv3. CASA RURAL", "CV3"], ["CV3.", "CV3"], ["CV3. CASA RURAL", ""]
]) test(`ambiguous or nonmatching reference is preserved: ${title}/${reference}`, () => {
  assert.equal(buildFeedSnapshot(xml(title, reference), { feedType: "inmoweb" }).properties[0].data.titulo, title);
});
test("reference is compared literally, including regex punctuation", () => {
  for (const [title, expected] of [["R+1. CASA", "CASA"], ["RR1. CASA", "RR1. CASA"]]) {
    assert.equal(buildFeedSnapshot(xml(title, "R+1"), { feedType: "inmoweb" }).properties[0].data.titulo, expected);
  }
});
for (const [description, expected] of [
  ["Precio: 105.000€[IW]", "Precio: 105.000€"],
  ["Texto[IW], continuación[IW].", "Texto, continuación."],
  ["Texto sin marca IW [iw] [I W] [IWA].", "Texto sin marca IW [iw] [I W] [IWA]."]
]) test(`only exact description markers are removed: ${description}`, () => {
  assert.equal(buildFeedSnapshot(xml("CASA", "CV3", description), { feedType: "inmoweb" }).properties[0].data.descripcion, expected);
});
test("generic_xml keeps both title reference prefix and description marker", () => {
  const source = '<properties><property><id>SYNTHETIC</id><reference>CV3</reference><title>CV3. CASA RURAL</title><description>Precio: 105.000€[IW]</description><price>105000</price><operation>sale</operation><propertyType>casa</propertyType></property></properties>';
  const property = buildFeedSnapshot(source, { feedType: "generic_xml" }).properties[0].data;
  assert.equal(property.titulo, "CV3. CASA RURAL");
  assert.equal(property.descripcion, "Precio: 105.000€[IW]");
});
