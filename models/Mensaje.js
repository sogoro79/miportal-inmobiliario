import mongoose from "mongoose";

const MensajeSchema = new mongoose.Schema(
  {
    conversacionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversacion",
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Usuario",
      required: true,
    },
    texto: {
      type: String,
      required: true,
    },
    leido: {
      type: Boolean,
      default: false,
    },
    reminderSentAt: { type: Date, default: null },
    creado: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

MensajeSchema.index({ leido: 1, reminderSentAt: 1, creado: 1, conversacionId: 1 });

export default mongoose.model("Mensaje", MensajeSchema);
