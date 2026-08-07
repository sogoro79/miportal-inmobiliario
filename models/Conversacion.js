import mongoose from "mongoose";

const ConversacionSchema = new mongoose.Schema(
  {
    propiedadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Propiedad",
      required: true,
    },
    compradorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Usuario",
      required: true,
    },
    anuncianteId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Usuario",
      required: true,
    },
    hiddenFor: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: "Usuario",
      default: [],
    },
    deletedParticipants: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: "Usuario",
      default: [],
    },
    creado: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

export default mongoose.model("Conversacion", ConversacionSchema);
