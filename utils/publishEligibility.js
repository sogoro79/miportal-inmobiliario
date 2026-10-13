import { getLimiteAnunciosPlan, getPlanConfig, KNOWN_PLAN_IDS } from "./planLimits.js";

const nonQuotaStates = Object.freeze(["Vendido", "Alquilado", "Reservado", "No disponible"]);

// Exact in-memory counterpart of filtroPropiedadesValidasVisibles (no expiry filter).
export function consumesPublicationQuota(property = {}) {
  return property.visiblePublicamente !== false && property.activo !== false &&
    property.eliminada !== true && property.oculto !== true && !nonQuotaStates.includes(property.estadoComercial);
}

export function publicationPlanIsCurrent(user, now = new Date()) {
  if (!user || user.activo === false || !KNOWN_PLAN_IDS.includes(user.plan || "gratis") ||
    !usuarioTienePlanActivoParaPublicar(user)) return false;
  const future = value => value != null && Number.isFinite(new Date(value).getTime()) && new Date(value) > now;
  if (user.planFechaFin != null && !future(user.planFechaFin)) return false;
  if (user.plan === "vip_trial" && !future(user.trialEndDate)) return false;
  if (user.plan === "lanzamiento_2026" && (!future(user.planFechaFin) || !future(getPlanConfig(user.plan).expiracionFija))) return false;
  if (user.plan === "professional_trial_60d" && (user.professionalPromoStatus !== "active" || !future(user.professionalPromoEndsAt))) return false;
  return true;
}

export function getPlanParaFotos(usuario) {
  let plan = usuario?.plan || "gratis";
  if (plan === "vip_trial" && (!usuario.trialAccepted || !usuario.planActivo)) {
    plan = "gratis";
  }
  return plan;
}

export function getPlanParaLimites(usuario) {
  let plan = usuario?.plan || "gratis";
  if (plan === "vip_trial" && (!usuario.trialAccepted || !usuario.planActivo)) {
    plan = "gratis";
  }
  return plan;
}

export function usuarioTienePlanActivoParaPublicar(usuario) {
  const plan = usuario?.plan || "gratis";
  if (plan === "gratis") return true;
  if (plan === "vip_trial") return Boolean(usuario.trialAccepted && usuario.planActivo);
  return Boolean(usuario?.planActivo);
}

export function filtroPropiedadesValidasVisibles(usuarioId) {
  return {
    usuarioId,
    visiblePublicamente: { $ne: false },
    activo: { $ne: false },
    eliminada: { $ne: true },
    oculto: { $ne: true },
    estadoComercial: { $nin: [...nonQuotaStates] }
  };
}

export function getEstadoPublicacionUsuario(usuario, anunciosActuales = 0) {
  const plan = getPlanParaLimites(usuario);
  const limiteAnuncios = getLimiteAnunciosPlan(plan);
  const planActivoParaPublicar = usuarioTienePlanActivoParaPublicar(usuario);
  const anunciosUsados = Number(anunciosActuales || 0);
  const puedePublicarAhora = Boolean(planActivoParaPublicar && anunciosUsados < limiteAnuncios);

  return {
    plan,
    planActivoParaPublicar,
    limiteAnuncios,
    anunciosActuales: anunciosUsados,
    cupoDisponible: Math.max(0, limiteAnuncios - anunciosUsados),
    puedePublicarAhora,
    requierePlanes: !puedePublicarAhora,
    motivo: !planActivoParaPublicar
      ? "plan_inactivo"
      : anunciosUsados >= limiteAnuncios
        ? "limite_anuncios"
        : "puede_publicar"
  };
}
