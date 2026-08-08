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

const paginasConContacto = [
  "public/index.html",
  "public/alquiler.html",
  "public/comprar.html",
  "public/publicar.html",
  "public/planes.html",
  "public/terminos.html",
  "public/inmobiliarias-cadiz.html",
  "public/contacto.html"
];

const archivosSinIndexLegacy = [
  "public/index.html",
  "public/chat.html",
  "public/favoritos.html",
  "public/perfil.html",
  "public/login.html",
  "public/registro.html",
  "public/reset.html",
  "public/recuperar.html",
  "public/terminos.html",
  "public/legal.html",
  "public/sobre.html",
  "public/js/header.js",
  "public/js/auth.js",
  "public/js/professional-promo.js",
  "public/service-worker.js"
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

test("enlaces y canonicals de contacto usan la URL limpia", () => {
  for (const ruta of paginasConContacto) {
    const contenido = leer(ruta);

    assert.doesNotMatch(contenido, /\/contacto\.html/, ruta);
  }

  const contacto = leer("public/contacto.html");
  assert.match(contacto, /<link rel="canonical" href="https:\/\/www\.homeclick24\.com\/contacto">/);
  assert.match(contacto, /<meta property="og:url" content="https:\/\/www\.homeclick24\.com\/contacto">/);
});

test("enlaces internos activos evitan /index.html", () => {
  for (const ruta of archivosSinIndexLegacy) {
    const contenido = leer(ruta);

    assert.doesNotMatch(contenido, /\/index\.html|location\.href='index\.html'|href="index\.html"/, ruta);
  }
});
