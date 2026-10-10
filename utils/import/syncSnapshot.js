import crypto from "node:crypto";
import { parseGenericPropertyNodes } from "../importers/genericXmlImporter.js";
import { normalizeSpanishPrice } from "../prices.js";
import { tipoInmuebleSchema } from "../propertySchemas.js";
import { DEFAULT_MAX_XML_BYTES } from "./feedSecurity.js";

export const MAX_SYNC_PROPERTIES = 2000;
export const SYNC_FINGERPRINT_VERSION = 1;
export const SYNC_FIELDS = Object.freeze([
  "externalId", "titulo", "descripcion", "precio", "tipoOperacion", "direccion", "localidad",
  "provincia", "codigoPostal", "lat", "lng", "habitaciones", "banos", "superficie",
  "tipoInmueble", "estado", "estadoComercial", "imagenes", "garaje", "piscina", "terraza", "crmWithdrawal"
]);

const aliases = {
  externalId: ["externalId", "external_id", "id", "propertyId", "reference", "referencia", "ref"],
  titulo: ["titulo", "title", "name", "headline"],
  descripcion: ["descripcion", "description", "desc"],
  precio: ["precio", "price", "amount"],
  tipoOperacion: ["tipoOperacion", "operation", "operacion", "type", "transaction"],
  direccion: ["direccion", "address", "street"],
  localidad: ["localidad", "city", "town", "municipality", "location"],
  provincia: ["provincia", "province", "state"],
  codigoPostal: ["codigoPostal", "postalCode", "postcode", "zip"],
  lat: ["lat", "latitude", "latitud"], lng: ["lng", "lon", "longitude", "longitud"],
  habitaciones: ["habitaciones", "rooms", "bedrooms"], banos: ["banos", "baños", "bathrooms"],
  superficie: ["superficie", "surface", "area", "builtArea"],
  tipoInmueble: ["tipoInmueble", "propertyType", "category", "subtype"],
  estado: ["estado", "condition"],
  estadoComercial: ["estadoComercial", "commercialStatus", "status", "availability", "available"],
  imagenes: ["imagenes", "fotos", "images", "photos", "image", "photo", "gallery", "pictures"],
  garaje: ["garaje", "garage"], piscina: ["piscina", "pool"], terraza: ["terraza", "terrace"]
};

const propertyTypes = new Map(Object.entries({ apartment: "apartamento", flat: "piso", house: "casa", country_house: "casa_campo", casa_de_campo: "casa_campo" }));
const conditions = new Map(Object.entries({ obra_nueva: "obra_nueva", new: "obra_nueva", segunda_mano: "segunda_mano", used: "segunda_mano", resale: "segunda_mano" }));
const commercialStatuses = new Map(Object.entries({ available: "Disponible", active: "Disponible", disponible: "Disponible", reserved: "Reservado", reservado: "Reservado", sold: "Vendido", vendido: "Vendido", rented: "Alquilado", alquilado: "Alquilado" }));

export function normalizedKey(value) {
  return String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function scalar(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    if (raw["xsi:nil"] === "true" || raw.nil === "true") return null;
    if (Object.hasOwn(raw, "#text")) return scalar(raw["#text"]);
    throw new Error("INVALID_VALUE");
  }
  if (typeof raw === "string") return raw.trim().replace(/\s+/g, " ");
  if (raw === null || typeof raw === "number" || typeof raw === "boolean") return raw;
  throw new Error("INVALID_VALUE");
}

function photos(raw, output = []) {
  if (output.length > 500) throw new Error("TOO_MANY_PHOTOS");
  if (Array.isArray(raw)) for (const item of raw) photos(item, output);
  else if (raw && typeof raw === "object") {
    if (!Object.keys(raw).some(key => /^(url|src|href|link|image|images|photo|photos|picture|pictures)$/i.test(key))) throw new Error("INVALID_PHOTO");
    for (const [key, value] of Object.entries(raw)) {
      if (/^(url|src|href|link|image|images|photo|photos|picture|pictures)$/i.test(key)) photos(value, output);
    }
  } else if (raw !== "" && raw !== null) {
    const url = new URL(String(raw));
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("INVALID_PHOTO");
    output.push(url.toString());
  }
  return output;
}

