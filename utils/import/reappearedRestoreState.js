import crypto from "node:crypto";
import { REAPPEARED_BLOCK_CODES } from "./reappearedEligibility.js";

export const REAPPEARED_RESTORE_STATUSES = ["preparing", "applying", "completed", "failed", "indeterminate"];
export const REAPPEARED_RESTORE_CODES = new Set([...REAPPEARED_BLOCK_CODES,
  "REAPPEARED_RUN_NOT_FOUND", "REAPPEARED_SELECTION_INVALID", "REAPPEARED_SELECTION_MISMATCH",
  "REAPPEARED_NOT_ELIGIBLE", "REAPPEARED_FEED_CHANGED", "REAPPEARED_NO_LONGER_PRESENT",
  "REAPPEARED_REVISION_CHANGED", "REAPPEARED_MARKER_CHANGED", "REAPPEARED_OPERATION_CONFLICT",
  "REAPPEARED_IN_PROGRESS", "REAPPEARED_INDETERMINATE", "REAPPEARED_FAILED",
  "SYNC_SOURCE_NOT_FOUND", "SYNC_SOURCE_BUSY", "SYNC_SOURCE_NOT_CONFIGURED", "IMPORT_TIMEOUT", "FEED_TIMEOUT"
]);
export const validRestoreExternalId = value => typeof value === "string" && value.length > 0 &&
  value.length <= 200 && value === value.trim() && !/https?:\/\/|[<>&?=\u0000-\u001f]/i.test(value);
export function restoreSelectionHash(ids) {
  return crypto.createHash("sha256").update(JSON.stringify([...ids].sort())).digest("hex");
}
export function safeRestoreCode(error) {
  return REAPPEARED_RESTORE_CODES.has(error?.code) ? error.code : "REAPPEARED_FAILED";
}
export function safeRestoreSummary(receipt) {
  const results = (Array.isArray(receipt.results) ? receipt.results : []).slice(0, 10)
    .filter(r => r && validRestoreExternalId(r.externalId)).map(r => ({
      externalId: r.externalId,
      status: ["restored", "already_restored", "failed"].includes(r.status) ? r.status : "failed",
      ...(REAPPEARED_RESTORE_CODES.has(r.code) ? { code: r.code } : {})
    }));
  return {
    status: REAPPEARED_RESTORE_STATUSES.includes(receipt.status) ? receipt.status : "indeterminate",
    selectedExternalIds: (Array.isArray(receipt.selectedExternalIds) ? receipt.selectedExternalIds : [])
      .filter(validRestoreExternalId).slice(0, 10),
    results, countRestored: results.filter(r => r.status === "restored").length,
    countAlreadyRestored: results.filter(r => r.status === "already_restored").length,
    startedAt: receipt.startedAt || null, completedAt: receipt.completedAt || null,
    ...(REAPPEARED_RESTORE_CODES.has(receipt.errorCode) ? { errorCode: receipt.errorCode } : {})
  };
}
