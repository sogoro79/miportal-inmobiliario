export const MISSING_HIDE_STATUSES = ["preparing", "applying", "completed", "indeterminate", "failed"];
export const MISSING_HIDE_CODES = new Set([
  "MISSING_SELECTION_INVALID", "MISSING_SELECTION_MISMATCH", "MISSING_IN_PROGRESS", "MISSING_UNCONFIRMED",
  "MISSING_FAILED", "MISSING_USER_INACTIVE", "MISSING_PROPERTY_CHANGED", "MISSING_FEED_CHANGED",
  "MISSING_REAPPEARED", "MISSING_OPERATION_BLOCKED", "MISSING_RECONCILIATION_PENDING",
  "MISSING_RUN_CHANGED", "MISSING_RUN_EXPIRED", "MISSING_SNAPSHOT_INCOMPLETE", "MISSING_RUN_TRUNCATED",
  "SYNC_RUN_NOT_FOUND", "SYNC_SOURCE_NOT_FOUND", "SYNC_SOURCE_BUSY", "SYNC_SOURCE_NOT_CONFIGURED",
  "IMPORT_TIMEOUT", "FEED_TIMEOUT"
]);
export function safeMissingHideCode(error) { return MISSING_HIDE_CODES.has(error?.code) ? error.code : "MISSING_FAILED"; }
const safeId = value => typeof value === "string" && value.length > 0 && value.length <= 200 &&
  !/https?:\/\/|[<>&?=\u0000-\u001f]/i.test(value);
export function safeMissingHideSummary(operation) {
  const statuses = new Set(["hidden", "already_hidden", "skipped", "failed"]);
  const results = (operation.results || []).slice(0, 10).filter(r => safeId(r.externalId)).map(r => ({
    externalId: r.externalId, status: statuses.has(r.status) ? r.status : "failed",
    ...(MISSING_HIDE_CODES.has(r.code) ? { code: r.code } : {})
  }));
  return { status: MISSING_HIDE_STATUSES.includes(operation.status) ? operation.status : "indeterminate",
    selectedExternalIds: (operation.selectedExternalIds || []).filter(safeId).slice(0, 10), results,
    countHidden: results.filter(r => r.status === "hidden").length,
    countAlreadyHidden: results.filter(r => r.status === "already_hidden").length,
    startedAt: operation.startedAt || null, completedAt: operation.completedAt || null,
    ...(MISSING_HIDE_CODES.has(operation.errorCode) ? { errorCode: operation.errorCode } : {}) };
}
