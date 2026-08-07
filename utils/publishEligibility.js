import { getLimiteAnunciosPlan } from "./planLimits.js";

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
    estadoComercial: { $nin: ["Vendido", "Alquilado", "Reservado", "No disponible"] }
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
