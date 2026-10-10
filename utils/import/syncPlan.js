import crypto from "node:crypto";
import { compareSyncSnapshot } from "./syncDiff.js";
import { syncFingerprint, SYNC_FIELDS } from "./syncSnapshot.js";
import { SYNC_APPLY_V1_FIELDS, SYNC_APPLY_FIELDS_VERSION, SYNC_NORMALIZATION_VERSION, SYNC_SNAPSHOT_VERSION,
  baselineValid, managedFingerprint, managedChangedFields, proposedManagedContent,
  suppliedNonPhotoDifferences, enrollmentCompatible, hasOverrides, validManagedData } from "./syncBaseline.js";

export const MAX_RUN_DETAILS = 100;
export const RUN_LIFETIME_MS = 20 * 60 * 1000;
const counters = { UNCHANGED: "unchangedCount", UPDATE: "updateCount", NEW: "newCount", MISSING: "missingCount", CONFLICT: "conflictCount", INVALID: "errorCount" };
const detailFields = new Set(SYNC_FIELDS.filter(field => !["externalId", "imagenes", "crmWithdrawal"].includes(field)));
const warningCodes = new Set(["EMPTY_OR_UNRECOGNIZED_FEED", "SNAPSHOT_LIMIT_EXCEEDED", "SNAPSHOT_INVALID_RECORDS",
  "MISSING_DISABLED_INCOMPLETE_SNAPSHOT", "SNAPSHOT_STRUCTURE_LIMIT", "SNAPSHOT_AMBIGUOUS_STRUCTURE",
  "SNAPSHOT_UNRECOGNIZED_STRUCTURE", "SNAPSHOT_PAGINATION_UNSUPPORTED", "SNAPSHOT_ADVERTISED_TOTAL_MISMATCH", "SYNC_EXISTING_LIMIT_EXCEEDED"]);
const safeExternalId = value => typeof value === "string" && value.length <= 200 &&
  !/https?:\/\/|[<>&?=\u0000-\u001f]/i.test(value) ? value : "[referencia invalida]";
export const RUN_REASON_CODES = new Set([
  "PROPERTY_SYNC_DISABLED", "SYNC_BASELINE_INVALID", "MANUAL_OVERRIDE", "UNSUPPORTED_FIELD_CHANGE",
  "CRM_WITHDRAWAL", "AMBIGUOUS_IDENTITY", "SUSPICIOUS_REFERENCE_CHANGE", "INVALID_RECORD",
  "NEW_REQUIRES_MANUAL_IMPORT", "MISSING_REQUIRES_REVIEW", "SYNC_SNAPSHOT_INCOMPLETE", "SIMULATION_IN_PROGRESS"
]);

export function snapshotDigest(snapshot) {
  const records = snapshot.properties.map(item => [item.data.externalId, syncFingerprint(item.data), [...item.errors].sort()])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])) || a[1].localeCompare(b[1]));
  return crypto.createHash("sha256").update(JSON.stringify({ version: SYNC_SNAPSHOT_VERSION,
    complete: snapshot.snapshotComplete, records, warnings: [...snapshot.warnings].sort() })).digest("hex");
}

