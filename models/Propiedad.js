import mongoose from "mongoose";

const PropiedadSchema = new mongoose.Schema({
  titulo:        { type: String, required: true },
  referencia:    { type: String, default: "" },
  direccion:     { type: String, required: true },
  localidad:     { type: String, default: "" },
  provincia:     { type: String, default: "" },
  codigoPostal:  { type: String, default: "" },
  precio:        { type: Number, required: true },
  descripcion:   { type: String },
  tipoOperacion: { type: String, enum: ["venta", "alquiler"], required: true },
  habitaciones:  { type: Number, default: 0 },
  imagenes:      { type: [String], default: [] },
  lat:           { type: Number },
  lng:           { type: Number },

  banos:         { type: Number, default: 0 },
  superficie:    { type: Number },
  superficieParcela: { type: Number },
  garaje:        { type: Boolean, default: false },
  piscina:       { type: Boolean, default: false },
  terraza:       { type: Boolean, default: false },

  tipoInmueble:  { 
    type: String, 
    enum: [
      "piso", "apartamento", "atico", "duplex", "estudio",
      "casa", "chalet", "adosado", "casa_campo", "casa_madera",
      "local", "local_comercial", "oficina", "nave", "hotel", "edificio", "negocio",
      "terreno", "solar_urbano", "parcela", "finca_rustica", "finca_urbana",
      "garaje", "plaza_aparcamiento", "trastero", "otro"
    ], 
    default: "piso" 
  },

  estado: { type: String, enum: ["obra_nueva", "segunda_mano"], default: "segunda_mano" },
  certificadoEnergetico: {
    type: String,
    enum: ["A", "B", "C", "D", "E", "F", "G", "No disponible", "Exento", "En trámite", ""],
    default: ""
  },
  estadoPropiedad: {
    type: String,
    enum: ["Obra nueva", "Segunda mano", "Reformado", "A reformar", ""],
    default: ""
  },
  estadoComercial: {
    type: String,
    enum: ["Disponible", "Reservado", "Vendido", "Alquilado", ""],
    default: "Disponible"
  },

  // Campos específicos para locales y oficinas
  usoPermitido:    { type: String, default: "" },  // ej: "hostelería, comercio, oficina"
  escaparate:      { type: Boolean, default: false },
  plantaLocal:     { type: String, default: "" },  // ej: "planta baja", "semisótano"
  numeroPlantas:   { type: String, enum: ["1", "2", "3", "4_mas", ""], default: "" },
  sotano:          { type: String, enum: ["si", "no", ""], default: "" },

  // Campos específicos para garajes y trasteros
  alturaMaxima:    { type: Number, default: null }, // en metros
  tipoGaraje:      { type: String, enum: ["individual", "multiple", ""], default: "" },
  accesoTrastero:  { type: String, default: "" },  // ej: "ascensor", "escaleras"

  // Para saber quién publicó cada anuncio
  usuarioId: { type: mongoose.Schema.Types.ObjectId, ref: "Usuario" },
  visiblePublicamente: { type: Boolean, default: true },

  // Estadísticas
  visitas:        { type: Number, default: 0 },
  contactos:      { type: Number, default: 0 },
  ultimaVisita:   { type: Date, default: null },
  ultimoContacto: { type: Date, default: null },
  redesPublicadoCount: { type: Number, default: 0 },
  redesUltimaPublicacionAt: { type: Date, default: null },
  redesPublicadoManual: { type: Boolean, default: false },
  redesProximaPublicacionAt: { type: Date, default: null },
  redesNotasPublicacion: { type: String, default: "" },
  redesCanalPreferente: { type: String, enum: ["facebook", "instagram", "ambos", ""], default: "" },
  fechaExpiracion: { type: Date, default: null },
  videoUrl: { type: String, default: "" },
}, { timestamps: true });

export default mongoose.model("Propiedad", PropiedadSchema);
