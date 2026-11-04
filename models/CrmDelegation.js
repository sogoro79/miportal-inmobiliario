import mongoose from "mongoose";

const id = mongoose.Schema.Types.ObjectId;
// A new grant gets a new id. Revocation never reactivates old delegated runs.
const schema = new mongoose.Schema({
  usuarioId: { type: id, ref: "Usuario", required: true },
  importSourceId: { type: id, ref: "ImportSource", required: true },
  sourceIdentityHash: { type: String, required: true, select: false },
  provider: { type: String, enum: ["inmoweb"], required: true },
  enabled: { type: Boolean, required: true },
  sourceConfiguredBy: { type: id, ref: "Usuario" },
  grantedAt: { type: Date, required: true },
  grantedBy: { type: id, ref: "Usuario", required: true },
  revokedAt: Date,
  revokedBy: { type: id, ref: "Usuario" },
  fence: { type: Number, default: 0, select: false }
}, { strict: "throw" });
schema.index({ usuarioId: 1 }, { unique: true, partialFilterExpression: { enabled: true } });
export default mongoose.model("CrmDelegation", schema);
