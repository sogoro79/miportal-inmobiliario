import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";
import Propiedad from "../models/Propiedad.js";
import { buildPublicLocation, buildPostalAddress, publicPropertyLocation, applyLocationEdit } from "../utils/publicLocation.js";
import { propiedadCreateSchema, propiedadCrmCreateSchema } from "../utils/propertySchemas.js";
import { buildPropiedadCreateData } from "../utils/propertyCreation.js";
import { validateImportProperty } from "../utils/import/selectedImport.js";
import { analyzeFeedXml } from "../utils/importers/importerRegistry.js";
import { safeInmowebPreview } from "../utils/import/inmowebPreview.js";
import { CONTENT_FIELDS } from "../utils/propertyContent.js";
import { missingContentFingerprint } from "../utils/import/missingEligibility.js";

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const approximate = { direccion: "Calle privada 8", ubicacionPublica: "Costa Ballena, Rota", precisionUbicacion: "aproximada", localidad: "Rota", provincia: "Cádiz", codigoPostal: "11520", lat: 36.7, lng: -6.4 };
const body = { titulo: "Prueba", tipoOperacion: "venta", precio: 200000, habitaciones: 2, localidad: "Rota", provincia: "Cádiz", direccion: "" };

for (const [property, expected] of [
  [{ direccion: "Calle antigua 3" }, "Calle antigua 3"],
  [approximate, "Costa Ballena, Rota"],
  [{ ...approximate, ubicacionPublica: "", zona: "Costa Ballena, Rota" }, "Costa Ballena, Rota"],
  [{ ...approximate, ubicacionPublica: "", localidad: "Cádiz", provincia: "Cadiz" }, "Cádiz"],
  [{ precisionUbicacion: "aproximada", direccion: "Privada", localidad: "Rota", provincia: "Cádiz" }, "Rota, Cádiz"],
  [{ provincia: "Cádiz" }, "Cádiz"], [{}, "Ubicación no disponible"]
]) test(`public location priority: ${expected}`, () => assert.equal(buildPublicLocation(property), expected));

test("manual address requirement stays strict; CRM location is a separate rule", () => {
  assert.equal(propiedadCreateSchema.safeParse(body).success, false);
  assert.equal(propiedadCreateSchema.safeParse({ ...body, direccion: "Calle manual 3" }).success, true);
  assert.equal(propiedadCrmCreateSchema.safeParse(body).success, true);
  assert.equal(propiedadCrmCreateSchema.safeParse({ ...body, localidad: "" }).success, false);
  assert.deepEqual(validateImportProperty({ ...body, externalId: "SYNTHETIC", fotos: [] }).errors, []);
  const invalid = new Propiedad({ ...body, precisionUbicacion: "unknown" }).validateSync();
  assert.ok(invalid.errors.precisionUbicacion);
});

test("new manual and CRM persistence data derive public location without inventing an address", () => {
  const manual = buildPropiedadCreateData({ ...body, direccion: "Calle manual 3" });
  assert.equal(manual.precisionUbicacion, "exacta");
  assert.equal(manual.ubicacionPublica, "Calle manual 3");
  const crm = buildPropiedadCreateData(body, { source: "crm" });
  assert.equal(crm.direccion, "");
  assert.equal(crm.precisionUbicacion, "aproximada");
  assert.equal(crm.ubicacionPublica, "Rota, Cádiz");
});

test("legacy partial edits do not materialize location fields or change their precision", () => {
  const p = Propiedad.hydrate({ direccion: "Calle antigua 3" });
  applyLocationEdit(p, { descripcion: "Nueva descripción" });
  assert.equal(p.ubicacionPublica, undefined);
  assert.equal(p.precisionUbicacion, undefined);
  assert.equal(buildPublicLocation(p), "Calle antigua 3");
  const current = { direccion: "Antes", ubicacionPublica: "Antes", precisionUbicacion: "exacta" };
  applyLocationEdit(current, { direccion: "Después" });
  assert.equal(current.ubicacionPublica, "Después");
  applyLocationEdit(current, { precisionUbicacion: "aproximada" });
  assert.equal(current.ubicacionPublica, "");
});

