import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { getSeoZoneContext } from "../utils/seoZones.js";

const archivosFrontend = [
  "public/chat.html",
  "public/favoritos.html",
  "public/perfil.html",
  "public/publicar.html",
  "public/js/header.js",
  "public/js/home-destacadas.js",
  "public/js/filtros.js",
  "public/js/propiedades-relacionadas.js",
  "public/js/perfil.js",
  "public/js/home-ultimas.js",
  "public/js/propiedad.js",
  "public/js/seo-local.js"
];

function leer(ruta) {
  return fs.readFileSync(new URL(`../${ruta}`, import.meta.url), "utf8");
}

test("generadores frontend de propiedades evitan enlaces legacy con query string", () => {
  for (const ruta of archivosFrontend) {
    const contenido = leer(ruta);

    assert.doesNotMatch(contenido, /\/propiedad\?id=/, ruta);
    assert.doesNotMatch(contenido, /\/propiedad\.html\?id=/, ruta);
  }
});

test("cabecera resuelve notificaciones de propiedad con URL SEO limpia", () => {
  const headerJs = leer("public/js/header.js");

  assert.match(headerJs, /function obtenerUrlPropiedadSeo\(propiedad\)/);
  assert.match(headerJs, /getPropiedadSeoUrl\(typeof propiedad === "object" \? propiedad : \{ _id: id \}\)/);
  assert.match(headerJs, /const propiedadUrl = obtenerUrlPropiedadSeo\(n\.propiedadId\)/);
  assert.match(headerJs, /window\.location\.href = propiedadUrl/);
});

test("seo-zonas reutiliza el contexto local inyectado por servidor", () => {
  const seoZonas = leer("public/js/seo-zonas.js");
  const context = getSeoZoneContext({ operacionPath: "alquiler", slug: "chipiona" });

  assert.match(seoZonas, /getElementById\("seo-zone-context"\)/);
  assert.match(seoZonas, /JSON\.parse\(script\.textContent\)/);
  assert.doesNotMatch(seoZonas, /const SEO_ZONAS\s*=\s*\{/);
  assert.equal(context.title, "Pisos y casas en alquiler en Chipiona | HomeClick24");
  assert.equal(context.canonical, "https://www.homeclick24.com/alquiler/chipiona");
});
