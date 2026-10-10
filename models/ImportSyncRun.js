import mongoose from "mongoose";

const schema = new mongoose.Schema({
  usuarioId: { type: mongoose.Schema.Types.ObjectId, ref: "Usuario", required: true },
  importSourceId: { type: mongoose.Schema.Types.ObjectId, ref: "ImportSource", required: true },
  status: { type: String, enum: ["running", "completed", "incomplete", "failed"], required: true },
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
  errorCode: String
}, { timestamps: true });

schema.index({ usuarioId: 1, importSourceId: 1, startedAt: -1 });
export default mongoose.model("ImportSyncRun", schema);
