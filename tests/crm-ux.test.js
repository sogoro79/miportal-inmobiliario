import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const priceContext = vm.createContext({});
vm.runInContext(read("public/js/precios.js"), priceContext);

for (const [price, operation, expected] of [[245000, "venta", "245.000 €"], [1650, "alquiler", "1.650 €/mes"], ["1650", "alquiler", "1.650 €/mes"], [0, "venta", "0 €"], [1200.5, "alquiler", "1.200,5 €/mes"]]) {
  test(`formato común ${price}/${operation}`, () => {
    assert.equal(priceContext.formatearPrecioPropiedad(price, operation), expected);
  });
}

const profile = read("public/perfil.html");
const summaryContext = vm.createContext({});
vm.runInContext(profile.slice(profile.indexOf("function lineasResumenCrm"), profile.indexOf("async function importarSeleccionadosCrm")), summaryContext);
for (const [data, expected] of [
  [{ imported: 1, skipped: 0, attemptedImages: 5, importedImages: 5, skippedImages: 0 }, ["1 inmueble importado", "5 imágenes importadas", "0 imágenes omitidas"]],
  [{ imported: 3, skipped: 1, attemptedImages: 12, importedImages: 10, skippedImages: 2 }, ["3 inmuebles importados", "1 inmueble omitido", "10 imágenes importadas", "2 imágenes omitidas"]],
  [{ imported: 1, skipped: 2, attemptedImages: 2, importedImages: 1, skippedImages: 1 }, ["1 inmueble importado", "2 inmuebles omitidos", "1 imagen importada", "1 imagen omitida"]],
  [{ imported: 1, skipped: 0, attemptedImages: 0, importedImages: 0, skippedImages: 0 }, ["1 inmueble importado"]]
]) {
  test(`resumen CRM: ${expected.join(" / ")}`, () => {
    assert.deepEqual(Array.from(summaryContext.lineasResumenCrm(data)), expected);
  });
}

for (const [file, render] of [["home-destacadas", "renderDestacadaHome"], ["home-ultimas", "renderUltimaHome"], ["propiedades-relacionadas", "renderPropiedadRelacionada"]]) {
  test(`tarjetas ${file} usan precios comunes para CRM y manuales`, () => {
    const context = vm.createContext({ document: { addEventListener() {} }, window: { addEventListener() {} } });
    vm.runInContext(read("public/js/precios.js"), context);
    vm.runInContext(read(`public/js/${file}.js`), context);
    for (const source of ["manual", "crm"]) for (const [precio, tipoOperacion, expected] of [[1650, "alquiler", "1.650 €/mes"], [245000, "venta", "245.000 €"]]) {
      const html = context[render]({ _id: "test", titulo: "Prueba", source, precio, tipoOperacion });
      assert.ok(html.includes(expected));
    }
  });
}

test("páginas cargan helper de precios antes del código consumidor", () => {
  for (const [file, consumer] of [["propiedad", "/js/propiedad.js?v=2"], ["comprar", "/js/filtros.js?v=2"], ["alquiler", "/js/filtros.js?v=2"], ["index", "/js/home-destacadas.js?v=2"]]) {
    const html = read(`public/${file}.html`);
    assert.ok(html.indexOf('/js/precios.js?v=1') >= 0);
    assert.ok(html.indexOf('/js/precios.js?v=1') < html.indexOf(consumer));
  }
  for (const file of ["perfil", "favoritos"]) {
    const html = read(`public/${file}.html`);
    assert.ok(html.indexOf('/js/precios.js?v=1') < html.indexOf('formatearPrecioPropiedad('));
  }
  for (const file of ["perfil", "filtros", "propiedad"]) assert.match(read(`public/js/${file}.js`), /formatearPrecioPropiedad\(/);
});
