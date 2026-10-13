import crypto from "node:crypto";
import { safeNewImportSummary } from "./newImportState.js";
import { compareSyncSnapshot } from "./syncDiff.js";
import { prepareMissingEligibility, safeMissingEligibility } from "./missingEligibility.js";
import { safeMissingHideSummary } from "./missingHideState.js";
import { prepareReappearedEligibility, safeReappearedEligibility, REAPPEARED_BLOCK_CODES } from "./reappearedEligibility.js";
import { syncFingerprint, SYNC_FIELDS } from "./syncSnapshot.js";
import { SYNC_APPLY_V1_FIELDS, SYNC_APPLY_FIELDS_VERSION, SYNC_NORMALIZATION_VERSION, SYNC_SNAPSHOT_VERSION,
  baselineValid, managedFingerprint, managedChangedFields, proposedManagedContent,
  suppliedNonPhotoDifferences, enrollmentCompatible, hasOverrides, validManagedData } from "./syncBaseline.js";

export const MAX_RUN_DETAILS = 100;
export const RUN_LIFETIME_MS = 20 * 60 * 1000;
const counters = { UNCHANGED: "unchangedCount", UPDATE: "updateCount", NEW: "newCount", MISSING: "missingCount", REAPPEARED: "reappearedCount", CONFLICT: "conflictCount", INVALID: "errorCount" };
const detailFields = new Set(SYNC_FIELDS.filter(field => !["externalId", "imagenes", "crmWithdrawal"].includes(field)));
const warningCodes = new Set(["EMPTY_OR_UNRECOGNIZED_FEED", "SNAPSHOT_LIMIT_EXCEEDED", "SNAPSHOT_INVALID_RECORDS",
  "MISSING_DISABLED_INCOMPLETE_SNAPSHOT", "SNAPSHOT_STRUCTURE_LIMIT", "SNAPSHOT_AMBIGUOUS_STRUCTURE",
  "SNAPSHOT_UNRECOGNIZED_STRUCTURE", "SNAPSHOT_PAGINATION_UNSUPPORTED", "SNAPSHOT_ADVERTISED_TOTAL_MISMATCH", "SYNC_EXISTING_LIMIT_EXCEEDED"]);
const safeExternalId = value => typeof value === "string" && value.length <= 200 &&
  !/https?:\/\/|[<>&?=\u0000-\u001f]/i.test(value) ? value : "[referencia invalida]";
export const RUN_REASON_CODES = new Set([
  "PROPERTY_SYNC_DISABLED", "SYNC_BASELINE_INVALID", "MANUAL_OVERRIDE", "UNSUPPORTED_FIELD_CHANGE",
  "CRM_WITHDRAWAL", "AMBIGUOUS_IDENTITY", "SUSPICIOUS_REFERENCE_CHANGE", "INVALID_RECORD",
  "NEW_REQUIRES_MANUAL_IMPORT", "MISSING_REQUIRES_REVIEW", "SYNC_SNAPSHOT_INCOMPLETE", "SIMULATION_IN_PROGRESS",
  "REAPPEARED_REQUIRES_REVIEW", ...REAPPEARED_BLOCK_CODES
]);

export function snapshotDigest(snapshot) {
  const records = snapshot.properties.map(item => [item.data.externalId, syncFingerprint(item.data), [...item.errors].sort()])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])) || a[1].localeCompare(b[1]));
  return crypto.createHash("sha256").update(JSON.stringify({ version: SYNC_SNAPSHOT_VERSION,
    complete: snapshot.snapshotComplete, records, warnings: [...snapshot.warnings].sort() })).digest("hex");
}

