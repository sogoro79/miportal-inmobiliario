import { propiedadCrmCreateSchema, estadoSchema, tipoInmuebleSchema } from "../propertySchemas.js";
import { canonicalizeInmowebTitle } from "./inmowebTitle.js";

// Future data eligibility only: this does not authorize or execute an import.
export function evaluateInmowebNewEligibility(property = {}) {
  const blocking = new Set(property.errors || []);
  const warnings = new Set(property.warnings || []);
  const canonicalTitle = canonicalizeInmowebTitle(property);
  if (canonicalTitle.normalized) warnings.add("INMOWEB_TITLE_NORMALIZED");
  const block = code => blocking.add(code);
  if (typeof property.externalId !== "string" || !property.externalId.trim() || property.externalId.length > 200 ||
      /https?:\/\/|[<>&?=\u0000-\u001f]/i.test(property.externalId)) block("INMOWEB_INVALID_ID");
  if (typeof property.titulo !== "string" || !property.titulo.trim()) block("INMOWEB_SPANISH_TITLE_MISSING");
  if (!["venta", "alquiler"].includes(property.tipoOperacion)) block("INMOWEB_UNSUPPORTED_OPERATION");
  if (!tipoInmuebleSchema.safeParse(property.tipoInmueble).success) block("INMOWEB_UNSUPPORTED_FAMILY");
  if (!estadoSchema.safeParse(property.estado).success) block(property.estado ? "INMOWEB_UNSUPPORTED_CONDITION" : "INMOWEB_CONDITION_UNKNOWN");
  if (property.estadoComercial !== "Disponible") block("INMOWEB_COMMERCIAL_UNAVAILABLE");
  if (property.moneda !== "EUR") block("INMOWEB_UNSUPPORTED_CURRENCY");
  if (typeof property.precio !== "number" || !Number.isFinite(property.precio) || property.precio < 0) block("INMOWEB_INVALID_PRICE");
  else if (property.precio <= 1) warnings.add("INMOWEB_PRICE_REVIEW_REQUIRED");
  if (property.tipoOperacion === "alquiler" && (property.periodicidadPrecio == null || property.periodicidadPrecio === "desconocida")) warnings.add("INMOWEB_RENT_PERIOD_UNKNOWN");
  if (typeof property.localidad !== "string" || !property.localidad.trim()) block("INMOWEB_LOCATION_INSUFFICIENT");
  if (property.habitaciones === null || property.habitaciones === undefined || property.habitaciones === "") block("INMOWEB_BEDROOMS_UNKNOWN");
  if (property.banos === null || property.banos === undefined || property.banos === "") warnings.add("INMOWEB_BATHROOMS_UNKNOWN");
  if (property.superficie === null || property.superficie === undefined || property.superficie === "") warnings.add("INMOWEB_BUILT_AREA_UNKNOWN");
  if (!(property.fotos || property.imagenes || []).length) warnings.add("INMOWEB_IMAGES_MISSING");
  if (!propiedadCrmCreateSchema.safeParse({ ...property, titulo: canonicalTitle.titulo }).success) block("INMOWEB_PUBLICATION_DATA_INVALID");
  // Adapter errors remain authoritative (e.g. duplicate IDs or malformed optional numbers).
  for (const code of blocking) warnings.delete(code);
  return { eligible: blocking.size === 0, blockingIssues: [...blocking], warnings: [...warnings] };
}
