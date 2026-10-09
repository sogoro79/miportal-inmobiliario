import Propiedad from "../models/Propiedad.js";
import { calcularFechaExpiracionPlan } from "./planLimits.js";
import {
  filtroPropiedadesValidasVisibles,
  getEstadoPublicacionUsuario
} from "./publishEligibility.js";

const tiposConPlanta = new Set([
  "piso", "apartamento", "atico", "duplex", "estudio",
  "local", "local_comercial", "oficina"
]);
const tiposViviendaCompleta = new Set(["casa", "chalet", "adosado", "casa_campo", "casa_madera"]);

export async function getPublicationAvailability(usuario, {
  usuarioId = usuario?._id,
  PropiedadModel = Propiedad,
  session
} = {}) {
  let count = PropiedadModel.countDocuments(filtroPropiedadesValidasVisibles(usuarioId));
  if (session && count.session) count = count.session(session);
  const anunciosActuales = await count;
  return getEstadoPublicacionUsuario(usuario, anunciosActuales);
}

export function buildPropiedadCreateData(body = {}, {
  usuarioId,
  plan = "gratis",
  imagenes = []
} = {}) {
  const tipoInmueble = body.tipoInmueble || "piso";

  return {
    titulo: body.titulo,
    referencia: body.referencia || "",
    direccion: body.direccion,
    localidad: body.localidad || "",
    provincia: body.provincia || "",
    codigoPostal: body.codigoPostal || "",
    precio: Number(body.precio),
    descripcion: body.descripcion,
    videoUrl: body.videoUrl || "",
    tipoOperacion: body.tipoOperacion,
    habitaciones: Number(body.habitaciones),
    banos: Number(body.banos) || 1,
    superficie: body.superficie ? Number(body.superficie) : null,
    superficieParcela: body.superficieParcela ? Number(body.superficieParcela) : null,
    tipoInmueble,
    estado: body.estado || "segunda_mano",
    certificadoEnergetico: body.certificadoEnergetico || "",
    estadoPropiedad: body.estadoPropiedad || "",
    estadoComercial: body.estadoComercial || "Disponible",
    plantaLocal: tiposConPlanta.has(tipoInmueble) ? (body.plantaLocal || "") : "",
    numeroPlantas: tiposViviendaCompleta.has(tipoInmueble) ? (body.numeroPlantas || "") : "",
    sotano: tiposViviendaCompleta.has(tipoInmueble) ? (body.sotano || "") : "",
    garaje: body.garaje === "true",
    piscina: body.piscina === "true",
    terraza: body.terraza === "true",
    usuarioId: usuarioId || null,
    lat: body.lat !== undefined && body.lat !== null && body.lat !== "" ? Number(body.lat) : null,
    lng: body.lng !== undefined && body.lng !== null && body.lng !== "" ? Number(body.lng) : null,
    imagenes,
    fechaExpiracion: plan === "gratis" ? calcularFechaExpiracionPlan(plan) : null
  };
}
