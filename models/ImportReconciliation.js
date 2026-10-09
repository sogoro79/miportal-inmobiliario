import mongoose from "mongoose";

const schema = new mongoose.Schema({
  propiedadId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
  usuarioId: { type: mongoose.Schema.Types.ObjectId, required: true },
  importSourceId: { type: mongoose.Schema.Types.ObjectId, required: true },
  externalId: { type: String, required: true },
  publicIds: [{ type: String }],
  state: { type: String, enum: ["prepared", "unknown", "cleanup_required"], default: "prepared" }
}, { timestamps: true });
schema.index({ usuarioId: 1, importSourceId: 1, externalId: 1 }, { unique: true });

export default mongoose.model("ImportReconciliation", schema);
