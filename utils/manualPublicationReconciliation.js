import ImportReconciliation from "../models/ImportReconciliation.js";
import { normalizeUploadedFiles } from "./cloudinaryService.js";

export async function recordManualPublicationUncertainty({ usuarioId, propertyId, files = [], error }, {
  ReconciliationModel = ImportReconciliation,
  logger = console
} = {}) {
  const context = { userId: String(usuarioId), propertyId: String(propertyId), resourceCount: files.length };
  try {
    const publicIds = [...new Set(normalizeUploadedFiles(files).map(image => image.publicId))];
    const reasonCode = error?.cause?.hasErrorLabel?.("UnknownTransactionCommitResult")
      ? "UNKNOWN_TRANSACTION_COMMIT_RESULT" : "PERSISTENCE_UNCONFIRMED";
    await ReconciliationModel.init();
    await ReconciliationModel.updateOne({ propiedadId: propertyId }, { $setOnInsert: {
      usuarioId, propiedadId: propertyId, source: "manual", externalId: String(propertyId),
      publicIds, state: "unknown", reasonCode, createdAt: new Date()
    } }, { upsert: true });
    logger.warn("[Publication Reconciliation]", { code: "MANUAL_PUBLICATION_UNCONFIRMED", ...context });
    return true;
  } catch {
    logger.error("[Publication Reconciliation]", { code: "RECONCILIATION_RECORD_FAILED", ...context });
    return false;
  }
}
