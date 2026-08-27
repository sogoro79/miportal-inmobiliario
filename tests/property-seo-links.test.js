import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
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

function crearElementoMock({ id = "", className = "", value = "" } = {}) {
  return {
    id,
    className,
    value,
    checked: false,
    readOnly: false,
    hidden: false,
    selectedIndex: 0,
    textContent: "",
    innerHTML: "",
    attributes: {},
    children: [],
    style: {},
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    replaceChildren(...children) {
      this.children = children;
    }
  };
}

function crearDocumentoListadoMock() {
  const elementos = new Map();
  const add = element => {
    if (element.id) elementos.set(element.id, element);
    return element;
  };

  add(crearElementoMock({ id: "lista", className: "lista-propiedades" }));
  add(crearElementoMock({ id: "resultado-count" }));
  add(crearElementoMock({ id: "f_texto" }));
  add(crearElementoMock({ id: "f_min" }));
  add(crearElementoMock({ id: "f_max" }));
  add(crearElementoMock({ id: "f_hab" }));
  add(crearElementoMock({ id: "f_sort" }));
  add(crearElementoMock({ id: "f_banos" }));
  add(crearElementoMock({ id: "f_sup_min" }));
  add(crearElementoMock({ id: "f_sup_max" }));
  add(crearElementoMock({ id: "f_tipo_inmueble" }));
  add(crearElementoMock({ id: "f_estado" }));
  add(crearElementoMock({ id: "f_garaje" }));
  add(crearElementoMock({ id: "f_piscina" }));
  add(crearElementoMock({ id: "f_terraza" }));

  const pageHeaderH1 = crearElementoMock();
  const pageHeaderIntro = crearElementoMock();

  return {
    title: "",
    head: crearElementoMock(),
    getElementById(id) {
      return elementos.get(id) || null;
    },
    createElement() {
      return crearElementoMock();
    },
    querySelector(selector) {
      if (selector === ".page-header h1") return pageHeaderH1;
      if (selector === ".page-header p") return pageHeaderIntro;
      if (selector === "link[rel='canonical']") return null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector !== ".card-propiedad") return [];
      const html = elementos.get("lista")?.innerHTML || "";
      return Array.from(html.matchAll(/class="[^"]*\bcard-propiedad\b[^"]*"/g), () => crearElementoMock());
    },
    addEventListener() {}
  };
}

test("generadores frontend de propiedades evitan enlaces legacy con query string", () => {
  for (const ruta of archivosFrontend) {
    const contenido = leer(ruta);

    assert.doesNotMatch(contenido, /\/propiedad\?id=/, ruta);
    assert.doesNotMatch(contenido, /\/propiedad\.html\?id=/, ruta);
  }
});

test("ficha de propiedad usa contacto privado por chat sin WhatsApp público", () => {
  const propiedadJs = leer("public/js/propiedad.js");
  const propiedadCss = leer("public/css/propiedad.css");

  assert.match(propiedadJs, /¿Te interesa esta vivienda\?/);
  assert.match(propiedadJs, /Habla directamente con el anunciante desde HomeClick24\./);
  assert.match(propiedadJs, /Enviar mensaje al anunciante/);
  assert.match(propiedadJs, /\/chat\/conversaciones/);
  assert.match(propiedadJs, /propiedadId: propiedad\._id/);
  assert.match(propiedadJs, /anuncianteId: propiedad\.usuarioId/);
  assert.match(propiedadJs, /returnUrl=\$\{encodeURIComponent\(returnUrl\)\}/);
  assert.match(propiedadJs, /Este anuncio es tuyo\./);
  assert.doesNotMatch(propiedadJs, /btn-whatsapp/);
  assert.doesNotMatch(propiedadJs, /generarEnlaceWhatsapp/);
  assert.doesNotMatch(propiedadCss, /btn-whatsapp/);
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

test("scripts de listados cargan juntos sin colisión global y renderizan propiedades", async () => {
  const listeners = new Map();
  const fetchCalls = [];
  const document = crearDocumentoListadoMock();
  const window = {
    location: { pathname: "/comprar", search: "", href: "https://www.homeclick24.com/comprar" },
    addEventListener(type, callback) {
      listeners.set(type, [...(listeners.get(type) || []), callback]);
    }
  };
  document.addEventListener = window.addEventListener;
  window.document = document;

  const context = vm.createContext({
    window,
    document,
    location: window.location,
    URLSearchParams,
    console: { error() {} },
    fetch: async url => {
      fetchCalls.push(url);
      return {
        ok: true,
        async json() {
          return [{
            _id: "507f1f77bcf86cd799439011",
            titulo: "Piso luminoso en venta",
            direccion: "Chipiona, Cádiz",
            precio: 180000,
            tipoOperacion: "venta",
            habitaciones: 2,
            banos: 1,
            superficie: 80,
            imagenes: []
          }];
        }
      };
    }
  });
  context.globalThis = context;
  context.window.window = context.window;
  context.window.URLSearchParams = URLSearchParams;

  assert.doesNotThrow(() => {
    vm.runInContext(leer("public/js/seo-slug.js"), context, { filename: "seo-slug.js" });
    vm.runInContext(leer("public/js/seo-zonas.js"), context, { filename: "seo-zonas.js" });
    vm.runInContext(leer("public/js/filtros.js"), context, { filename: "filtros.js" });
  });

  assert.equal(typeof context.window.cargarPropiedades, "function");

  for (const callback of listeners.get("DOMContentLoaded") || []) {
    await callback();
  }
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(fetchCalls, ["/propiedades?tipo=venta"]);
  assert.equal(document.querySelectorAll(".card-propiedad").length, 1);
  assert.match(document.getElementById("lista").innerHTML, /Piso luminoso en venta/);
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

test("portada usa viviendas destacadas sin concepto de ultimas oportunidades", () => {
  const index = leer("public/index.html");
  const homeDestacadas = leer("public/js/home-destacadas.js");
  const conceptoEvitado = new RegExp(`Últimas ${"oportunidades"}|Ultimas ${"oportunidades"}`, "i");

  assert.match(index, /Viviendas destacadas en HomeClick24/);
  assert.doesNotMatch(index, conceptoEvitado);
  assert.doesNotMatch(homeDestacadas, conceptoEvitado);
  assert.match(homeDestacadas, /Ver inmueble/);
  assert.match(homeDestacadas, /getPropiedadSeoUrl\(p\)/);
});

test("tarjetas muestran badges visuales de operación y destacada solo en home", () => {
  const styles = leer("public/css/styles.css");
  const index = leer("public/index.html");
  const filtros = leer("public/js/filtros.js");
  const homeDestacadas = leer("public/js/home-destacadas.js");

  assert.match(homeDestacadas, /home-feature-badges/);
  assert.match(homeDestacadas, /home-feature-highlight">Destacada/);
  assert.match(homeDestacadas, /\$\{tipo\}/);
  assert.match(filtros, /card-badges/);
  assert.match(filtros, /const tipo = p\.tipoOperacion === "venta" \? "Venta" : "Alquiler"/);
  assert.doesNotMatch(filtros, /Destacada/);
  assert.match(styles, /\.card-badges/);
  assert.match(index, /\.home-feature-highlight/);
});