// Absence is represented by an omitted key; explicit empty/zero/false/null stay distinct.
export function normalizeSyncProperty(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return { data: {}, errors: ["INVALID_RECORD"] };
  const data = {};
  const errors = [];
  const keys = new Map(Object.keys(node).map(key => [key.toLowerCase(), key]));
  for (const field of SYNC_FIELDS.filter(field => aliases[field])) {
    const alias = aliases[field].find(key => keys.has(key.toLowerCase()));
    if (!alias) continue;
    const raw = node[keys.get(alias.toLowerCase())];
    try {
      let value = scalar(field === "imagenes" ? "" : raw);
      if (field === "imagenes") {
        value = raw === null || raw?.["xsi:nil"] === "true" ? null : photos(raw);
        if (Array.isArray(value) && value.length > 500) throw new Error("TOO_MANY_PHOTOS");
      } else if (value !== null && value !== "") {
        if (["precio", "lat", "lng", "habitaciones", "banos", "superficie"].includes(field)) {
          if (!["number", "string"].includes(typeof value)) throw new Error("INVALID_NUMBER");
          value = field === "precio" ? normalizeSpanishPrice(value) : Number(value);
          if (!Number.isFinite(value)) throw new Error("INVALID_NUMBER");
          if (["precio", "habitaciones", "banos", "superficie"].includes(field) && value < 0) throw new Error("INVALID_NUMBER");
          if (["habitaciones", "banos"].includes(field) && !Number.isInteger(value)) throw new Error("INVALID_NUMBER");
          if ((field === "lat" && Math.abs(value) > 90) || (field === "lng" && Math.abs(value) > 180)) throw new Error("INVALID_COORDINATE");
        } else if (["garaje", "piscina", "terraza"].includes(field)) {
          if (/^(true|1|yes|si|sí)$/i.test(String(value))) value = true;
          else if (/^(false|0|no)$/i.test(String(value))) value = false;
          else throw new Error("INVALID_BOOLEAN");
        } else if (field === "tipoOperacion") {
          const op = normalizedKey(value);
          value = ["venta", "sale", "sell", "for_sale"].includes(op) ? "venta"
            : ["alquiler", "rent", "rental", "lease", "for_rent"].includes(op) ? "alquiler" : undefined;
          if (!value) throw new Error("UNKNOWN_OPERATION");
        } else if (field === "tipoInmueble") {
          const key = normalizedKey(value);
          value = propertyTypes.get(key) || key;
          if (!tipoInmuebleSchema.options.includes(value)) throw new Error("UNKNOWN_PROPERTY_TYPE");
        } else if (field === "estado") {
          value = conditions.get(normalizedKey(value));
          if (!["obra_nueva", "segunda_mano"].includes(value)) throw new Error("UNKNOWN_CONDITION");
        } else if (field === "estadoComercial") {
          const status = normalizedKey(value);
          const mapped = commercialStatuses.get(status);
          if (["withdrawn", "inactive", "deleted"].includes(status)) { data.crmWithdrawal = true; continue; }
          if (!["Disponible", "Reservado", "Vendido", "Alquilado"].includes(mapped)) throw new Error("UNKNOWN_COMMERCIAL_STATUS");
          value = mapped;
        } else {
          value = String(value);
          const max = field === "descripcion" ? 5000 : field === "titulo" ? 160 : field === "externalId" ? 200 : 300;
          if (value.length > max) throw new Error("TEXT_TOO_LONG");
        }
      }
      data[field] = value;
    } catch { errors.push(`INVALID_${field}`); }
  }
  if (typeof data.externalId !== "string" || !data.externalId) errors.push("INVALID_externalId");
  const flaggedStatuses = [];
  for (const [alias, status] of Object.entries({ sold: "Vendido", vendido: "Vendido", rented: "Alquilado", alquilado: "Alquilado", reserved: "Reservado", reservado: "Reservado" })) {
    if (!keys.has(alias)) continue;
    try {
      const value = scalar(node[keys.get(alias)]);
      if (/^(true|1|yes|si|sí)$/i.test(String(value))) flaggedStatuses.push(status);
      else if (!/^(false|0|no)$/i.test(String(value))) errors.push("INVALID_estadoComercial");
    } catch { errors.push("INVALID_estadoComercial"); }
  }
  const flagged = [...new Set(flaggedStatuses)];
  if (flagged.length > 1 || (flagged.length && (data.crmWithdrawal || (Object.hasOwn(data, "estadoComercial") && data.estadoComercial !== flagged[0])))) errors.push("CONTRADICTORY_COMMERCIAL_STATUS");
  else if (flagged.length) data.estadoComercial = flagged[0];
  if (typeof data.externalId === "string" && (/https?:\/\//i.test(data.externalId) || /[<>&?=\u0000-\u001f]/.test(data.externalId))) errors.push("SUSPICIOUS_EXTERNAL_ID");
  for (const field of ["titulo", "direccion"]) {
    if (Object.hasOwn(data, field) && (typeof data[field] !== "string" || !data[field])) errors.push(`INVALID_${field}`);
  }
  for (const field of ["precio", "habitaciones", "tipoOperacion", "tipoInmueble", "estado", "estadoComercial"]) {
    if (Object.hasOwn(data, field) && data[field] === null) errors.push(`INVALID_${field}`);
  }
  for (const field of ["precio", "lat", "lng", "habitaciones", "banos", "superficie", "tipoOperacion", "tipoInmueble", "estado", "estadoComercial", "garaje", "piscina", "terraza"]) {
    if (Object.hasOwn(data, field) && data[field] === "") errors.push(`INVALID_${field}`);
  }
  return { data, errors: [...new Set(errors)] };
}

export function syncFingerprint(data, version = SYNC_FINGERPRINT_VERSION) {
  const values = SYNC_FIELDS.filter(field => Object.hasOwn(data, field)).map(field => [field, data[field]]);
  return crypto.createHash("sha256").update(JSON.stringify({ version, values })).digest("hex");
}

export function buildSyncSnapshot(xml) {
  if (Buffer.byteLength(xml, "utf8") > DEFAULT_MAX_XML_BYTES) {
    throw Object.assign(new Error("El feed supera el tamaño permitido."), { code: "FEED_TOO_LARGE" });
  }
  // One extra node detects the ceiling instead of silently assuming a complete feed.
  const { nodes, warnings } = parseGenericPropertyNodes(xml, MAX_SYNC_PROPERTIES + 1);
  const properties = nodes.slice(0, MAX_SYNC_PROPERTIES).map(normalizeSyncProperty);
  const counts = new Map();
  for (const { data } of properties) counts.set(data.externalId, (counts.get(data.externalId) || 0) + 1);
  for (const property of properties) {
    if (counts.get(property.data.externalId) > 1) property.errors.push("DUPLICATE_EXTERNAL_ID");
  }
  if (!nodes.length) warnings.push("EMPTY_OR_UNRECOGNIZED_FEED");
  if (nodes.length > MAX_SYNC_PROPERTIES) warnings.push("SNAPSHOT_LIMIT_EXCEEDED");
  if (properties.some(item => item.errors.length)) warnings.push("SNAPSHOT_INVALID_RECORDS");
  const snapshotComplete = warnings.length === 0;
  if (!snapshotComplete) warnings.push("MISSING_DISABLED_INCOMPLETE_SNAPSHOT");
  return { snapshotComplete, snapshotCount: properties.length, properties, warnings };
}
