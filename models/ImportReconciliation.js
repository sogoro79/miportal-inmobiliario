import mongoose from "mongoose";

const schema = new mongoose.Schema({
  propiedadId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
  usuarioId: { type: mongoose.Schema.Types.ObjectId, required: true },
  source: { type: String, enum: ["crm", "manual"], default: "crm" },
  importSourceId: { type: mongoose.Schema.Types.ObjectId, required() { return this.source !== "manual"; } },
  // Manual publications use their preassigned property ID as the internal externalId key.
  externalId: { type: String, required: true },
  publicIds: [{ type: String }],
  reasonCode: { type: String, enum: ["PERSISTENCE_UNCONFIRMED", "UNKNOWN_TRANSACTION_COMMIT_RESULT"] },
  state: { type: String, enum: ["prepared", "unknown", "cleanup_required"], default: "prepared" }
}, { timestamps: true });
schema.index({ usuarioId: 1, importSourceId: 1, externalId: 1 }, { unique: true });

export default mongoose.model("ImportReconciliation", schema);
