import mongoose from "mongoose";
import { NEW_IMPORT_STATUSES, NEW_IMPORT_RESULT_STATUSES, NEW_IMPORT_FAILURE_CODES } from "../utils/import/newImportState.js";
import { MISSING_BLOCK_CODES } from "../utils/import/missingEligibility.js";
import { MISSING_HIDE_STATUSES, MISSING_HIDE_CODES } from "../utils/import/missingHideState.js";

const newResultSchema = new mongoose.Schema({
  externalId: { type: String, required: true, maxlength: 200 },
  status: { type: String, enum: NEW_IMPORT_RESULT_STATUSES, required: true },
  propertyId: mongoose.Schema.Types.ObjectId,
  reason: { type: String, enum: ["ALREADY_EXISTS", "INVALID_DATA", "CREATION_FAILED", "RECONCILIATION_REQUIRED", "NOT_STARTED"] },
  attemptedImages: Number, importedImages: Number, skippedImages: Number, imageWarnings: Number
}, { _id: false, strict: "throw" });
const newImportSchema = new mongoose.Schema({
  status: { type: String, enum: NEW_IMPORT_STATUSES, required: true },
  selectedExternalIds: { type: [String], required: true,
    validate: value => value.length >= 1 && value.length <= 10 && new Set(value).size === value.length },
  startedAt: Date, completedAt: Date,
  results: { type: [newResultSchema], default: [], validate: value => value.length <= 10 },
  counts: { imported: Number, alreadyExists: Number, skipped: Number, attemptedImages: Number, importedImages: Number, skippedImages: Number },
  failureCode: { type: String, enum: [...NEW_IMPORT_FAILURE_CODES] }
}, { _id: false, strict: "throw" });

const schema = new mongoose.Schema({
  missingHide: { type: new mongoose.Schema({
    status: { type: String, enum: MISSING_HIDE_STATUSES, required: true },
    operationId: { type: String, required: true },
    selectedExternalIds: { type: [String], required: true,
      validate: value => value.length >= 1 && value.length <= 10 && new Set(value).size === value.length },
    results: { type: [new mongoose.Schema({ externalId: String,
      status: { type: String, enum: ["hidden", "already_hidden", "skipped", "failed"] },
      code: { type: String, enum: [...MISSING_HIDE_CODES] }
    }, { _id: false, strict: "throw" })], default: [], validate: value => value.length <= 10 },
    countHidden: Number, countAlreadyHidden: Number, startedAt: Date, completedAt: Date,
    errorCode: { type: String, enum: [...MISSING_HIDE_CODES] }
  }, { _id: false, strict: "throw" }), default: undefined },
  usuarioId: { type: mongoose.Schema.Types.ObjectId, ref: "Usuario", required: true },
  importSourceId: { type: mongoose.Schema.Types.ObjectId, ref: "ImportSource", required: true },
  status: { type: String, enum: ["running", "completed", "incomplete", "simulated", "applying", "applied", "blocked", "failed", "aborted"], required: true },
  mode: { type: String, enum: ["simulation"], default: "simulation" },
  startedAt: { type: Date, required: true },
  finishedAt: Date,
  durationMs: Number,
  snapshotComplete: { type: Boolean, default: false },
  snapshotCount: { type: Number, default: 0 },
  unchangedCount: { type: Number, default: 0 },
  updateCount: { type: Number, default: 0 },
  newCount: { type: Number, default: 0 },
  missingCount: { type: Number, default: 0 },
  conflictCount: { type: Number, default: 0 },
  errorCount: { type: Number, default: 0 },
  warnings: { type: [String], default: [] },
  errorCode: String,
  expiresAt: Date,
  snapshotDigest: String,
  snapshotVersion: Number,
  normalizationVersion: Number,
  applyFieldsVersion: Number,
  sourceIdentityHash: String,
  totalResults: Number,
  planTruncated: Boolean,
  selectedExternalIds: { type: [String], default: undefined, validate: value => !value || value.length <= 10 },
  appliedCount: Number,
  blockedCount: Number,
  appliedAt: Date,
  resultCodes: { type: [String], default: undefined, enum: ["UPDATE_APPLIED"] },
  newImport: { type: newImportSchema, default: undefined },
  plan: {
    type: [new mongoose.Schema({
      propiedadId: mongoose.Schema.Types.ObjectId,
      externalId: String,
      type: { type: String, enum: ["UNCHANGED", "UPDATE", "NEW", "MISSING", "CONFLICT", "INVALID"] },
      expectedContentRevision: Number,
      expectedBaselineFingerprint: String,
      proposedBaselineFingerprint: String,
      changedFields: [String],
      blocked: Boolean,
      safeReasonCode: String,
      enrollmentEligible: Boolean,
      importNewEligible: Boolean,
      importNewBlockCode: { type: String, enum: ["SYNC_NEW_INVALID_DATA", null] },
      linked: Boolean,
      hideMissingEligible: Boolean,
      hideMissingBlockCode: { type: String, enum: [...MISSING_BLOCK_CODES, null] },
      missingEvidence: { type: new mongoose.Schema({
        version: Number, usuarioId: mongoose.Schema.Types.ObjectId, importSourceId: mongoose.Schema.Types.ObjectId,
        expectedContentRevision: Number, expectedVisiblePublicamente: Boolean, enrolled: Boolean, reconciliationChecked: Boolean,
        expectedBaselineFingerprint: String, baselineVersion: Number, expectedContentFingerprint: String
      }, { _id: false, strict: "throw" }), default: undefined }
    }, { _id: false, strict: "throw" })],
    default: undefined,
    select: false,
    validate: value => !value || value.length <= 100
  }
}, { timestamps: true });

schema.index({ usuarioId: 1, importSourceId: 1, startedAt: -1 });
export default mongoose.model("ImportSyncRun", schema);
