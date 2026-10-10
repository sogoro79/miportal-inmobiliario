import mongoose from "mongoose";

const schema = new mongoose.Schema({
  usuarioId: { type: mongoose.Schema.Types.ObjectId, ref: "Usuario", required: true, unique: true },
  feedType: { type: String, enum: ["generic_xml"], required: true },
  feedUrlHash: { type: String, required: true },
  feedUrlMasked: { type: String, required: true },
  encryptedFeedUrl: { type: String, select: false },
  feedUrlKeyVersion: { type: String },
  syncEnabled: { type: Boolean, default: false },
  lastSuccessfulSyncAt: { type: Date },
  lastSyncStatus: { type: String },
  lastSyncErrorCode: { type: String },
  consecutiveFailures: { type: Number, default: 0 },
  nextSyncAt: { type: Date },
  nombre: { type: String, default: "" },
  lastAnalyzedAt: { type: Date },
  lastImportedAt: { type: Date },
  activo: { type: Boolean, default: true },
  importLockToken: { type: String },
  importLockUntil: { type: Date }
}, { timestamps: true });

export default mongoose.model("ImportSource", schema);