export function prepareSyncPlan(snapshot, existing, context = {}) {
  const legacy = compareSyncSnapshot(snapshot, existing, context);
  const incoming = new Map(snapshot.properties.map(item => [item.data.externalId, item]));
  const results = legacy.results.map(item => {
    const matches = existing.filter(p => p.externalId === item.externalId);
    const property = matches.length === 1 ? matches[0] : null;
    const data = incoming.get(item.externalId)?.data;
    const base = { externalId: safeExternalId(item.externalId), type: item.type, changedFields: [], blocked: true,
      enrollmentEligible: false, linked: Boolean(property?.syncEnabled),
      ...(property ? { propiedadId: property._id } : {}) };
    if (item.type === "INVALID") return { ...base, safeReasonCode: "INVALID_RECORD" };
    if (item.type === "NEW") return { ...base, safeReasonCode: "NEW_REQUIRES_MANUAL_IMPORT",
      importNewEligible: item.publishableByData === true,
      importNewBlockCode: item.publishableByData === true ? null : "SYNC_NEW_INVALID_DATA" };
    if (item.type === "MISSING") return { ...base, safeReasonCode: "MISSING_REQUIRES_REVIEW",
      ...prepareMissingEligibility(snapshot, matches, item.externalId, context) };
    if (item.type === "REAPPEARED") return { ...base, safeReasonCode: "REAPPEARED_REQUIRES_REVIEW",
      changedFields: managedChangedFields(property, data),
      ...prepareReappearedEligibility(snapshot, matches, item.externalId, context) };
    if (REAPPEARED_BLOCK_CODES.has(item.reason)) return { ...base, type: "CONFLICT",
      safeReasonCode: item.reason, restoreEligible: false, restoreBlockCode: item.reason };
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
  if (results.length > MAX_RUN_DETAILS) for (const item of results) {
    if (item.type === "MISSING") {
      item.hideMissingEligible = false; item.hideMissingBlockCode = "MISSING_RUN_TRUNCATED";
      delete item.missingEvidence;
    } else if (item.type === "REAPPEARED") {
      item.restoreEligible = false; item.restoreBlockCode = "REAPPEARED_RUN_TRUNCATED";
      delete item.restoreEvidence;
    }
  }
  return { ...summary, totalResults: results.length, resultsTruncated: results.length > MAX_RUN_DETAILS,
    plan: results.slice(0, MAX_RUN_DETAILS) };
}

function isRunPlanTruncated(run) {
  return run.planTruncated === true || (Number.isSafeInteger(run.totalResults) && run.totalResults > MAX_RUN_DETAILS) ||
    (Array.isArray(run.plan) && run.plan.length > MAX_RUN_DETAILS);
}

// Global eligibility does not override entry-level conflicts or authorize any writes.
export function evaluateRunApplyEligibility(run, now = new Date()) {
  const expiresAt = run.expiresAt == null ? NaN : new Date(run.expiresAt).getTime();
  const currentTime = new Date(now).getTime();
  const expired = !Number.isFinite(expiresAt) || !Number.isFinite(currentTime) || expiresAt <= currentTime;
  const applyBlockedReason = expired ? "RUN_EXPIRED"
    : isRunPlanTruncated(run) ? "RUN_PLAN_TRUNCATED"
    : run.snapshotComplete !== true ? "RUN_SNAPSHOT_INCOMPLETE"
    : run.status !== "simulated" ? "RUN_STATUS_NOT_APPLICABLE"
    : run.blocked === true || Boolean(run.errorCode) || Boolean(run.missingHide) || !Array.isArray(run.plan) ||
      (run.newImport?.status && run.newImport.status !== "idle") ? "RUN_BLOCKED" : null;
  return { expired, applyEligible: applyBlockedReason === null, applyBlockedReason };
}

export function evaluateRunNewImportEligibility(run, now = new Date(), usuarioId) {
  const expires = new Date(run.expiresAt || "invalid").getTime();
  const newImportBlockedReason = usuarioId && String(run.usuarioId) !== String(usuarioId) ? "SYNC_RUN_NOT_FOUND"
    : !Number.isFinite(expires) || !Number.isFinite(new Date(now).getTime()) || expires <= new Date(now).getTime() ? "RUN_EXPIRED"
    : isRunPlanTruncated(run) ? "RUN_PLAN_TRUNCATED"
    : run.snapshotComplete !== true ? "RUN_SNAPSHOT_INCOMPLETE"
    : run.status !== "simulated" ? "RUN_STATUS_NOT_APPLICABLE"
    : run.blocked === true || run.errorCode || run.missingHide || !Array.isArray(run.plan) ? "RUN_BLOCKED"
    : !/^[a-f0-9]{64}$/.test(run.sourceIdentityHash || "") ||
      !/^[a-f0-9]{64}$/.test(run.snapshotDigest || "") || !/^[a-fA-F0-9]{24}$/.test(String(run.importSourceId || "")) ||
      Object.entries(runVersions).some(([key, version]) => run[key] !== version) ? "SYNC_NEW_RUN_CHANGED"
    : run.newImport?.status && run.newImport.status !== "idle" ? "SYNC_NEW_ALREADY_ATTEMPTED" : null;
  return { newImportEligible: newImportBlockedReason === null, newImportBlockedReason };
}

// Read responses are deliberately independent of arbitrary/legacy document fields.
export function safeRunSummary(run, now = new Date()) {
  const statuses = new Set(["running", "completed", "incomplete", "simulated", "applying", "applied", "blocked", "failed", "aborted"]);
  const summary = { runId: String(run._id), mode: "simulation", status: statuses.has(run.status) ? run.status : "blocked",
    createdAt: run.createdAt || run.startedAt, expiresAt: run.expiresAt || null,
    ...evaluateRunApplyEligibility(run, now), snapshotComplete: run.snapshotComplete === true,
    ...evaluateRunNewImportEligibility(run, now),
    ...(run.newImport ? { newImport: safeNewImportSummary(run.newImport) } : {}),
    ...(run.missingHide ? { missingHide: safeMissingHideSummary(run.missingHide) } : {}),
    snapshotCount: Number.isSafeInteger(run.snapshotCount) ? run.snapshotCount : 0,
    totalResults: Number.isSafeInteger(run.totalResults) ? run.totalResults : 0,
    planTruncated: isRunPlanTruncated(run), resultsTruncated: isRunPlanTruncated(run),
    warnings: (run.warnings || []).filter(code => warningCodes.has(code)),
    appliedCount: Number.isSafeInteger(run.appliedCount) ? run.appliedCount : 0,
    appliedAt: run.appliedAt || null,
    results: [] };
  for (const key of Object.values(counters)) summary[key] = Number.isSafeInteger(run[key]) ? run[key] : 0;
  for (const entry of (run.plan || []).slice(0, MAX_RUN_DETAILS)) {
    if (!Object.hasOwn(counters, entry.type) || typeof entry.externalId !== "string" ||
      /https?:\/\/|[<>&?=\u0000-\u001f]/i.test(entry.externalId)) continue;
    summary.results.push({ externalId: entry.externalId.slice(0, 200), type: entry.type,
      changedFields: (entry.changedFields || []).filter(field => detailFields.has(field)),
      blocked: entry.blocked !== false, linked: entry.linked === true,
      enrollmentEligible: entry.enrollmentEligible === true && entry.safeReasonCode === "PROPERTY_SYNC_DISABLED",
      ...(entry.type === "MISSING" ? safeMissingEligibility(entry, run, now, runVersions) : {}),
      ...(entry.type === "REAPPEARED" ? safeReappearedEligibility(entry, run, now, runVersions) : {}),
      ...(entry.type === "NEW" ? { importNewEligible: entry.importNewEligible === true,
        importNewBlockCode: entry.importNewEligible === true ? null
          : entry.importNewBlockCode === "SYNC_NEW_INVALID_DATA" ? "SYNC_NEW_INVALID_DATA" : "SYNC_NEW_RUN_CHANGED" } : {}),
      ...(RUN_REASON_CODES.has(entry.safeReasonCode) ? { reason: entry.safeReasonCode } : {}) });
  }
  return summary;
}

export const runVersions = Object.freeze({ snapshotVersion: SYNC_SNAPSHOT_VERSION,
  normalizationVersion: SYNC_NORMALIZATION_VERSION, applyFieldsVersion: SYNC_APPLY_FIELDS_VERSION });
