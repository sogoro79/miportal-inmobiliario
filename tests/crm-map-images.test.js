import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { analyzeFeedXml } from "../utils/importers/importerRegistry.js";
import { fetchImportImage } from "../utils/import/imageFetcher.js";

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const feed = read("public/test-feeds/homeclick24-crm-feed-prueba.xml");
const parseCoordinates = tags => analyzeFeedXml(feed.replace("<city>Chipiona</city>", `<city>Chipiona</city>${tags}`)).properties[0];

for (const [lat, lng] of [["lat", "lng"], ["latitude", "longitude"], ["latitud", "longitud"], ["lat", "lon"]]) {
  test(`parser acepta coordenadas ${lat}/${lng}`, () => {
    const p = parseCoordinates(`<${lat}>36.727</${lat}><${lng}>-6.436</${lng}>`);
    assert.equal(p.lat, 36.727); assert.equal(p.lng, -6.436);
  });
}
for (const tags of ["", "<lat>36</lat>", "<lat>91</lat><lng>0</lng>", "<lat>0</lat><lng>-181</lng>", "<lat>NaN</lat><lng>0</lng>", "<lat>36foo</lat><lng>0</lng>"]) {
  test(`parser ignora pareja ausente o inválida: ${tags || "ausente"}`, () => {
    const p = parseCoordinates(tags);
    assert.equal(p.lat, null); assert.equal(p.lng, null); assert.equal(p.errors.length, 0);
  });
}
test("parser admite coordenadas cero", () => {
  const p = parseCoordinates("<lat>0</lat><lng>0</lng>");
  assert.equal(p.lat, 0); assert.equal(p.lng, 0);
});

function frontend() {
  const container = { innerHTML: "" };
  const requests = [], centers = [];
  const marker = { addTo() { return this; }, bindPopup() { return this; }, openPopup() {} };
  const context = vm.createContext({ URLSearchParams, console, Event,
    window: { location: { search: "" }, addEventListener() {}, dispatchEvent() {} },
    document: { addEventListener() {}, querySelector: () => null, getElementById: id => id === "contenedor" ? container : null },
    fetch: async url => { requests.push(url); return { json: async () => [{ lat: "36.727", lon: "-6.436" }] }; },
    L: { map: () => ({ setView(coords) { centers.push(coords); return this; } }), tileLayer: () => ({ addTo() {} }), marker: () => marker }
  });
  vm.runInContext(read("public/js/propiedad.js"), context);
  return { context, requests, centers, container };
}
test("mapa geocodifica dirección, municipio, provincia, CP y España sin comas vacías", async () => {
  const f = frontend();
  vm.runInContext('propiedad = { direccion: "Avenida de Huelva 10", localidad: "Chipiona", provincia: "Cádiz", codigoPostal: "11550" };', f.context);
  await vm.runInContext("iniciarMapa()", f.context);
  const url = new URL(f.requests[0]);
  assert.equal(url.searchParams.get("q"), "Avenida de Huelva 10, Chipiona, Cádiz, 11550, España");
  assert.equal(url.searchParams.get("countrycodes"), "es");
  assert.equal(vm.runInContext('consultaMapa({direccion:"Calle, , Chipiona", localidad:"Chipiona"})', f.context), "Calle, Chipiona, España");
});
test("mapa utiliza coordenadas válidas sin llamar Nominatim, incluido cero", async () => {
  const f = frontend();
  vm.runInContext('propiedad = {lat: "0", lng: "-6.436"};', f.context);
  await vm.runInContext("iniciarMapa()", f.context);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(Array.from(f.centers[0]), [0, -6.436]);
});
test("sin fotos reales, ficha y navegación no muestran un contador 1/1", () => {
  const f = frontend();
  vm.runInContext('propiedad = { titulo: "Prueba", imagenes: [] }; fotos = ["placeholder"]; tieneFotosReales = false; renderPropiedad();', f.context);
  assert.match(f.container.innerHTML, /slider-count">Sin fotos/);
  assert.doesNotMatch(f.container.innerHTML, /slider-count">1 \/ 1/);
  vm.runInContext('tieneFotosReales = true; fotos = ["a", "b", "c"]; renderPropiedad();', f.context);
  assert.match(f.container.innerHTML, /slider-count">1 \/ 3/);
});
test("feed de prueba contiene 3/5/2/1 imágenes propias válidas sin acceder a servicios externos", async () => {
  const properties = analyzeFeedXml(feed, { maxPhotos: Infinity }).properties;
  assert.deepEqual(properties.map(p => p.fotos.length), [3, 5, 2, 1]);
  for (const property of properties) for (const imageUrl of property.fotos) {
    const url = new URL(imageUrl);
    assert.equal(url.origin, "https://www.homeclick24.com");
    assert.match(url.pathname, /^\/test-feeds\/images\/hc24-demo-\d+-\d+\.png$/);
    const buffer = fs.readFileSync(new URL(`../public${url.pathname}`, import.meta.url));
    const downloaded = await fetchImportImage(imageUrl, {
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      requestOnce: async () => ({ statusCode: 200, headers: { "content-type": "image/png" }, body: buffer })
    });
    assert.deepEqual(downloaded, buffer);
  }
});
