import crypto from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import {
  DEFAULT_MAX_PHOTOS_PER_PROPERTY,
  DEFAULT_MAX_PREVIEW_PROPERTIES,
  rejectUnsafeXml
} from "../import/feedSecurity.js";
import { normalizeSpanishPrice } from "../prices.js";
import { tipoInmuebleSchema } from "../propertySchemas.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true
});

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") {
    if ("#text" in value) return text(value["#text"]);
    if ("value" in value) return text(value.value);
    if ("url" in value) return text(value.url);
    return "";
  }
  return String(value).trim().replace(/\s+/g, " ");
}

function firstText(item, keys = []) {
  for (const key of keys) {
    const value = text(item?.[key]);
    if (value) return value;
  }
  return "";
}

function normalizeOperacion(value = "") {
  const normalized = value.toLowerCase();
  if (/(venta|sell|sale|comprar|for sale)/i.test(normalized)) return "venta";
  if (/(alquiler|rent|rental|lease|for rent)/i.test(normalized)) return "alquiler";
  return "";
}

function normalizeTipoInmueble(value = "") {
  const normalized = value.toLowerCase();
  const key = normalized.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[\s-]+/g, "_");
  if (tipoInmuebleSchema.options.includes(key)) return key;
  if (key === "casa_de_campo") return "casa_campo";
  if (/chalet/.test(normalized)) return "chalet";
  if (/casa de campo|country/.test(normalized)) return "casa_campo";
  if (/casa/.test(normalized)) return "casa";
  if (/apartamento|apartment/.test(normalized)) return "apartamento";
  if (/ático|atico|penthouse/.test(normalized)) return "atico";
  if (/local/.test(normalized)) return "local";
  if (/oficina/.test(normalized)) return "oficina";
  if (/terreno|solar|parcela|plot/.test(normalized)) return "terreno";
  return "piso";
}

function collectPhotos(value, output = [], maxPhotos = DEFAULT_MAX_PHOTOS_PER_PROPERTY) {
  if (!value || output.length >= maxPhotos) return output;
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value.trim())) output.push(value.trim());
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPhotos(item, output, maxPhotos);
    return output;
  }
  if (typeof value === "object") {
    const directUrl = text(value.url || value.src || value.href || value.link);
    if (/^https?:\/\//i.test(directUrl)) output.push(directUrl);
    for (const [key, nested] of Object.entries(value)) {
      if (/^(image|images|photo|photos|picture|pictures|url|urls|gallery|media)$/i.test(key)) {
        collectPhotos(nested, output, maxPhotos);
      }
    }
  }
  return [...new Set(output)].slice(0, maxPhotos);
}

function looksLikeProperty(node = {}) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return false;
  const keys = Object.keys(node).map(key => key.toLowerCase());
  return keys.some(key => ["price", "precio", "title", "titulo", "reference", "referencia", "operation", "operacion"].includes(key));
}

function collectPropertyNodes(node, output = []) {
  if (!node || output.length >= DEFAULT_MAX_PREVIEW_PROPERTIES) return output;
  if (Array.isArray(node)) {
    for (const item of node) collectPropertyNodes(item, output);
    return output;
  }
  if (typeof node !== "object") return output;

  if (looksLikeProperty(node)) {
    output.push(node);
    return output;
  }

  for (const [key, value] of Object.entries(node)) {
    if (/^(property|properties|inmueble|inmuebles|listing|listings|ad|ads|item|items|estate|realestate)$/i.test(key)) {
      collectPropertyNodes(value, output);
    }
  }
  return output;
}

