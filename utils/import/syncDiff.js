import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { syncFingerprint, SYNC_FINGERPRINT_VERSION, normalizedKey } from "./syncSnapshot.js";
import { validateImportProperty } from "./selectedImport.js";

const identityFields = new Set(["localidad", "provincia", "tipoOperacion", "tipoInmueble"]);

// Never return photo URLs or URLs embedded in arbitrary feed text (signed tokens).
export function safeSyncValue(value, field) {
  if (field === "imagenes") return value == null ? value : { count: value.length, fingerprint: crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex") };
  if (typeof value === "string") return value.replace(/https?:\/\/\S+/gi, "[enlace omitido]").replace(/<[^>]*>/g, "").slice(0, 500);
  return value;
}

function entryId(externalId) { return safeSyncValue(externalId || "", "externalId"); }

export function compareSyncSnapshot(snapshot, existing) {
  const byId = new Map();
  for (const property of existing) {
    const group = byId.get(property.externalId) || [];
    group.push(property);
    byId.set(property.externalId, group);
  }
  const seen = new Set();
  const results = [];
  for (const { data, errors } of snapshot.properties) {
    const externalId = data.externalId;
    seen.add(externalId);
    const base = { externalId: entryId(externalId) };
    if (errors.length) { results.push({ ...base, type: "INVALID", errors }); continue; }
    const matches = byId.get(externalId) || [];
    if (!matches.length) {
      const suspicious = existing.some(property => property.referencia === externalId
        || (data.titulo && data.direccion && property.titulo === data.titulo && property.direccion === data.direccion));
      if (suspicious) { results.push({ ...base, type: "CONFLICT", reason: "SUSPICIOUS_REFERENCE_CHANGE" }); continue; }
      const validation = validateImportProperty({ ...data, fotos: data.imagenes || [], errors: [] });
      results.push({ ...base, type: "NEW", resumen: { titulo: safeSyncValue(data.titulo, "titulo"), precio: data.precio, tipoOperacion: data.tipoOperacion, localidad: safeSyncValue(data.localidad, "localidad") },
        publishableByData: validation.errors.length === 0 && !data.crmWithdrawal && (!data.estadoComercial || data.estadoComercial === "Disponible"),
        validation: validation.errors.length ? ["INCOMPLETE_OR_INVALID_PUBLICATION_DATA"] : [] });
      continue;
    }
    if (matches.length !== 1) { results.push({ ...base, type: "CONFLICT", reason: "AMBIGUOUS_IDENTITY" }); continue; }
    const property = matches[0];
    // Legacy imports have no baseline/enrollment; never infer permission to overwrite them.
    if (property.syncEnabled !== true) { results.push({ ...base, type: "CONFLICT", reason: "PROPERTY_SYNC_DISABLED" }); continue; }
    const fingerprint = syncFingerprint(data);
    const changes = {};
    for (const [field, next] of Object.entries(data)) {
      if (field === "externalId") continue;
      const previous = field === "crmWithdrawal" ? Boolean(property.removedFromFeedAt) : property[field];
      if (!isDeepStrictEqual(previous, next)) changes[field] = {
        old: previous === undefined ? { absent: true } : safeSyncValue(previous, field),
        new: safeSyncValue(next, field), blockedByOverride: property.syncOverrides?.[field] === true
      };
    }
    const conflict = data.crmWithdrawal || Object.values(changes).some(change => change.blockedByOverride)
      || Object.keys(changes).some(field => identityFields.has(field) && normalizedKey(property[field]) !== normalizedKey(data[field]));
    // A matching baseline is only a hint: manual edits/overrides and actual field diffs win.
    const baselineMatches = property.syncFingerprintVersion === SYNC_FINGERPRINT_VERSION && property.syncFingerprint === fingerprint;
    results.push({ ...base, type: conflict ? "CONFLICT" : Object.keys(changes).length ? "UPDATE" : "UNCHANGED", changes, baselineMatches,
      fingerprint, fingerprintVersion: SYNC_FINGERPRINT_VERSION });
  }
  if (snapshot.snapshotComplete) {
    for (const property of existing) {
      if (!seen.has(property.externalId)) results.push({ externalId: entryId(property.externalId), type: "MISSING", protected: property.syncEnabled !== true });
    }
  }
  const summary = {};
  for (const [type, key] of Object.entries({ UNCHANGED: "unchangedCount", UPDATE: "updateCount", NEW: "newCount", MISSING: "missingCount", CONFLICT: "conflictCount", INVALID: "errorCount" })) {
    summary[key] = results.filter(result => result.type === type).length;
  }
  return { ...summary, results };
}
