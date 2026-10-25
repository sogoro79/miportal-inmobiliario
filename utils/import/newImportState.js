export const NEW_IMPORT_STATUSES = ["idle", "importing", "completed", "failed", "indeterminate"];
export const NEW_IMPORT_RESULT_STATUSES = ["imported", "already_exists", "skipped", "indeterminate"];
export const NEW_IMPORT_FAILURE_CODES = new Set([
  "CRM_PROVIDER_TEMPORARILY_BLOCKED",
  "INMOWEB_NEW_DISABLED", "INMOWEB_NEW_REQUIRES_SYNC", "INMOWEB_NEW_EXTERNAL_ID_NOT_ALLOWED",
  "SYNC_NEW_PLAN_LIMIT", "SYNC_NEW_PLAN_REQUIRED",
  "SYNC_NEW_SELECTION_INVALID", "SYNC_NEW_SELECTION_MISMATCH", "SYNC_NEW_SOURCE_CHANGED", "SYNC_NEW_RUN_CHANGED",
  "SYNC_NEW_FEED_CHANGED", "SYNC_NEW_NOT_NEW", "SYNC_NEW_INVALID_DATA", "SYNC_NEW_RECONCILIATION_PENDING",
  "SYNC_NEW_IN_PROGRESS", "SYNC_NEW_UNCONFIRMED", "SYNC_NEW_ALREADY_ATTEMPTED", "SYNC_NEW_FAILED",
  "SYNC_RUN_NOT_FOUND", "SYNC_SOURCE_NOT_FOUND", "SYNC_SOURCE_BUSY", "SYNC_SOURCE_NOT_CONFIGURED",
  "RUN_EXPIRED", "RUN_PLAN_TRUNCATED", "RUN_SNAPSHOT_INCOMPLETE", "RUN_STATUS_NOT_APPLICABLE", "RUN_BLOCKED",
  "IMPORT_TIMEOUT", "FEED_TIMEOUT", "NEW_IMPORT_STARTED", "NEW_IMPORT_CONSUMED", "NEW_IMPORT_FAILED"
]);
const reasons = new Set(["ALREADY_EXISTS", "INVALID_DATA", "CREATION_FAILED", "RECONCILIATION_REQUIRED", "NOT_STARTED"]);
const safeId = value => typeof value === "string" && value.length > 0 && value.length <= 200 &&
  !/https?:\/\/|[<>&?=\u0000-\u001f]/i.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
export function safeNewResult(item) {
  return { externalId: safeId(item.externalId) ? item.externalId : "[referencia invalida]",
    status: NEW_IMPORT_RESULT_STATUSES.includes(item.status) ? item.status : "indeterminate",
    ...(/^[a-fA-F0-9]{24}$/.test(String(item.propertyId || "")) ? { propertyId: String(item.propertyId) } : {}),
    ...(reasons.has(item.reason) ? { reason: item.reason } : {}),
    attemptedImages: count(item.attemptedImages), importedImages: count(item.importedImages), skippedImages: count(item.skippedImages),
    imageWarnings: count(item.imageWarnings) };
}
export function newImportCounts(results) {
  return results.reduce((counts, item) => {
    if (item.status === "imported") counts.imported++;
    else if (item.status === "already_exists") counts.alreadyExists++;
    else counts.skipped++;
    for (const key of ["attemptedImages", "importedImages", "skippedImages"]) counts[key] += count(item[key]);
    return counts;
  }, { imported: 0, alreadyExists: 0, skipped: 0, attemptedImages: 0, importedImages: 0, skippedImages: 0 });
}
export function safeNewImportSummary(operation) {
  if (!operation) return undefined;
  const results = (operation.results || []).slice(0, 10).map(safeNewResult);
  return { status: NEW_IMPORT_STATUSES.includes(operation.status) ? operation.status : "indeterminate",
    selectedExternalIds: (operation.selectedExternalIds || []).filter(safeId).slice(0, 10),
    startedAt: operation.startedAt || null, completedAt: operation.completedAt || null,
    counts: newImportCounts(results), results,
    ...(NEW_IMPORT_FAILURE_CODES.has(operation.failureCode) ? { failureCode: operation.failureCode } : {}) };
}