export function parseGenericPropertyNodes(xml, limit) {
  rejectUnsafeXml(xml);
  if (XMLValidator.validate(xml) !== true) {
    throw Object.assign(new Error("El XML no tiene un formato válido."), { code: "XML_INVALID" });
  }
  const parsed = parser.parse(xml);
  const nodes = [];
  const warnings = new Set();
  const recordTag = /^(property|inmueble|listing|ad|item|estate)$/i;
  const containerTag = /^(feed|root|data|catalog|catalogue|properties|inmuebles|listings|ads|items|estates|realestate)$/i;
  const metadataTag = /^(id|title|name|description|version|updated|generated|next|nextPage|next_page|hasMore|has_more|total|totalCount|total_count|xmlns(?::.*)?|#text|\?xml)$/i;
  function inspectRecordChildren(node, depth) {
    if (nodes.length >= limit) return;
    if (depth > 64) { warnings.add("SNAPSHOT_STRUCTURE_LIMIT"); return; }
    if (Array.isArray(node)) {
      for (const item of node) inspectRecordChildren(item, depth + 1);
    } else if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (recordTag.test(key) || containerTag.test(key)) {
          warnings.add("SNAPSHOT_AMBIGUOUS_STRUCTURE");
          visit(value, key, depth + 1);
        } else {
          if (value && typeof value === "object" && !/^(imagenes|fotos|images|photos|image|photo|gallery|pictures|picture|url|src|href|link|descripcion|description|desc)$/i.test(key)) {
            warnings.add("SNAPSHOT_UNRECOGNIZED_STRUCTURE");
          }
          inspectRecordChildren(value, depth + 1);
        }
      }
    }
  }
  function visit(node, tag = "", depth = 0) {
    if (nodes.length >= limit) return;
    if (tag === "?xml") return;
    if (depth > 64) { warnings.add("SNAPSHOT_STRUCTURE_LIMIT"); return; }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, tag, depth + 1);
      return;
    }
    // Only explicit record tags are candidates; container metadata is never an estate.
    if (recordTag.test(tag)) {
      nodes.push(node);
      inspectRecordChildren(node, depth + 1);
      return;
    }
    if (tag && !containerTag.test(tag) && !metadataTag.test(tag)) warnings.add("SNAPSHOT_UNRECOGNIZED_STRUCTURE");
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (/^(next|nextPage|next_page|hasMore|has_more)$/i.test(key) && !["", "false", "0", false, null].includes(value)) warnings.add("SNAPSHOT_PAGINATION_UNSUPPORTED");
      if (/^(total|totalCount|total_count)$/i.test(key) && Number(value) > nodes.length) {
        // Check advertised totals after traversal (their position in XML is irrelevant).
        totals.push(Number(value));
      }
      visit(value, key, depth + 1);
    }
  }
  const totals = [];
  visit(parsed);
  if (totals.some(total => total > nodes.length)) warnings.add("SNAPSHOT_ADVERTISED_TOTAL_MISMATCH");
  return { nodes, warnings: [...warnings] };
}

function buildPreviewId(externalId, index) {
  return crypto
    .createHash("sha256")
    .update(`${externalId || "sin-id"}:${index}`)
    .digest("hex")
    .slice(0, 16);
}

