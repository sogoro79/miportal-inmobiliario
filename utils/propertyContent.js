import { isDeepStrictEqual } from "node:util";

export const CONTENT_FIELDS = Object.freeze([
  "titulo", "referencia", "descripcion", "precio", "tipoOperacion", "direccion", "localidad",
  "provincia", "codigoPostal", "lat", "lng", "habitaciones", "banos", "superficie",
  "superficieParcela", "tipoInmueble", "estado", "estadoComercial", "estadoPropiedad",
  "certificadoEnergetico", "imagenes", "garaje", "piscina", "terraza", "escaparate",
  "usoPermitido", "plantaLocal", "numeroPlantas", "sotano", "alturaMaxima", "tipoGaraje",
  "accesoTrastero", "videoUrl", "visiblePublicamente"
]);

export function capturePropertyContent(property) {
  return Object.fromEntries(CONTENT_FIELDS.map(field => [field, Array.isArray(property[field]) ? Array.from(property[field]) : property[field]]));
}

export function markManualContentChanges(property, before) {
  const fields = CONTENT_FIELDS.filter(field => !isDeepStrictEqual(before[field], property[field]));
  if (!fields.length) return fields;
  // Mongoose $inc keeps revisions monotonic even for concurrent manual saves.
  if (typeof property.$inc === "function") property.$inc("contentRevision", 1);
  else property.contentRevision = (property.contentRevision || 0) + 1;
  if (property.source === "crm" && property.syncEnabled === true) {
    for (const field of fields) {
      if (typeof property.set === "function") property.set(`syncOverrides.${field}`, true);
      else { property.syncOverrides ||= {}; property.syncOverrides[field] = true; }
    }
  }
  return fields;
}
