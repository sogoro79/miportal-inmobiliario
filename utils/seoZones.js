const DEFAULT_SITE_URL = "https://www.homeclick24.com";

export const SEO_ZONES = Object.freeze({
  cadiz: Object.freeze({
    nombre: "Cádiz",
    nombreSeo: "Cádiz",
    filtro: "Cádiz",
    aliases: Object.freeze(["Cadiz", "Cádiz"]),
    introVenta: "Busca viviendas en venta en Cádiz y compara anuncios reales publicados por particulares, agentes y agencias de la zona.",
    introAlquiler: "Consulta pisos y casas en alquiler en Cádiz con filtros útiles para encontrar una vivienda que encaje con tu presupuesto."
  }),
  "el-puerto-de-santa-maria": Object.freeze({
    nombre: "El Puerto de Santa María",
    nombreSeo: "El Puerto de Santa María",
    filtro: "El Puerto de Santa María",
    aliases: Object.freeze(["El Puerto de Santa Maria", "El Puerto de Santa María", "Puerto de Santa Maria", "Puerto de Santa María"]),
    introVenta: "Explora pisos, casas y chalets en venta en El Puerto de Santa María, una zona con demanda residencial durante todo el año.",
    introAlquiler: "Encuentra alquileres en El Puerto de Santa María y revisa viviendas disponibles cerca de servicios, playas y conexiones."
  }),
  "jerez-de-la-frontera": Object.freeze({
    nombre: "Jerez de la Frontera",
    nombreSeo: "Jerez de la Frontera",
    filtro: "Jerez de la Frontera",
    aliases: Object.freeze(["Jerez de la Frontera", "Jerez"]),
    introVenta: "Compara viviendas en venta en Jerez de la Frontera, desde pisos urbanos hasta casas familiares en barrios consolidados.",
    introAlquiler: "Revisa pisos y casas en alquiler en Jerez de la Frontera con anuncios actualizados y contacto directo desde HomeClick24."
  }),
  "sanlucar-de-barrameda": Object.freeze({
    nombre: "Sanlúcar de Barrameda",
    nombreSeo: "Sanlúcar de Barrameda",
    filtro: "Sanlúcar de Barrameda",
    aliases: Object.freeze(["Sanlucar de Barrameda", "Sanlúcar de Barrameda", "Sanlucar", "Sanlúcar"]),
    introVenta: "Descubre propiedades en venta en Sanlúcar de Barrameda, una ciudad costera ideal para vivienda habitual o segunda residencia.",
    introAlquiler: "Busca alquileres en Sanlúcar de Barrameda y encuentra opciones para vivir cerca del centro, la playa o zonas tranquilas."
  }),
  rota: Object.freeze({
    nombre: "Rota",
    nombreSeo: "Rota",
    filtro: "Rota",
    aliases: Object.freeze(["Rota"]),
    introVenta: "Consulta viviendas en venta en Rota y encuentra anuncios de pisos, casas y apartamentos en una zona costera muy solicitada.",
    introAlquiler: "Explora pisos y casas en alquiler en Rota con filtros por precio, habitaciones y características de la vivienda."
  }),
  chipiona: Object.freeze({
    nombre: "Chipiona",
    nombreSeo: "Chipiona",
    filtro: "Chipiona",
    aliases: Object.freeze(["Chipiona"]),
    introVenta: "Encuentra casas y pisos en venta en Chipiona, con propiedades para residencia habitual, vacaciones o inversión.",
    introAlquiler: "Mira viviendas en alquiler en Chipiona y localiza opciones disponibles para vivir cerca del mar y de los servicios diarios."
  })
});

export function getSeoZoneSlugs() {
  return Object.keys(SEO_ZONES);
}

export function getSeoZoneLinks() {
  return getSeoZoneSlugs().map(slug => ({
    slug,
    nombre: SEO_ZONES[slug].nombre
  }));
}

export function getSeoZoneAliases(slug) {
  return SEO_ZONES[slug]?.aliases ? [...SEO_ZONES[slug].aliases] : [];
}

export function getSeoZoneContext({ operacionPath, slug, siteUrl = DEFAULT_SITE_URL } = {}) {
  if (!["comprar", "alquiler"].includes(operacionPath)) return null;
  const zona = SEO_ZONES[slug];
  if (!zona) return null;

  const esVenta = operacionPath === "comprar";
  const accion = esVenta ? "venta" : "alquiler";
  const accionTitulo = esVenta ? "en venta" : "en alquiler";
  const canonical = `${siteUrl}/${operacionPath}/${slug}`;
  const description = esVenta
    ? `Encuentra viviendas en venta en ${zona.nombreSeo}. Pisos, casas y propiedades publicadas en HomeClick24.`
    : `Encuentra viviendas en alquiler en ${zona.nombreSeo}. Pisos, casas y propiedades disponibles en HomeClick24.`;

  return {
    slug,
    zona: {
      nombre: zona.nombre,
      nombreSeo: zona.nombreSeo,
      filtro: zona.filtro
    },
    operacionPath,
    tipoOperacion: accion,
    accion,
    accionTitulo,
    canonical,
    title: `Pisos y casas ${accionTitulo} en ${zona.nombreSeo} | HomeClick24`,
    description,
    intro: esVenta ? zona.introVenta : zona.introAlquiler,
    h1: `Pisos y casas ${accionTitulo} en ${zona.nombreSeo}`,
    localContentTitle: `${esVenta ? "Comprar vivienda" : "Alquiler"} en ${zona.nombreSeo}`,
    localContent: esVenta
      ? `Compara viviendas en venta en ${zona.nombreSeo} con anuncios filtrados por ubicación, precio y características antes de contactar directamente con el anunciante.`
      : `Consulta viviendas en alquiler en ${zona.nombreSeo} con anuncios filtrados por ubicación, precio y características antes de contactar directamente con el anunciante.`,
    parentName: esVenta ? "Comprar" : "Alquiler",
    parentUrl: `${siteUrl}/${operacionPath}`,
    zoneLinks: getSeoZoneLinks()
  };
}

export function getSeoZoneContextFromPath(pathname = "", options = {}) {
  const match = String(pathname).match(/^\/(comprar|alquiler)\/([^/?#]+)$/);
  if (!match) return null;
  return getSeoZoneContext({
    operacionPath: match[1],
    slug: match[2],
    siteUrl: options.siteUrl || DEFAULT_SITE_URL
  });
}
