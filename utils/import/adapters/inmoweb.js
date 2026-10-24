import { XMLParser, XMLValidator } from "fast-xml-parser";
import { DEFAULT_MAX_XML_BYTES, DEFAULT_MAX_PREVIEW_PROPERTIES, rejectUnsafeXml, parseAndValidateFeedUrl } from "../feedSecurity.js";
import { MAX_SYNC_PROPERTIES } from "../syncSnapshot.js";
import { evaluateInmowebNewEligibility } from "../inmowebNewEligibility.js";
import { buildPublicLocation } from "../../publicLocation.js";
import { normalizeSpanishPrice } from "../../prices.js";
import { canonicalizeInmowebTitle } from "../inmowebTitle.js";

export const INMOWEB_NORMALIZATION_VERSION = 1;
const families = new Map(Object.entries({
  1: "apartamento", 3: "chalet", 9: "finca_rustica", 10: "local_comercial",
  16: "casa_campo", 20: "casa", 21: "adosado", 22: "duplex", 24: "piso"
}));
const operations = new Map([["1", "venta"], ["2", "alquiler"]]);
const conditions = new Map([["ON", "obra_nueva"], ["SM", "segunda_mano"]]);
const statuses = new Map([["activo", "Disponible"], ["reservado", "Reservado"]]);
const featureValues = new Map([
  ["garaje", new Map([["si", true], ["privado", true], ["no", false]])],
  ["piscina", new Map([["comunitaria", true], ["privada", true], ["no", false]])],
  ["terraza", new Map([["acristalada", true], ["no acristalada", true], ["no", false]])]
]);
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", parseTagValue: false, parseAttributeValue: false, trimValues: true });
const array = value => value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
const scalar = value => typeof value === "string" ? value.trim() :
  value && typeof value === "object" && !Array.isArray(value) && typeof value["#text"] === "string" ? value["#text"].trim() : "";
const attr = (value, name) => scalar(value?.[`@_${name}`]);
const text = value => scalar(value).replace(/\s+/g, " ");
const object = value => Boolean(value && typeof value === "object" && !Array.isArray(value));
const fail = code => { throw Object.assign(new Error("El feed InmoWeb no tiene un formato compatible."), { code }); };

function parse(xml) {
  if (typeof xml !== "string") fail("XML_INVALID");
  if (Buffer.byteLength(xml, "utf8") > DEFAULT_MAX_XML_BYTES) fail("FEED_TOO_LARGE");
  rejectUnsafeXml(xml);
  if (XMLValidator.validate(xml) !== true) fail("XML_INVALID");
  try { return parser.parse(xml); } catch { return fail("XML_INVALID"); }
}

export function isInmowebXml(xml) {
  const parsed = parse(xml);
  return Object.keys(parsed).filter(key => key !== "?xml").length === 1 &&
    object(parsed.properties) && Object.hasOwn(parsed.properties, "propiedad");
}