test("public serialization excludes private address/coordinates without mutating owner data", () => {
  const publicData = publicPropertyLocation(approximate);
  assert.equal(publicData.direccion, "");
  assert.equal(publicData.lat, null); assert.equal(publicData.lng, null);
  assert.equal(publicData.ubicacionPublica, "Costa Ballena, Rota");
  assert.equal(approximate.direccion, "Calle privada 8");
  assert.deepEqual(publicPropertyLocation({ direccion: "Calle legacy" }), { direccion: "Calle legacy" });
});

test("schema exposes structured public fields but never a fake street for approximate listings", () => {
  const schema = buildPostalAddress(approximate);
  assert.equal(Object.hasOwn(schema, "streetAddress"), false);
  assert.equal(schema.addressLocality, "Rota"); assert.equal(schema.addressRegion, "Cádiz");
  assert.equal(schema.postalCode, "11520"); assert.equal(schema.addressCountry, "ES");
  assert.equal(buildPostalAddress({ ...approximate, precisionUbicacion: "exacta" }).streetAddress, "Calle privada 8");
  assert.equal(buildPostalAddress({ direccion: "Calle legacy" }).streetAddress, "Calle legacy");
});

test("InmoWeb derives approximate location and does not enable any action", () => {
  const xml = read("tests/fixtures/crm/inmoweb-synthetic.xml");
  const result = analyzeFeedXml(xml, { feedType: "inmoweb" });
  const p = result.properties[0];
  assert.equal(p.direccion, ""); assert.equal(p.precisionUbicacion, "aproximada");
  assert.equal(p.ubicacionPublica, "Zona ficticia, Municipio ficticio");
  assert.equal(p.publishableByData, true);
  assert.ok(!p.errors.includes("INMOWEB_ADDRESS_MISSING"));
  const noZone = analyzeFeedXml(xml.replace('<zona>Zona ficticia</zona>', '<zona/>'), { feedType: "inmoweb" });
  assert.equal(noZone.properties[0].ubicacionPublica, "Municipio ficticio, Provincia ficticia");
  const absent = analyzeFeedXml(xml.replace(/<poblacion[^>]*>[^<]*<\/poblacion>/, '<poblacion/>'), { feedType: "inmoweb" });
  assert.ok(absent.properties[0].errors.includes("INMOWEB_LOCATION_INSUFFICIENT"));
  assert.equal(absent.properties[0].publishableByData, false);
  const safe = safeInmowebPreview(result);
  assert.equal(safe.previewOnly, true); assert.equal(safe.importEnabled, false);
  assert.equal(safe.syncEnabled, false); assert.equal(safe.snapshotComplete, false);
});

test("adding optional location fields does not invalidate historical MISSING fingerprints", () => {
  const property = { titulo: "Legacy", direccion: "Calle", imagenes: [] };
  const oldFields = CONTENT_FIELDS.filter(k => !["ubicacionPublica", "precisionUbicacion", "periodicidadPrecio", "habitacionesEstado"].includes(k));
  const expected = crypto.createHash("sha256").update(JSON.stringify(oldFields.map(k => [k, property[k] === undefined ? ["absent"] : ["value", property[k]]]))).digest("hex");
  assert.equal(missingContentFingerprint(property), expected);
  assert.notEqual(missingContentFingerprint({ ...property, precisionUbicacion: "aproximada" }), expected);
});

