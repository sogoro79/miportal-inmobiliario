import { maskFeedUrl } from "./feedSecurity.js";

const messages = new Map(Object.entries({
  INMOWEB_LOCATION_INSUFFICIENT: "Falta una localidad válida para ubicar el inmueble.",
  INMOWEB_RENT_PERIOD_UNKNOWN: "El alquiler no indica periodicidad; no se asume un precio mensual.",
  INMOWEB_CONDITION_UNKNOWN: "No se ha informado si es obra nueva o segunda mano.",
  INMOWEB_UNSUPPORTED_CONDITION: "La condición del inmueble no se reconoce.",
  INMOWEB_UNSUPPORTED_FAMILY: "El tipo de inmueble no está soportado.",
  INMOWEB_UNSUPPORTED_OPERATION: "La operación no está soportada.",
  INMOWEB_UNSUPPORTED_CURRENCY: "La moneda falta o no está soportada; no se convierte el precio.",
  INMOWEB_PRICE_REVIEW_REQUIRED: "El precio requiere revisión; se conserva el valor recibido.",
  INMOWEB_INVALID_PRICE: "El precio no es válido.",
  INMOWEB_INVALID_ID: "El identificador externo falta o no es válido.",
  INMOWEB_DUPLICATE_ID: "El identificador externo está repetido en el feed.",
  INMOWEB_BEDROOMS_UNKNOWN: "No se ha informado el número de dormitorios.",
  INMOWEB_BATHROOMS_UNKNOWN: "No se ha informado el número de baños.",
  INMOWEB_INVALID_BEDROOMS: "El número de dormitorios no es válido.",
  INMOWEB_INVALID_BATHROOMS: "El número de baños no es válido.",
  INMOWEB_INVALID_TOILETS: "El número de aseos no es válido.",
  INMOWEB_INVALID_BUILT_AREA: "La superficie construida no es válida.",
  INMOWEB_INVALID_LIVING_AREA: "La superficie habitable no es válida.",
  INMOWEB_INVALID_PLOT_AREA: "La superficie de parcela no es válida.",
  INMOWEB_SPANISH_TITLE_MISSING: "Falta el título en español.",
  INMOWEB_DUPLICATE_LANGUAGE: "Hay textos duplicados para un mismo idioma.",
  INMOWEB_COMMERCIAL_UNAVAILABLE: "El estado comercial no permite publicar el anuncio.",
  INMOWEB_INVALID_COORDINATES: "Las coordenadas están incompletas o no son válidas; no se utilizarán.",
  INMOWEB_IMAGE_URL_REJECTED: "Se ha descartado una URL de imagen no válida o no permitida.",
  INMOWEB_FEATURE_UNMAPPED: "Hay características que requieren una regla de equivalencia.",
  INMOWEB_FEATURE_INVALID: "Hay características sin identificador válido.",
  INMOWEB_LANGUAGE_NOT_MAPPED: "Hay idiomas que no se utilizan en este preview.",
  INMOWEB_PUBLICATION_DATA_INVALID: "Hay campos obligatorios ausentes o datos de publicación no válidos.",
  INMOWEB_REVIEW_REQUIRED: "Hay datos que requieren revisión."
}));

function safeText(value, max = 160, redactPhone = true) {
  if (typeof value !== "string") return "";
  let result = value.replace(/<[^>]*>/g, "").replace(/https?:\/\/\S+/gi, "[enlace omitido]")
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[correo omitido]");
  if (redactPhone) result = result.replace(/\+?\d[\d\s().-]{7,}\d/g, "[teléfono omitido]");
  return result.replace(/[\u0000-\u001f]/g, " ").slice(0, max);
}

const number = value => typeof value === "number" && Number.isFinite(value) ? value : null;
const logCodes = new Set(["XML_INVALID", "XML_EMPTY", "UNSUPPORTED_FEED_TYPE", "INMOWEB_FORMAT_UNRECOGNIZED", "INMOWEB_INVALID_PREVIEW_LIMIT",
  "INVALID_URL", "INVALID_PROTOCOL", "PRIVATE_HOST", "PRIVATE_IP", "DNS_LOOKUP_FAILED", "FEED_UNREACHABLE", "FEED_TIMEOUT", "FEED_TOO_LARGE",
  "FEED_TRUNCATED", "TOO_MANY_REDIRECTS", "INVALID_REDIRECT", "BAD_STATUS", "INVALID_CONTENT_TYPE", "XML_DOCTYPE_BLOCKED", "XML_ENTITY_BLOCKED"]);

export function safeAnalysisErrorCode(error) {
  return logCodes.has(error?.code) ? error.code : "ANALYSIS_FAILED";
}

export function safeInmowebPreview(analyzed) {
  return {
    feedType: "inmoweb", previewOnly: true, importEnabled: false, syncEnabled: false,
    puedePublicarAhora: false, snapshotComplete: false,
    total: analyzed.total, returned: analyzed.properties.length,
    previewTruncated: analyzed.previewTruncated === true,
    properties: analyzed.properties.map(p => {
      const blocking = new Set(p.errors || []);
      const issues = [...new Set([...blocking, ...(p.warnings || [])])].map(value => {
        const code = messages.has(value) ? value : "INMOWEB_REVIEW_REQUIRED";
        return { code, severity: blocking.has(value) ? "blocking" : "warning", message: messages.get(code) };
      });
      return {
        externalId: safeText(p.externalId, 200, false), referencia: safeText(p.referencia, 80, false),
        titulo: safeText(p.titulo), tipoOperacion: safeText(p.tipoOperacion, 30),
        precio: number(p.precio), moneda: safeText(p.moneda, 10), periodicidadPrecio: null,
        tipoInmueble: safeText(p.tipoInmueble, 40), estado: safeText(p.estado, 30),
        localidad: safeText(p.localidad, 120), provincia: safeText(p.provincia, 120),
        ubicacionPublica: safeText(p.ubicacionPublica, 300), precisionUbicacion: "aproximada",
        codigoPostal: safeText(p.codigoPostal, 20, false),
        habitaciones: number(p.habitaciones), banos: number(p.banos), superficie: number(p.superficie),
        fotosDisponibles: Array.isArray(p.fotos) ? p.fotos.length : 0, fotosImportables: 0,
        publishableByData: p.publishableByData === true, issues,
        errors: issues.filter(i => i.severity === "blocking").map(i => i.message),
        warnings: issues.filter(i => i.severity === "warning").map(i => i.message)
      };
    })
  };
}

export function maskAnalysisFeedUrl(rawUrl) {
  try {
    if (new URL(rawUrl).hostname === "feed.inmoweb.es") return "https://feed.inmoweb.es/?key=********";
  } catch { /* Invalid URLs use the existing safe fallback. */ }
  return maskFeedUrl(rawUrl);
}