function normalizeRecord(record) {
  const errors = [], warnings = [];
  const block = code => { errors.push(code); warnings.push(code); };
  if (!object(record)) record = {};
  const number = (value, field, integer = false) => {
    const raw = scalar(value);
    if (!raw) return null;
    const n = Number(raw);
    if (!/^\d+(?:\.\d+)?$/.test(raw) || !Number.isFinite(n) || (integer && !Number.isInteger(n))) {
      block(`INMOWEB_INVALID_${field}`); return null;
    }
    return n;
  };
  const externalId = attr(record, "id");
  if (!externalId || externalId.length > 200 || /https?:\/\/|[<>&?=\u0000-\u001f]/i.test(externalId)) block("INMOWEB_INVALID_ID");
  const operationId = attr(record.operacion, "id"), familyId = attr(record.familia, "id");
  const tipoOperacion = operations.get(operationId) ?? null;
  if (!tipoOperacion) block("INMOWEB_UNSUPPORTED_OPERATION");
  const tipoInmueble = families.get(familyId) ?? null;
  if (!tipoInmueble) block("INMOWEB_UNSUPPORTED_FAMILY");
  const conditionId = attr(record.estado, "id");
  const estado = conditionId ? conditions.get(conditionId) ?? null : "no_informado";
  if (!estado) block("INMOWEB_UNSUPPORTED_CONDITION");
  if (estado === "no_informado") warnings.push("INMOWEB_CONDITION_UNKNOWN");
  const commercialStatus = text(record.status_id).toLowerCase();
  const estadoComercial = statuses.get(commercialStatus) ?? null;
  if (estadoComercial !== "Disponible") block("INMOWEB_COMMERCIAL_UNAVAILABLE");
  const moneda = attr(record.precio, "divisa").toUpperCase() || null;
  if (moneda !== "EUR") block("INMOWEB_UNSUPPORTED_CURRENCY");
  const parsedPrice = normalizeSpanishPrice(scalar(record.precio));
  const precio = Number.isFinite(parsedPrice) && parsedPrice >= 0 ? parsedPrice : null;
  if (precio === null) block("INMOWEB_INVALID_PRICE");
  if (precio !== null && precio <= 1) warnings.push("INMOWEB_PRICE_REVIEW_REQUIRED");

  const translations = new Map();
  for (const entry of array(record.descripciones?.descripcion)) {
    const lang = attr(entry, "idioma");
    if (!["es", "gb"].includes(lang)) { warnings.push("INMOWEB_LANGUAGE_NOT_MAPPED"); continue; }
    if (translations.has(lang)) { block("INMOWEB_DUPLICATE_LANGUAGE"); continue; }
    translations.set(lang, { titulo: text(entry.titulo), descripcion: text(entry.descripcion) });
  }
  const spanish = translations.get("es");
  if (!spanish?.titulo) block("INMOWEB_SPANISH_TITLE_MISSING");
  const location = object(record.localizacion) ? record.localizacion : {};
  // No postal street is supplied by this contract; locality/zone are never fabricated into one.
  const direccion = "";
  if (!text(location.poblacion)) block("INMOWEB_LOCATION_INSUFFICIENT");
  const latRaw = scalar(location.latitud), lngRaw = scalar(location.longitud);
  const coordinate = (raw, limit) => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw) && Number.isFinite(Number(raw)) && Math.abs(Number(raw)) <= limit;
  const validCoordinates = coordinate(latRaw, 90) && coordinate(lngRaw, 180);
  if ((latRaw || lngRaw) && !validCoordinates) warnings.push("INMOWEB_INVALID_COORDINATES");
  const surfaces = {
    construida: number(record.superficies?.construida, "BUILT_AREA"),
    habitable: number(record.superficies?.habitable, "LIVING_AREA"),
    parcela: number(record.superficies?.parcela, "PLOT_AREA")
  };
  const habitaciones = number(record.dormitorios, "BEDROOMS", true);
  const banos = number(record.banos, "BATHROOMS", true);
  if (habitaciones === null) warnings.push("INMOWEB_BEDROOMS_UNKNOWN");
  const features = new Map();
  for (const entry of array(record.caracteristicas?.caracteristica)) {
    const id = attr(entry, "id");
    if (!id) { warnings.push("INMOWEB_FEATURE_INVALID"); continue; }
    features.set(id, [...(features.get(id) || []), text(entry)]);
  }
  const booleans = {};
  for (const [field, mapping] of featureValues) {
    const values = [...new Set((features.get(field) || []).filter(Boolean).map(v => v.toLowerCase()))];
    if (!values.length) continue;
    if (values.length !== 1 || !mapping.has(values[0])) { warnings.push("INMOWEB_FEATURE_UNMAPPED"); continue; }
    booleans[field] = mapping.get(values[0]);
  }
  const photos = [];
  for (const entry of array(record.imagenes?.imagen)) {
    try {
      const raw = attr(entry, "url");
      const url = parseAndValidateFeedUrl(raw);
      if (url.hash) throw new Error();
      photos.push({ url: url.toString(), primary: attr(entry, "principal") === "1" });
    } catch { warnings.push("INMOWEB_IMAGE_URL_REJECTED"); }
  }
  const imagenes = [...new Set([...photos.filter(p => p.primary), ...photos.filter(p => !p.primary)].map(p => p.url))];
  const data = {
    externalId, referencia: text(record.referencia), titulo: spanish?.titulo || "", descripcion: spanish?.descripcion || "",
    tipoOperacion, tipoInmueble, estado, estadoComercial, precio, moneda, periodicidadPrecio: tipoOperacion === "alquiler" ? "desconocida" : null,
    habitaciones, habitacionesEstado: habitaciones === null ? "desconocido" : "informado",
    banos, superficie: surfaces.construida, superficieParcela: surfaces.parcela,
    direccion, localidad: text(location.poblacion), provincia: text(location.provincia),
    codigoPostal: text(location.cp), pais: text(location.pais), zona: text(location.zona),
    lat: validCoordinates ? Number(latRaw) : null, lng: validCoordinates ? Number(lngRaw) : null,
    ...booleans, imagenes
  };
  data.precisionUbicacion = "aproximada";
  data.ubicacionPublica = buildPublicLocation(data);
  const canonicalTitle = canonicalizeInmowebTitle(data);
  data.titulo = canonicalTitle.titulo;
  if (canonicalTitle.normalized) warnings.push("INMOWEB_TITLE_NORMALIZED");
  const toilets = number(record.aseos, "TOILETS", true);
  const eligibility = evaluateInmowebNewEligibility({ ...data, errors, warnings });
  return { data, metadata: { operationId, familyId, conditionId, commercialStatus,
    superficies: surfaces, aseos: toilets,
    traducciones: Object.fromEntries(translations), caracteristicas: Object.fromEntries(features) },
    errors: eligibility.blockingIssues, warnings: eligibility.warnings, publishableByData: eligibility.eligible };
}