function frontend(p, result = [{ lat: "36", lon: "-6" }]) {
  const requests = [], markers = [], centers = [], scripts = [];
  const container = { innerHTML: "", classList: { add() {}, remove() {} } };
  const ctx = vm.createContext({ URLSearchParams, console, Event,
    window: { location: { search: "" }, addEventListener() {}, dispatchEvent() {} },
    document: { addEventListener() {}, querySelector: () => null, getElementById: id => id === "mapa" || id === "contenedor" ? container : null,
      head: { appendChild: item => scripts.push(item) }, createElement: () => ({}) },
    fetch: async url => { requests.push(url); return { ok: true, json: async () => result }; },
    L: { map: () => ({ setView(point, zoom) { centers.push({ point, zoom }); return this; } }), tileLayer: () => ({ addTo() {} }),
      marker: point => { markers.push(point); return { addTo() { return this; }, bindPopup() { return this; }, openPopup() {} }; } },
    inputProperty: p
  });
  for (const file of ["public-location", "precios", "propiedad"]) vm.runInContext(read(`public/js/${file}.js`), ctx);
  vm.runInContext('propiedad = inputProperty; fotos = [];', ctx);
  return { ctx, requests, markers, centers, scripts, container };
}

test("approximate map ignores saved coordinates and geocodes municipality only, without marker", async () => {
  const f = frontend(approximate);
  await vm.runInContext('iniciarMapa()', f.ctx);
  assert.equal(f.requests.length, 1);
  assert.equal(new URL(f.requests[0]).searchParams.get("q"), "Rota, Cádiz, España");
  assert.doesNotMatch(f.requests[0], /Calle|privada|Ballena/);
  assert.equal(f.markers.length, 0);
  assert.equal(f.centers[0].zoom, 11);
  assert.notDeepEqual(Array.from(f.centers[0].point), [approximate.lat, approximate.lng]);
});

test("exact map retains saved coordinates and a marker, without geocoding", async () => {
  const f = frontend({ ...approximate, precisionUbicacion: "exacta" });
  await vm.runInContext('iniciarMapa()', f.ctx);
  assert.equal(f.requests.length, 0); assert.equal(f.markers.length, 1);
  assert.equal(f.centers[0].zoom, 15);
});

test("approximate map without usable lookup results never falls back to private coordinates", async () => {
  const f = frontend(approximate, []);
  await vm.runInContext('iniciarMapa()', f.ctx);
  assert.equal(f.markers.length, 0); assert.equal(f.centers.length, 0);
  assert.match(f.container.innerHTML, /Ubicación aproximada/);
});

test("actual detail render and SEO use public location, not the private street", () => {
  const f = frontend({ ...approximate, titulo: "Prueba", _id: "test", precio: 100, imagenes: [] });
  vm.runInContext('renderPropiedad(); actualizarSEO();', f.ctx);
  assert.match(f.container.innerHTML, /Costa Ballena, Rota/);
  assert.match(f.container.innerHTML, /Ubicación aproximada/);
  assert.doesNotMatch(f.container.innerHTML, /Calle privada/);
  const schema = JSON.parse(f.scripts.find(s => s.id === "schema-propiedad").textContent);
  assert.equal(Object.hasOwn(schema.address, "streetAddress"), false);
});

test("HTML pages load central helper before consumer scripts", () => {
  for (const page of ["comprar", "alquiler", "propiedad", "perfil", "favoritos", "index", "admin"]) {
    assert.match(read(`public/${page}.html`), /public-location\.js\?v=1/);
  }
});

test("actual listing cards use the public location and escape it", () => {
  const container = { innerHTML: "" };
  const ctx = vm.createContext({ URLSearchParams, window: { addEventListener() {}, location: { pathname: "/comprar" } },
    document: { addEventListener() {}, getElementById: () => container },
    data: [{ ...approximate, _id: "test", titulo: "Prueba", tipoOperacion: "venta", precio: 200000 }]
  });
  for (const file of ["public-location", "precios", "filtros"]) vm.runInContext(read(`public/js/${file}.js`), ctx);
  vm.runInContext('renderLista(data)', ctx);
  assert.match(container.innerHTML, /Costa Ballena, Rota/);
  assert.doesNotMatch(container.innerHTML, /Calle privada/);
  ctx.data[0].ubicacionPublica = '<img src=x onerror="bad()">';
  vm.runInContext('renderLista(data)', ctx);
  assert.match(container.innerHTML, /&lt;img/);
});
