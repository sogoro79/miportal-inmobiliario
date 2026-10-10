import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const SYNC_APPLY_V1_FIELDS = Object.freeze([
  "precio", "titulo", "descripcion", "habitaciones", "banos", "superficie", "garaje", "piscina", "terraza"
]);
export const SYNC_APPLY_FIELDS_VERSION = 1;
export const SYNC_NORMALIZATION_VERSION = 1;
export const SYNC_SNAPSHOT_VERSION = 1;
const textFields = new Set(["titulo", "descripcion"]);
const booleanFields = new Set(["garaje", "piscina", "terraza"]);

export function normalizedManagedValue(value, field) {
  if (value === undefined || value === null || value === "") return value;
  if (textFields.has(field) && typeof value === "string") return value.trim().replace(/\s+/g, " ");
  return value;
}

function tagged(value) {
  if (value === undefined) return ["absent"];
  if (value === null) return ["null"];
  return [typeof value, value];
}

export function managedFingerprint(data) {
  const values = SYNC_APPLY_V1_FIELDS.map(field => [field, tagged(normalizedManagedValue(data[field], field))]);
  return crypto.createHash("sha256").update(JSON.stringify({ version: SYNC_APPLY_FIELDS_VERSION,
    normalizationVersion: SYNC_NORMALIZATION_VERSION, values })).digest("hex");
}

export function validManagedData(data) {
  return SYNC_APPLY_V1_FIELDS.every(field => {
    const value = normalizedManagedValue(data[field], field);
    if (value === undefined) return true;
    if (textFields.has(field)) return field === "descripcion" && value === null ||
      typeof value === "string" && value.length <= (field === "titulo" ? 160 : 5000) && (field !== "titulo" || value.length > 0);
    if (booleanFields.has(field)) return typeof value === "boolean";
    if (field === "superficie" && value === null) return true;
    return typeof value === "number" && Number.isFinite(value) && value >= 0 &&
      (!["habitaciones", "banos"].includes(field) || Number.isInteger(value));
  });
}

export function proposedManagedContent(property, incoming) {
  return Object.fromEntries(SYNC_APPLY_V1_FIELDS.map(field => [field,
    Object.hasOwn(incoming, field) ? incoming[field] : property[field]]));
}

export function managedChangedFields(property, incoming) {
  return SYNC_APPLY_V1_FIELDS.filter(field => Object.hasOwn(incoming, field) &&
    !isDeepStrictEqual(normalizedManagedValue(property[field], field), normalizedManagedValue(incoming[field], field)));
}

// Feed photos and portal photos have different origins. Never infer equivalence.
export function suppliedNonPhotoDifferences(property, incoming) {
  return Object.keys(incoming).filter(field => !["externalId", "imagenes", "crmWithdrawal"].includes(field) &&
    !isDeepStrictEqual(normalizedManagedValue(property[field], field), normalizedManagedValue(incoming[field], field)));
}

export function hasOverrides(property) {
  const overrides = property.syncOverrides?.toObject?.() || property.syncOverrides || {};
  return Object.values(overrides).some(value => value === true);
}

export function baselineValid(property) {
  return property.syncEnabled === true && property.syncApplyFingerprintVersion === SYNC_APPLY_FIELDS_VERSION &&
    /^[a-f0-9]{64}$/.test(property.syncApplyFingerprint || "") &&
    validManagedData(property) && property.syncApplyFingerprint === managedFingerprint(property);
}

export function enrollmentCompatible(property, incoming) {
  return !incoming.crmWithdrawal && !hasOverrides(property) && validManagedData(property) &&
    validManagedData(incoming) && suppliedNonPhotoDifferences(property, incoming).length === 0;
}