export function normalizeInmowebXml(xml) {
  const parsed = parse(xml);
  if (Object.keys(parsed).filter(k => k !== "?xml").length !== 1 || !object(parsed.properties) ||
      !Object.hasOwn(parsed.properties, "propiedad")) fail("INMOWEB_FORMAT_UNRECOGNIZED");
  const root = parsed.properties;
  const records = array(root.propiedad);
  const warnings = [];
  const extraRoot = Object.keys(root).filter(k => k !== "propiedad");
  if (extraRoot.length) warnings.push("INMOWEB_STRUCTURE_UNVERIFIED");
  if (records.length > MAX_SYNC_PROPERTIES) warnings.push("SNAPSHOT_LIMIT_EXCEEDED");
  const properties = records.slice(0, MAX_SYNC_PROPERTIES).map(normalizeRecord);
  const ids = new Map();
  // Validate identity against the whole received catalogue, even beyond the processing ceiling.
  for (const record of records) {
    const id = attr(record, "id");
    if (id) ids.set(id, (ids.get(id) || 0) + 1);
  }
  for (const p of properties) if (ids.get(p.data.externalId) > 1) {
    p.errors.push("INMOWEB_DUPLICATE_ID"); p.warnings.push("INMOWEB_DUPLICATE_ID"); p.publishableByData = false;
  }
  // Phase 1 cannot certify that a provider response is the complete source catalogue.
  warnings.push("INMOWEB_COMPLETENESS_UNVERIFIED", "MISSING_DISABLED_INCOMPLETE_SNAPSHOT");
  return { feedType: "inmoweb", normalizationVersion: INMOWEB_NORMALIZATION_VERSION,
    total: records.length, snapshotCount: properties.length, snapshotComplete: false,
    structurallyComplete: !extraRoot.length && records.length <= MAX_SYNC_PROPERTIES,
    properties, warnings };
}

export function analyzeInmowebXml(xml, { maxProperties = DEFAULT_MAX_PREVIEW_PROPERTIES } = {}) {
  if (!Number.isSafeInteger(maxProperties) || maxProperties < 1 || maxProperties > MAX_SYNC_PROPERTIES) fail("INMOWEB_INVALID_PREVIEW_LIMIT");
  const normalized = normalizeInmowebXml(xml);
  const truncated = normalized.properties.length > maxProperties || normalized.total > normalized.properties.length;
  return { ...normalized, previewTruncated: truncated,
    warnings: [...normalized.warnings, ...(truncated ? ["INMOWEB_PREVIEW_TRUNCATED"] : [])],
    properties: normalized.properties.slice(0, maxProperties).map(p => ({
      ...p.data, fotos: p.data.imagenes, metadata: p.metadata,
      errors: p.errors, warnings: p.warnings, publishableByData: p.publishableByData
    })) };
}

export function buildInmowebSnapshot(xml) {
  return normalizeInmowebXml(xml);
}
