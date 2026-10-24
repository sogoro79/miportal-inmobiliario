import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { analyzeFeedXml, buildFeedSnapshot, detectFeedType } from "../utils/importers/importerRegistry.js";
import { normalizeInmowebXml, isInmowebXml } from "../utils/import/adapters/inmoweb.js";
import { analyzeGenericXml } from "../utils/importers/genericXmlImporter.js";
import { buildSyncSnapshot } from "../utils/import/syncSnapshot.js";
import { tipoInmuebleSchema } from "../utils/propertySchemas.js";
import { MAX_BATCH_PROPERTIES, MAX_BATCH_PHOTOS, MAX_BATCH_MS } from "../utils/import/importBudget.js";

const xml = fs.readFileSync(new URL("./fixtures/crm/inmoweb-synthetic.xml", import.meta.url), "utf8");
const generic = '<properties><property><id>GENERIC-A</id><title>Prueba</title><operation>sale</operation><price>10</price><address>Dirección ficticia</address><bedrooms>2</bedrooms><propertyType>flat</propertyType></property></properties>';
const read = (value = xml) => normalizeInmowebXml(value);
const entry = (value = xml) => read(value).properties[0];
const change = (from, to) => xml.replace(from, to);
const withPhotos = value => xml.replace(/<imagenes>[\s\S]*?<\/imagenes>/, `<imagenes>${value}</imagenes>`);
const record = xml.match(/<propiedad\b[\s\S]*?<\/propiedad>/)[0];

test("InmoWeb synthetic fixture is recognized without confusing generic properties", () => {
  assert.equal(detectFeedType(xml), "inmoweb");
  assert.equal(detectFeedType(generic), "generic_xml");
  assert.equal(isInmowebXml('<properties><property id="A"/></properties>'), false);
  assert.equal(isInmowebXml('<wrapper><properties><propiedad id="A"/></properties></wrapper>'), false);
  assert.throws(() => read(generic), { code: "INMOWEB_FORMAT_UNRECOGNIZED" });
  assert.equal(read().total, 1);
});

test("minimal InmoWeb record is parseable but cannot be published by invented defaults", () => {
  const p = entry('<properties><propiedad id="A"/></properties>');
  assert.equal(p.data.externalId, "A");
  assert.equal(p.data.habitaciones, null);
  assert.equal(p.data.estado, null);
  assert.equal(p.data.tipoInmueble, null);
  assert.equal(p.publishableByData, false);
  assert.equal(Object.hasOwn(p.data, "garaje"), false);
});

test("IDs remain strings with leading zeroes; reference is independent", () => {
  const p = entry();
  assert.equal(p.data.externalId, "0001");
  assert.equal(p.data.referencia, "SYNTHETIC-REF-A");
  assert.equal(entry(change("SYNTHETIC-REF-A", "DIFFERENT-REF")).data.externalId, "0001");
});

for (const value of ['id=""', '', 'id="https://example.test/id"']) {
  test(`missing or unsafe ID never falls back to reference: ${value || "absent"}`, () => {
    const p = entry(change('id="0001"', value));
    assert.ok(p.errors.includes("INMOWEB_INVALID_ID"));
    assert.notEqual(p.data.externalId, p.data.referencia);
    assert.equal(p.publishableByData, false);
  });
}

test("multiple records and duplicate IDs are checked before preview truncation", () => {
  const two = `<properties>${record}${record.replace('id="0001"', 'id="0002"')}</properties>`;
  assert.equal(read(two).properties.length, 2);
  assert.ok(read(two).properties.every(p => !p.errors.includes("INMOWEB_DUPLICATE_ID")));
  const duplicate = `<properties>${record}${record}</properties>`;
  assert.ok(read(duplicate).properties.every(p => p.errors.includes("INMOWEB_DUPLICATE_ID")));
  const preview = analyzeFeedXml(duplicate, { feedType: "inmoweb", maxProperties: 1 });
  assert.equal(preview.previewTruncated, true);
  assert.ok(preview.properties[0].errors.includes("INMOWEB_DUPLICATE_ID"));
});

