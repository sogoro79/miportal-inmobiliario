import mongoose from "mongoose";
import { CONTENT_FIELDS } from "../utils/propertyContent.js";
import { BEDROOM_STATES, bedroomCreateData, bedroomDataValid } from "../utils/bedrooms.js";

const PropiedadSchema = new mongoose.Schema({
  source: { type: String, enum: ["manual", "crm"], default: "manual" },
  externalId: { type: String },
  importSourceId: { type: mongoose.Schema.Types.ObjectId, ref: "ImportSource" },
  importedAt: { type: Date },
  lastImportedAt: { type: Date },
  syncEnabled: { type: Boolean, default: false },
  lastSeenAt: Date,
  lastSeenRunId: { type: mongoose.Schema.Types.ObjectId, ref: "ImportSyncRun" },
  lastSyncedAt: Date,
  syncFingerprint: String,
  syncFingerprintVersion: Number,
  syncApplyFingerprint: String,
  syncApplyFingerprintVersion: Number,
  contentRevision: { type: Number, default: 0 },
  syncOverrides: {
    type: new mongoose.Schema(Object.fromEntries(CONTENT_FIELDS.map(field => [field, Boolean])), { _id: false }),
    default: () => ({})
  },
  removedFromFeedAt: Date,
  hiddenByMissingRunId: { type: mongoose.Schema.Types.ObjectId, ref: "ImportSyncRun", select: false },
  titulo:        { type: String, required: true },
  referencia:    { type: String, default: "" },
  direccion:     { type: String, default: "" },
  ubicacionPublica: { type: String },
  precisionUbicacion: { type: String, enum: ["exacta", "aproximada"] },
  localidad:     { type: String, default: "" },
  provincia:     { type: String, default: "" },
  codigoPostal:  { type: String, default: "" },
  precio:        { type: Number, required: true },
  periodicidadPrecio: { type: String, enum: ["mes", "semana", "dia", "temporada", "desconocida", null] },
  descripcion:   { type: String },
  tipoOperacion: { type: String, enum: ["venta", "alquiler"], required: true },
  habitaciones: { type: Number, validate: value => value == null || Number.isSafeInteger(value) && value >= 0 },
  habitacionesEstado: { type: String, enum: BEDROOM_STATES },
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

  estado: { type: String, enum: ["obra_nueva", "segunda_mano", "no_informado"] },
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

PropiedadSchema.pre("validate", function () {
  if (this.isNew) Object.assign(this, bedroomCreateData(this));
  if ((this.isNew || this.isModified("habitaciones") || this.isModified("habitacionesEstado") || this.isModified("tipoInmueble")) && !bedroomDataValid(this)) {
    this.invalidate("habitaciones", "Datos de habitaciones inválidos.");
  }
  // Do not materialize a condition when hydrating/saving a legacy document.
  if (this.isNew && this.estado === undefined) this.estado = "no_informado";
  if (this.tipoOperacion === "venta" && (this.isNew || this.periodicidadPrecio !== undefined)) this.periodicidadPrecio = null;
  else if (this.isNew && this.periodicidadPrecio == null) this.periodicidadPrecio = "desconocida";
});

PropiedadSchema.index({ usuarioId: 1, importSourceId: 1, externalId: 1 }, {
  unique: true,
  partialFilterExpression: {
    source: "crm",
    usuarioId: { $type: "objectId" },
    importSourceId: { $type: "objectId" },
    externalId: { $type: "string" }
  }
});

export default mongoose.model("Propiedad", PropiedadSchema);
