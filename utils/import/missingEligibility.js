import crypto from "node:crypto";
import { CONTENT_FIELDS } from "../propertyContent.js";
import { baselineValid, hasOverrides, SYNC_APPLY_FIELDS_VERSION } from "./syncBaseline.js";

export const MISSING_EVIDENCE_VERSION = 1;
export const MISSING_BLOCK_CODES = new Set([
  "MISSING_SNAPSHOT_INCOMPLETE", "MISSING_RUN_TRUNCATED", "MISSING_PROPERTY_NOT_FOUND",
  "MISSING_IDENTITY_AMBIGUOUS", "MISSING_OWNER_CHANGED", "MISSING_SOURCE_CHANGED",
  "MISSING_NOT_ENROLLED", "MISSING_BASELINE_INVALID", "MISSING_MANUAL_OVERRIDE",
  "MISSING_RECONCILIATION_PENDING", "MISSING_RECONCILIATION_UNCHECKED", "MISSING_ALREADY_HIDDEN",
  "MISSING_PREVIOUSLY_HIDDEN", "MISSING_REVISION_INVALID", "MISSING_RUN_CHANGED", "MISSING_RUN_EXPIRED"
]);
const id = value => String(value || "").toLowerCase();
const validId = value => /^[a-fA-F0-9]{24}$/.test(id(value));
const validHash = value => /^[a-f0-9]{64}$/.test(value || "");

export function missingContentFingerprint(property) {
  // Preserve fingerprints of legacy runs whose documents predate optional location fields.
  const content = CONTENT_FIELDS.filter(field => !["ubicacionPublica", "precisionUbicacion", "periodicidadPrecio"].includes(field) || property[field] !== undefined)
    .map(field => [field, property[field] === undefined ? ["absent"] : ["value", property[field]]]);
  return crypto.createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

export function prepareMissingEligibility(snapshot, matches, externalId, context = {}) {
  const blocked = code => ({ hideMissingEligible: false, hideMissingBlockCode: code });
  if (!snapshot.snapshotComplete) return blocked("MISSING_SNAPSHOT_INCOMPLETE");
  if (!matches.length) return blocked("MISSING_PROPERTY_NOT_FOUND");
  if (matches.length !== 1 || !externalId || matches[0].externalId !== externalId) return blocked("MISSING_IDENTITY_AMBIGUOUS");
  const p = matches[0];
  if (!validId(context.usuarioId) || id(p.usuarioId) !== id(context.usuarioId)) return blocked("MISSING_OWNER_CHANGED");
  if (!validId(context.importSourceId) || id(p.importSourceId) !== id(context.importSourceId) || p.source !== "crm") return blocked("MISSING_SOURCE_CHANGED");
  if (!validId(p._id)) return blocked("MISSING_IDENTITY_AMBIGUOUS");
  if (p.visiblePublicamente === false) return blocked("MISSING_ALREADY_HIDDEN");
  if (p.removedFromFeedAt || p.hiddenByMissingRunId) return blocked("MISSING_PREVIOUSLY_HIDDEN");
  if (p.visiblePublicamente !== true) return blocked("MISSING_IDENTITY_AMBIGUOUS");
  if (p.syncEnabled !== true) return blocked("MISSING_NOT_ENROLLED");
  if (hasOverrides(p)) return blocked("MISSING_MANUAL_OVERRIDE");
  if (!baselineValid(p)) return blocked("MISSING_BASELINE_INVALID");
  if (!Number.isSafeInteger(p.contentRevision ?? 0) || (p.contentRevision ?? 0) < 0) return blocked("MISSING_REVISION_INVALID");
  if (!Array.isArray(context.reconciliations)) return blocked("MISSING_RECONCILIATION_UNCHECKED");
  if (context.reconciliations.some(r => id(r.propiedadId) === id(p._id) ||
    (id(r.usuarioId) === id(p.usuarioId) && id(r.importSourceId) === id(p.importSourceId) && r.externalId === externalId)))
    return blocked("MISSING_RECONCILIATION_PENDING");
  return { hideMissingEligible: true, hideMissingBlockCode: null, missingEvidence: {
    version: MISSING_EVIDENCE_VERSION, usuarioId: p.usuarioId, importSourceId: p.importSourceId,
    expectedContentRevision: p.contentRevision ?? 0, expectedVisiblePublicamente: true,
    expectedBaselineFingerprint: p.syncApplyFingerprint, baselineVersion: p.syncApplyFingerprintVersion,
    expectedContentFingerprint: missingContentFingerprint(p), enrolled: true, reconciliationChecked: true
  } };
}

export function safeMissingEligibility(entry, run, now, expectedVersions) {
  const blocked = code => ({ hideMissingEligible: false, hideMissingBlockCode: code });
  if (!(new Date(run.expiresAt).getTime() > new Date(now).getTime())) return blocked("MISSING_RUN_EXPIRED");
  if (run.snapshotComplete !== true) return blocked("MISSING_SNAPSHOT_INCOMPLETE");
  if (run.planTruncated === true || run.totalResults > 100 || run.plan?.length > 100) return blocked("MISSING_RUN_TRUNCATED");
  if (run.status !== "simulated" || run.errorCode || run.blocked === true || run.missingHide || run.reappearedRestore ||
    (run.newImport?.status && run.newImport.status !== "idle") ||
    !validHash(run.snapshotDigest) || !validHash(run.sourceIdentityHash) ||
    Object.entries(expectedVersions).some(([k,v]) => run[k] !== v)) return blocked("MISSING_RUN_CHANGED");
  if (entry.hideMissingEligible !== true) return blocked(MISSING_BLOCK_CODES.has(entry.hideMissingBlockCode)
    ? entry.hideMissingBlockCode : "MISSING_RUN_CHANGED");
  const e = entry.missingEvidence;
  if (!e || entry.linked !== true || entry.safeReasonCode !== "MISSING_REQUIRES_REVIEW" ||
    e.reconciliationChecked !== true || e.version !== MISSING_EVIDENCE_VERSION || !validId(entry.propiedadId) ||
    !validId(e.usuarioId) || !validId(e.importSourceId) || id(e.usuarioId) !== id(run.usuarioId) ||
    id(e.importSourceId) !== id(run.importSourceId) || e.enrolled !== true || e.expectedVisiblePublicamente !== true ||
    !Number.isSafeInteger(e.expectedContentRevision) || e.expectedContentRevision < 0 ||
    e.baselineVersion !== SYNC_APPLY_FIELDS_VERSION || !validHash(e.expectedBaselineFingerprint) || !validHash(e.expectedContentFingerprint))
    return blocked("MISSING_RUN_CHANGED");
  return { hideMissingEligible: true, hideMissingBlockCode: null };
}