for (const [id, expected] of [["1", "venta"], ["2", "alquiler"], ["6", null], ["constructor", null]]) {
  test(`operation ID ${id} maps explicitly`, () => {
    const p = entry(change('<operacion id="1">Venta', `<operacion id="${id}">Venta`));
    assert.equal(p.data.tipoOperacion, expected);
    if (expected === null) assert.ok(p.errors.includes("INMOWEB_UNSUPPORTED_OPERATION"));
    if (expected === "alquiler") {
      assert.equal(p.data.periodicidadPrecio, null);
      assert.ok(p.errors.includes("INMOWEB_RENT_PERIOD_UNKNOWN"));
    }
  });
}

test("EUR and other/missing currency never imply conversion", () => {
  assert.equal(entry().data.moneda, "EUR");
  for (const replacement of ['divisa="USD"', '']) {
    const p = entry(change('divisa="EUR"', replacement));
    assert.equal(p.data.precio, 210000);
    assert.ok(p.errors.includes("INMOWEB_UNSUPPORTED_CURRENCY"));
  }
  const one = entry(change(">210000</precio>", ">1</precio>"));
  assert.equal(one.data.precio, 1);
  assert.ok(one.warnings.includes("INMOWEB_PRICE_REVIEW_REQUIRED"));
});

for (const [id, expected] of [["1", "apartamento"], ["3", "chalet"], ["9", "finca_rustica"], ["10", "local_comercial"], ["16", "casa_campo"], ["20", "casa"], ["21", "adosado"], ["22", "duplex"], ["24", "piso"], ["999", null], ["__proto__", null]]) {
  test(`family ${id} uses supported enum, never a silent default`, () => {
    const p = entry(change('<familia id="24">', `<familia id="${id}">`));
    assert.equal(p.data.tipoInmueble, expected);
    if (expected) assert.ok(tipoInmuebleSchema.options.includes(expected));
    else assert.ok(p.errors.includes("INMOWEB_UNSUPPORTED_FAMILY"));
  });
}

for (const [id, expected] of [["ON", "obra_nueva"], ["SM", "segunda_mano"], ["", null], ["constructor", null]]) {
  test(`physical condition ${id || "empty"} stays independent of commercial status`, () => {
    const p = entry(change('<estado id="SM"/>', `<estado id="${id}"/>`));
    assert.equal(p.data.estado, expected);
    assert.equal(p.data.estadoComercial, "Disponible");
    if (!expected) assert.ok(p.errors.some(c => /CONDITION/.test(c)));
  });
}

for (const status of ["reservado", "captacion", "constructor", "__proto__", ""]) {
  test(`commercial status ${status || "empty"} cannot publish as active`, () => {
    const p = entry(change(">activo</status_id>", `>${status}</status_id>`));
    assert.equal(p.data.estado, "segunda_mano");
    assert.ok(p.errors.includes("INMOWEB_COMMERCIAL_UNAVAILABLE"));
  });
}

test("empty bedrooms/bathrooms stay null, zero is explicit, toilets remain metadata", () => {
  const p = entry(change('<dormitorios>2</dormitorios>', '<dormitorios/>').replace('<banos>1</banos>', '<banos/>'));
  assert.equal(p.data.habitaciones, null);
  assert.equal(p.data.banos, null);
  assert.equal(p.metadata.aseos, 2);
  assert.equal(entry(change('<dormitorios>2</dormitorios>', '<dormitorios>0</dormitorios>')).data.habitaciones, 0);
  assert.equal(entry().data.banos, 1);
});

