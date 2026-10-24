import { z, optionalCleanString, optionalNumberFromInput, priceFromInput, numberFromInput } from "./validation.js";

const tipoOperacionSchema = z.enum(["venta", "alquiler"]);
export const periodicidadPrecioSchema = z.enum(["mes", "semana", "dia", "temporada", "desconocida"]);
const tipoInmuebleSchema = z.enum([
  "piso", "apartamento", "atico", "duplex", "estudio",
  "casa", "chalet", "adosado", "casa_campo", "casa_madera",
  "local", "local_comercial", "oficina", "nave", "hotel", "edificio", "negocio",
  "terreno", "solar_urbano", "parcela", "finca_rustica", "finca_urbana",
  "garaje", "plaza_aparcamiento", "trastero", "otro"
]);
const estadoSchema = z.enum(["obra_nueva", "segunda_mano"]);
const certificadoEnergeticoSchema = z.enum([
  "A", "B", "C", "D", "E", "F", "G",
  "No disponible", "Exento", "En trámite"
]);
const estadoPropiedadSchema = z.enum(["Obra nueva", "Segunda mano", "Reformado", "A reformar"]);
const estadoComercialSchema = z.enum(["Disponible", "Reservado", "Vendido", "Alquilado"]);
const booleanInput = z
  .preprocess(value => typeof value === "boolean" ? String(value) : value, z.enum(["true", "false"]))
  .optional();
const requiredCleanString = (max, label) =>
  z.preprocess(
    value => typeof value === "string" ? value.trim().replace(/\s+/g, " ") : value,
    z.string().min(1, `${label} es obligatorio`).max(max)
  );

const propiedadBaseSchema = {
  titulo: requiredCleanString(160, "titulo"),
  referencia: optionalCleanString(80),
  direccion: requiredCleanString(300, "direccion"),
  ubicacionPublica: optionalCleanString(300),
  precisionUbicacion: z.enum(["exacta", "aproximada"]).optional(),
  localidad: optionalCleanString(120),
  provincia: optionalCleanString(120),
  codigoPostal: optionalCleanString(20),
  precio: priceFromInput.pipe(z.number().min(0)),
  periodicidadPrecio: periodicidadPrecioSchema.nullable().optional(),
  descripcion: optionalCleanString(5000),
  tipoOperacion: tipoOperacionSchema,
  habitaciones: numberFromInput.pipe(z.number().int().min(0)),
  lat: optionalNumberFromInput,
  lng: optionalNumberFromInput,
  videoUrl: optionalCleanString(500),
  banos: optionalNumberFromInput,
  superficie: optionalNumberFromInput,
  superficieParcela: optionalNumberFromInput,
  tipoInmueble: tipoInmuebleSchema.optional(),
  estado: estadoSchema.optional(),
  certificadoEnergetico: certificadoEnergeticoSchema.optional(),
  estadoPropiedad: estadoPropiedadSchema.optional(),
  estadoComercial: estadoComercialSchema.optional(),
  garaje: booleanInput,
  piscina: booleanInput,
  terraza: booleanInput,
  escaparate: booleanInput,
  usoPermitido: optionalCleanString(200),
  plantaLocal: optionalCleanString(80),
  numeroPlantas: z.enum(["1", "2", "3", "4_mas", ""]).optional(),
  sotano: z.enum(["si", "no", ""]).optional(),
  tipoGaraje: optionalCleanString(40),
  alturaMaxima: optionalNumberFromInput,
  accesoTrastero: optionalCleanString(80),
  imagenesExistentes: z.any().optional()
};

export const propiedadCreateSchema = z.object(propiedadBaseSchema).superRefine((data, ctx) => {
  if (data.tipoOperacion === "alquiler" && data.periodicidadPrecio == null) ctx.addIssue({ code: "custom", path: ["periodicidadPrecio"], message: "Selecciona la periodicidad del alquiler." });
  if (data.tipoOperacion === "venta" && data.periodicidadPrecio != null) ctx.addIssue({ code: "custom", path: ["periodicidadPrecio"], message: "No aplicable a venta." });
});
export const propiedadCrmCreateSchema = z.object({ ...propiedadBaseSchema,
  direccion: optionalCleanString(300)
}).superRefine((data, ctx) => {
  if (!data.direccion?.trim() && !data.localidad?.trim()) {
    ctx.addIssue({ code: "custom", path: ["localidad"], message: "Falta una localidad válida para la publicación CRM." });
  }
});
export const propiedadUpdateSchema = z.object({
  expectedContentRevision: z.preprocess(value => typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value,
    z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)).optional(),
  ...propiedadBaseSchema,
  titulo: propiedadBaseSchema.titulo.optional(),
  direccion: propiedadBaseSchema.direccion.optional(),
  precio: propiedadBaseSchema.precio.optional(),
  tipoOperacion: tipoOperacionSchema.optional(),
  habitaciones: propiedadBaseSchema.habitaciones.optional()
});

export const propiedadCrmUpdateSchema = z.object({ ...propiedadUpdateSchema.shape, direccion: optionalCleanString(300) });

export { tipoOperacionSchema, tipoInmuebleSchema, estadoSchema };
