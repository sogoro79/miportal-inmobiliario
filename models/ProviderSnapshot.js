import mongoose from "mongoose";
import { PROVIDER_SNAPSHOT_COLLECTION, PROVIDER_SNAPSHOT_TTL_SECONDS } from "../utils/import/providerSnapshotRetention.js";

const hash = { type: String, required: true, match: /^[a-f0-9]{64}$/ };
const schema = new mongoose.Schema({
  runId: { type: mongoose.Schema.Types.ObjectId, ref: "ImportSyncRun", required: true },
  usuarioId: { type: mongoose.Schema.Types.ObjectId, ref: "Usuario", required: true },
  importSourceId: { type: mongoose.Schema.Types.ObjectId, ref: "ImportSource", required: true },
  provider: { type: String, enum: ["inmoweb"], required: true },
  sourceIdentityHash: hash,
  snapshotDigest: hash,
  fetchedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  snapshotVersion: { type: Number, required: true },
  normalizationVersion: { type: Number, required: true },
  applyFieldsVersion: { type: Number, required: true },
  providerAdapterVersion: { type: Number, required: true },
  encryptedSnapshot: { type: String, required: true, select: false },
  keyVersion: { type: String, required: true, match: /^[1-9]\d{0,2}$/ }
}, { strict: "throw", versionKey: false, collection: PROVIDER_SNAPSHOT_COLLECTION });
schema.index({ runId: 1 }, { unique: true });
// Physical retention only: 5-minute freshness + 30 minutes retention; logical review still ends at 30 minutes.
// Existing deployments must adjust the TTL index explicitly; no automatic migration.
schema.index({ expiresAt: 1 }, { expireAfterSeconds: PROVIDER_SNAPSHOT_TTL_SECONDS });
export default mongoose.model("ProviderSnapshot", schema);