test("surface means built area with no silent substitution; plot/living stay separate", () => {
  const p = entry();
  assert.equal(p.data.superficie, 90);
  assert.equal(p.data.superficieParcela, 150);
  assert.deepEqual(p.metadata.superficies, { construida: 90, habitable: 70, parcela: 150 });
  assert.equal(entry(change('<construida>90</construida>', '<construida/>')).data.superficie, null);
});

test("location preserves postcode, country and zone but never fabricates a street", () => {
  const p = entry();
  assert.equal(p.data.codigoPostal, "01234");
  assert.equal(p.data.localidad, "Municipio ficticio");
  assert.equal(p.data.provincia, "Provincia ficticia");
  assert.equal(p.data.pais, "ES");
  assert.equal(p.data.zona, "Zona ficticia");
  assert.equal(p.data.direccion, "");
  assert.ok(!p.errors.includes("INMOWEB_ADDRESS_MISSING"));
  assert.equal(p.data.precisionUbicacion, "aproximada");
  assert.equal(p.data.ubicacionPublica, "Zona ficticia, Municipio ficticio");
  assert.equal(p.publishableByData, true);
});

test("coordinates require a valid complete pair", () => {
  assert.equal(entry().data.lat, 36.5);
  assert.equal(entry().data.lng, -6.2);
  for (const pair of [xml.replace('<latitud>36.5</latitud>', ''), change('>36.5</latitud>', '>91</latitud>'), change('>-6.2</longitud>', '>181</longitud>'), change('>36.5</latitud>', '>not-numeric</latitud>')]) {
    assert.equal(entry(pair).data.lat, null);
    assert.equal(entry(pair).data.lng, null);
    assert.ok(entry(pair).warnings.includes("INMOWEB_INVALID_COORDINATES"));
  }
});

test("Spanish is selected independently of XML order; English is retained, never mixed", () => {
  const p = entry();
  assert.equal(p.data.titulo, "Piso sintético");
  assert.equal(p.metadata.traducciones.gb.titulo, "Synthetic apartment");
  const noSpanish = xml.replace(/<descripcion idioma="es"><titulo>[^<]*<\/titulo><descripcion>[^<]*<\/descripcion><\/descripcion>/, '');
  assert.equal(entry(noSpanish).data.titulo, "");
  assert.ok(entry(noSpanish).errors.includes("INMOWEB_SPANISH_TITLE_MISSING"));
});

test("features use explicit rules and preserve rich original values", () => {
  const p = entry();
  for (const k of ["garaje", "piscina", "terraza"]) assert.equal(p.data[k], true);
  assert.deepEqual(p.metadata.caracteristicas.piscina, ["Comunitaria"]);
  const absent = entry(xml.replace(/<caracteristicas>[\s\S]*?<\/caracteristicas>/, '<caracteristicas/>'));
  for (const k of ["garaje", "piscina", "terraza"]) assert.equal(Object.hasOwn(absent.data, k), false);
  const unknown = entry(change('>privado</caracteristica>', '>unknown</caracteristica>'));
  assert.equal(Object.hasOwn(unknown.data, "garaje"), false);
  assert.ok(unknown.warnings.includes("INMOWEB_FEATURE_UNMAPPED"));
});

test("primary photo sorts first, secondary order survives, duplicates collapse", () => {
  assert.deepEqual(entry().data.imagenes, ['https://images.example.test/main.jpg', 'https://images.example.test/secondary.jpg']);
});

test("photo URL validation uses existing policy without any download", () => {
  const p = entry(withPhotos(['http://images.example.test/a.jpg', 'https://images.example.test/b.jpg', 'file:///secret', 'ftp://example.test/a', 'https://user:pass@example.test/a', 'http://127.0.0.1/a', 'https://localhost/a', 'not-a-url'].map(url => `<imagen url="${url}"/>`).join('')));
  assert.deepEqual(p.data.imagenes, ['http://images.example.test/a.jpg', 'https://images.example.test/b.jpg']);
  assert.ok(p.warnings.includes("INMOWEB_IMAGE_URL_REJECTED"));
});

