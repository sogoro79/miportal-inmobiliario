const classes = new Set(["CastError", "ValidationError", "StrictModeError", "MongoServerError", "Error"]);
const paths = new Set(["encryptedSnapshot", "snapshotDigest", "sourceIdentityHash", "expiresAt",
  "fetchedAt", "runId", "usuarioId", "importSourceId", "provider", "snapshotVersion",
  "normalizationVersion", "applyFieldsVersion", "providerAdapterVersion", "keyVersion"]);
const kinds = new Set(["String", "Number", "Date", "ObjectId", "ObjectID", "required", "enum", "regexp"]);
const stages = new Set(["encrypt", "model-init", "snapshot-upsert", "snapshot-decode", "snapshot-validity",
  "snapshot-read", "snapshot-missing", "snapshot-expired", "snapshot-identity", "snapshot-digest", "snapshot-version"]);
const phases = new Set(["sync-snapshot-persist", "sync-snapshot-restore", "sync-snapshot-bind"]);

// Neither arbitrary exception properties nor logger failures may escape this boundary.
export function logProviderSnapshotDiagnostic({ provider, phase, stage, error }, log = event =>
  console.warn("[CRM ProviderSnapshot]", event)) {
  try {
    if (provider !== "inmoweb" || !phases.has(phase) || !stages.has(stage)) return;
    const event = { phase, provider, safeCode: "INMOWEB_FRESH_SNAPSHOT_REQUIRED", stage };
    if (error !== undefined) {
      event.originalErrorClass = classes.has(error?.name) ? error.name : "Error";
      const candidates = [error, error?.reason, ...Object.values(error?.errors || {})];
      const detail = candidates.find(item => paths.has(item?.path));
      if (detail) event.validationPath = detail.path;
      if (kinds.has(detail?.kind)) event.mongooseKind = detail.kind;
      if (typeof error?.code === "number" && Number.isFinite(error.code)) event.mongoCode = error.code;
    }
    log(event);
  } catch { /* Diagnostics must never affect snapshot behavior. */ }
}
