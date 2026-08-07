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
    creado: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

export default mongoose.model("Mensaje", MensajeSchema);