test("all 63 synthetic photos survive preview/snapshot even when maxPhotos is requested", () => {
  const many = withPhotos(Array.from({ length: 63 }, (_, i) => `<imagen url="https://images.example.test/${i}.jpg"/>`).join(''));
  const p = analyzeFeedXml(many, { feedType: "inmoweb", maxPhotos: 1 });
  assert.equal(p.properties[0].fotos.length, 63);
  assert.deepEqual(p.properties[0].fotos, buildFeedSnapshot(many, { feedType: "inmoweb" }).properties[0].data.imagenes);
});

test("preview and snapshot use exactly the same canonical values and diagnostics", () => {
  const preview = analyzeFeedXml(xml, { feedType: "inmoweb" });
  const snapshot = buildFeedSnapshot(xml, { feedType: "inmoweb" });
  const { fotos, metadata, errors, warnings, publishableByData, ...data } = preview.properties[0];
  assert.deepEqual(data, snapshot.properties[0].data);
  assert.deepEqual({ metadata, errors, warnings, publishableByData }, {
    metadata: snapshot.properties[0].metadata, errors: snapshot.properties[0].errors,
    warnings: snapshot.properties[0].warnings, publishableByData: snapshot.properties[0].publishableByData
  });
  assert.equal(snapshot.structurallyComplete, true);
  assert.equal(snapshot.snapshotComplete, false);
  assert.ok(snapshot.warnings.includes("MISSING_DISABLED_INCOMPLETE_SNAPSHOT"));
});

test("no option can certify provider completeness during Phase 1", () => {
  assert.equal(buildFeedSnapshot(xml, { feedType: "inmoweb", snapshotComplete: true }).snapshotComplete, false);
  const nested = xml.replace('<properties>', '<properties><other><propiedad id="X"/></other>');
  assert.equal(read(nested).structurallyComplete, false);
  const tooMany = `<properties>${Array.from({ length: 2001 }, (_, i) => `<propiedad id="${i}"/>`).join('')}</properties>`;
  assert.equal(read(tooMany).total, 2001);
  assert.equal(read(tooMany).snapshotCount, 2000);
  assert.ok(read(tooMany).warnings.includes("SNAPSHOT_LIMIT_EXCEEDED"));
});

test("duplicate ID beyond the snapshot ceiling still invalidates its earlier record", () => {
  const value = `<properties>${Array.from({ length: 2001 }, (_, i) => `<propiedad id="${i === 2000 ? 0 : i}"/>`).join('')}</properties>`;
  const snapshot = read(value);
  assert.ok(snapshot.properties[0].errors.includes("INMOWEB_DUPLICATE_ID"));
  assert.equal(snapshot.snapshotComplete, false);
});

test("unsafe, oversized and invalid XML are rejected with safe codes", () => {
  for (const [value, code] of [["<properties>", "XML_INVALID"], ['<!DOCTYPE properties><properties/>', "XML_DOCTYPE_BLOCKED"], ['<!ENTITY x "y"><properties/>', "XML_ENTITY_BLOCKED"], [' '.repeat(5 * 1024 * 1024 + 1), "FEED_TOO_LARGE"]]) {
    assert.throws(() => read(value), { code });
  }
});

test("generic registry defaults and snapshot semantics remain unchanged", () => {
  assert.deepEqual(analyzeFeedXml(generic), { feedType: "generic_xml", properties: analyzeGenericXml(generic) });
  assert.deepEqual(buildFeedSnapshot(generic), buildSyncSnapshot(generic));
  assert.throws(() => analyzeFeedXml(xml), { code: "XML_EMPTY" });
  assert.throws(() => analyzeFeedXml(generic, { feedType: "constructor" }), { code: "UNSUPPORTED_FEED_TYPE" });
  assert.deepEqual([MAX_BATCH_PROPERTIES, MAX_BATCH_PHOTOS, MAX_BATCH_MS], [10, 100, 120000]);
});
