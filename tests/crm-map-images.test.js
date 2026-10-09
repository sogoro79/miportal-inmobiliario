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

function frontend({ results = [{ lat: "36.727", lon: "-6.436" }], fail = false, ok = true } = {}) {
  const container = { innerHTML: "" };
  const mapContainer = { innerHTML: "", classList: { add() {}, remove() {} } };
  const image = {};
  const count = {};
  const requests = [], centers = [];
  const marker = { addTo() { return this; }, bindPopup() { return this; }, openPopup() {} };
  const context = vm.createContext({ URLSearchParams, console, Event,
    window: { location: { search: "" }, addEventListener() {}, dispatchEvent() {} },
    document: { addEventListener() {}, querySelectorAll: () => [], querySelector: selector => selector === ".slider-img" ? image : selector === ".slider-count" ? count : null, getElementById: id => id === "contenedor" ? container : id === "mapa" ? mapContainer : null },
    fetch: async url => { requests.push(url); if (fail) throw new Error("Network failure"); return { ok, json: async () => results }; },
    L: { map: () => ({ setView(coords) { centers.push(coords); return this; } }), tileLayer: () => ({ addTo() {} }), marker: () => marker }
  });
  vm.runInContext(read("public/js/precios.js"), context);
  vm.runInContext(read("public/js/propiedad.js"), context);
  return { context, requests, centers, container, mapContainer, image, count };
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
for (const [name, options] of [["cero resultados", { results: [] }], ["error de red", { fail: true }], ["error HTTP", { ok: false }], ["coordenadas inválidas", { results: [{ lat: "91", lon: "0" }] }]]) {
  test(`mapa muestra estado controlado con ${name}`, async () => {
    const f = frontend(options);
    vm.runInContext('propiedad = {lat: null, lng: null, direccion: "Camino del Bercial 22", localidad: "Rota"};', f.context);
    await vm.runInContext("iniciarMapa()", f.context);
    assert.equal(f.centers.length, 0);
    assert.match(f.mapContainer.innerHTML, /Ubicación exacta no disponible/);
    assert.match(f.mapContainer.innerHTML, /dirección indicada por el anunciante/);
  });
}
test("sin fotos reales, ficha y navegación no muestran un contador 1/1", () => {
  const f = frontend();
  vm.runInContext('propiedad = { titulo: "Prueba", imagenes: [] }; fotos = ["placeholder"]; tieneFotosReales = false; renderPropiedad();', f.context);
  assert.match(f.container.innerHTML, /slider-count">Sin fotos/);
  assert.doesNotMatch(f.container.innerHTML, /slider-count">1 \/ 1/);
  vm.runInContext('tieneFotosReales = true; fotos = ["a", "b", "c", "d", "e"]; renderPropiedad();', f.context);
  assert.match(f.container.innerHTML, /slider-count">1 \/ 5/);
  vm.runInContext("irFoto(4)", f.context);
  assert.equal(f.count.textContent, "5 / 5");
  assert.equal(f.image.src, "e");
});

test("ficha muestra venta y alquiler con precio común para publicaciones manuales y CRM", () => {
  const f = frontend();
  for (const source of ["manual", "crm"]) for (const [precio, tipoOperacion, expected] of [[245000, "venta", "245.000 €"], [1650, "alquiler", "1.650 €/mes"]]) {
    f.context.testProperty = { titulo: "Prueba", precio, tipoOperacion, source };
    vm.runInContext('propiedad = testProperty; fotos = ["placeholder"]; renderPropiedad();', f.context);
    assert.ok(f.container.innerHTML.includes(expected));
  }
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