function mapProperty(item = {}, index = 0, maxPhotos = DEFAULT_MAX_PHOTOS_PER_PROPERTY) {
  const externalId = firstText(item, ["externalId", "external_id", "id", "propertyId", "reference", "referencia", "ref"]);
  const titulo = firstText(item, ["titulo", "title", "name", "headline"]);
  const descripcion = firstText(item, ["descripcion", "description", "desc"]);
  const operacionRaw = firstText(item, ["tipoOperacion", "operation", "operacion", "type", "transaction"]);
  const tipoOperacion = normalizeOperacion(operacionRaw);
  const precioRaw = firstText(item, ["precio", "price", "amount"]);
  const precio = normalizeSpanishPrice(precioRaw);
  const direccion = firstText(item, ["direccion", "address", "street"]);
  const localidad = firstText(item, ["localidad", "city", "town", "municipality", "location"]);
  const provincia = firstText(item, ["provincia", "province", "state"]);
  const codigoPostal = firstText(item, ["codigoPostal", "postalCode", "postcode", "zip"]);
  const coordinate = (keys, limit) => {
    const raw = firstText(item, keys);
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) return null;
    const value = Number(raw);
    return Number.isFinite(value) && Math.abs(value) <= limit ? value : null;
  };
  const latitude = coordinate(["lat", "latitude", "latitud"], 90);
  const longitude = coordinate(["lng", "lon", "longitude", "longitud"], 180);
  const validCoordinates = latitude !== null && longitude !== null;
  const habitaciones = Number(firstText(item, ["habitaciones", "rooms", "bedrooms"])) || 0;
  const banos = Number(firstText(item, ["banos", "baños", "bathrooms"])) || 0;
  const superficie = Number(firstText(item, ["superficie", "surface", "area", "builtArea"])) || null;
  const tipoInmueble = normalizeTipoInmueble(firstText(item, ["tipoInmueble", "propertyType", "category", "subtype"]));
  const fotos = [...new Set(collectPhotos(item, [], maxPhotos))].slice(0, maxPhotos);
  const errors = [];
  const warnings = [];
  const commercial = firstText(item, ["estadoComercial", "commercialStatus", "status", "availability", "available"]);
  if (commercial && !/^(disponible|available|active|activo|true|1)$/i.test(commercial)) {
    errors.push("El inmueble no está disponible o su estado comercial no se reconoce; no se publicará.");
  }
  if (/^(true|1|yes|si|sí)$/i.test(firstText(item, ["sold", "vendido", "rented", "alquilado", "reserved", "reservado"]))) {
    errors.push("El inmueble está vendido, alquilado o reservado; no se publicará.");
  }

  if (!externalId) warnings.push("No se encontró referencia externa estable.");
  if (!titulo) errors.push("Falta el título.");
  if (!tipoOperacion) errors.push("No se pudo detectar si es venta o alquiler.");
  if (!Number.isFinite(precio)) errors.push("Falta el precio o no es válido.");
  if (!direccion && !localidad) warnings.push("No se encontró una ubicación clara.");
  if (!fotos.length) warnings.push("No se encontraron fotos.");

  return {
    previewId: buildPreviewId(externalId, index),
    externalId,
    titulo,
    descripcion,
    tipoOperacion,
    precio: Number.isFinite(precio) ? precio : null,
    direccion,
    localidad,
    provincia,
    codigoPostal,
    lat: validCoordinates ? latitude : null,
    lng: validCoordinates ? longitude : null,
    habitaciones,
    banos,
    superficie,
    tipoInmueble,
    garaje: /^(true|1|yes|si|sí)$/i.test(firstText(item, ["garaje", "garage"])),
    piscina: /^(true|1|yes|si|sí)$/i.test(firstText(item, ["piscina", "pool"])),
    terraza: /^(true|1|yes|si|sí)$/i.test(firstText(item, ["terraza", "terrace"])),
    fotos,
    errors,
    warnings
  };
}

export function analyzeGenericXml(xml, {
  maxProperties = DEFAULT_MAX_PREVIEW_PROPERTIES,
  maxPhotos = DEFAULT_MAX_PHOTOS_PER_PROPERTY
} = {}) {
  rejectUnsafeXml(xml);
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    const error = new Error("El XML no tiene un formato válido.");
    error.code = "XML_INVALID";
    throw error;
  }

  let parsed;
  try {
    parsed = parser.parse(xml);
  } catch {
    const error = new Error("El XML no tiene un formato válido.");
    error.code = "XML_INVALID";
    throw error;
  }

  const nodes = collectPropertyNodes(parsed).slice(0, maxProperties);
  if (!nodes.length) {
    const error = new Error("No se encontraron inmuebles en el feed.");
    error.code = "XML_EMPTY";
    throw error;
  }

  return nodes.map((item, index) => mapProperty(item, index, maxPhotos));
}