export function prepareSyncPlan(snapshot, existing) {
  const legacy = compareSyncSnapshot(snapshot, existing);
  const incoming = new Map(snapshot.properties.map(item => [item.data.externalId, item]));
  const results = legacy.results.map(item => {
    const matches = existing.filter(p => p.externalId === item.externalId);
    const property = matches.length === 1 ? matches[0] : null;
    const data = incoming.get(item.externalId)?.data;
    const base = { externalId: safeExternalId(item.externalId), type: item.type, changedFields: [], blocked: true,
      enrollmentEligible: false, linked: Boolean(property?.syncEnabled),
      ...(property ? { propiedadId: property._id } : {}) };
    if (item.type === "INVALID") return { ...base, safeReasonCode: "INVALID_RECORD" };
    if (item.type === "NEW") return { ...base, safeReasonCode: "NEW_REQUIRES_MANUAL_IMPORT" };
    if (item.type === "MISSING") return { ...base, safeReasonCode: "MISSING_REQUIRES_REVIEW" };
    if (!property || !data) return { ...base, type: "CONFLICT", safeReasonCode: item.reason === "SUSPICIOUS_REFERENCE_CHANGE" ? item.reason : "AMBIGUOUS_IDENTITY" };
    const differences = suppliedNonPhotoDifferences(property, data);
    base.changedFields = differences.filter(field => detailFields.has(field));
    if (property.syncEnabled !== true) return { ...base, type: "CONFLICT", safeReasonCode: "PROPERTY_SYNC_DISABLED",
      enrollmentEligible: snapshot.snapshotComplete && enrollmentCompatible(property, data) };
    if (!baselineValid(property)) return { ...base, type: "CONFLICT", safeReasonCode: "SYNC_BASELINE_INVALID" };
    if (data.crmWithdrawal) return { ...base, type: "CONFLICT", safeReasonCode: "CRM_WITHDRAWAL" };
    if (hasOverrides(property)) return { ...base, type: "CONFLICT", safeReasonCode: "MANUAL_OVERRIDE" };
    if (differences.some(field => !SYNC_APPLY_V1_FIELDS.includes(field))) return { ...base, type: "CONFLICT", safeReasonCode: "UNSUPPORTED_FIELD_CHANGE" };
    if (!validManagedData(data)) return { ...base, type: "INVALID", safeReasonCode: "INVALID_RECORD" };
    const fields = managedChangedFields(property, data);
    if (!fields.length) return { ...base, type: "UNCHANGED", blocked: false };
    if (!snapshot.snapshotComplete) return { ...base, type: "UPDATE", safeReasonCode: "SYNC_SNAPSHOT_INCOMPLETE" };
    return { ...base, type: "UPDATE", changedFields: fields, blocked: false,
      expectedContentRevision: property.contentRevision ?? 0,
      expectedBaselineFingerprint: property.syncApplyFingerprint,
      proposedBaselineFingerprint: managedFingerprint(proposedManagedContent(property, data)) };
  });
  const summary = Object.fromEntries(Object.values(counters).map(key => [key, 0]));
  for (const item of results) summary[counters[item.type]]++;
  return { ...summary, totalResults: results.length, resultsTruncated: results.length > MAX_RUN_DETAILS,
    plan: results.slice(0, MAX_RUN_DETAILS) };
}

// Read responses are deliberately independent of arbitrary/legacy document fields.
export function safeRunSummary(run, now = new Date()) {
  const statuses = new Set(["running", "completed", "incomplete", "simulated", "applying", "applied", "blocked", "failed", "aborted"]);
  const summary = { runId: String(run._id), mode: "simulation", status: statuses.has(run.status) ? run.status : "blocked",
    createdAt: run.createdAt || run.startedAt, expiresAt: run.expiresAt || null,
    expired: !run.expiresAt || new Date(run.expiresAt) <= now, snapshotComplete: run.snapshotComplete === true,
    snapshotCount: Number.isSafeInteger(run.snapshotCount) ? run.snapshotCount : 0,
    totalResults: Number.isSafeInteger(run.totalResults) ? run.totalResults : 0, resultsTruncated: run.planTruncated === true,
    warnings: (run.warnings || []).filter(code => warningCodes.has(code)),
    results: [] };
  for (const key of Object.values(counters)) summary[key] = Number.isSafeInteger(run[key]) ? run[key] : 0;
  for (const entry of (run.plan || []).slice(0, MAX_RUN_DETAILS)) {
    if (!Object.hasOwn(counters, entry.type) || typeof entry.externalId !== "string" ||
      /https?:\/\/|[<>&?=\u0000-\u001f]/i.test(entry.externalId)) continue;
    summary.results.push({ externalId: entry.externalId.slice(0, 200), type: entry.type,
      changedFields: (entry.changedFields || []).filter(field => detailFields.has(field)),
      blocked: entry.blocked !== false, linked: entry.linked === true,
      enrollmentEligible: entry.enrollmentEligible === true && entry.safeReasonCode === "PROPERTY_SYNC_DISABLED",
      ...(RUN_REASON_CODES.has(entry.safeReasonCode) ? { reason: entry.safeReasonCode } : {}) });
  }
  return summary;
}

export const runVersions = Object.freeze({ snapshotVersion: SYNC_SNAPSHOT_VERSION,
  normalizationVersion: SYNC_NORMALIZATION_VERSION, applyFieldsVersion: SYNC_APPLY_FIELDS_VERSION });
