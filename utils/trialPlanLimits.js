import Propiedad from "../models/Propiedad.js";
import Usuario from "../models/Usuario.js";
import {
  calcularFechaExpiracionPlan,
  getLimiteAnunciosPlan,
  getLimiteFotosPlan
} from "./planLimits.js";
import {
  propiedadDisponiblePublicamente,
  tieneEstadoNoDisponible,
  tieneOcultacionManualSeparada
} from "./propertyAvailability.js";

function propiedadValidaParaLimites(propiedad = {}, { incluirOcultas = false } = {}) {
  return propiedadDisponiblePublicamente(propiedad, { incluirOcultas });
}

function propiedadVigenteEnGratis(propiedad = {}, now = new Date()) {
  if (!propiedadValidaParaLimites(propiedad)) return false;
  if (!propiedad.fechaExpiracion) return false;
  return new Date(propiedad.fechaExpiracion) > now;
}

function propiedadNecesitaNuevoPeriodoGratis(propiedad = {}, now = new Date()) {
  if (!propiedadValidaParaLimites(propiedad, { incluirOcultas: true })) return false;
  if (propiedad.visiblePublicamente !== true) return false;
  if (!propiedad.fechaExpiracion) return true;
  return new Date(propiedad.fechaExpiracion) <= now;
}

function ordenarPropiedadesParaPlan(propiedades = []) {
  return [...propiedades].sort((a, b) => {
    const updatedA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const updatedB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    if (updatedA !== updatedB) return updatedB - updatedA;

    const createdA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const createdB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return createdB - createdA;
  });
}

export async function aplicarLimitesPlanTrasTrial(usuarioId, {
  planDestino = "gratis",
  repararSiNoHayVisibles = false,
  repararPeriodosCaducados = false,
  renovarPermitidas = true,
  now = new Date()
} = {}) {
  const limiteAnuncios = getLimiteAnunciosPlan(planDestino);
  const limiteFotos = getLimiteFotosPlan(planDestino);
  const fechaExpiracionVisible = calcularFechaExpiracionPlan(planDestino, now);

  const propiedades = await Propiedad.find({ usuarioId });
  const visiblesValidas = ordenarPropiedadesParaPlan(
    propiedades.filter(propiedad => propiedadValidaParaLimites(propiedad))
  );
  const todasValidas = ordenarPropiedadesParaPlan(
    propiedades.filter(propiedad => propiedadValidaParaLimites(propiedad, { incluirOcultas: true }))
  );
  const visiblesVigentes = visiblesValidas.filter(propiedad => propiedadVigenteEnGratis(propiedad, now));
  const necesitaReparacion = todasValidas.some(propiedad => propiedadNecesitaNuevoPeriodoGratis(propiedad, now));
  const repararOcultas = repararSiNoHayVisibles && visiblesVigentes.length === 0;
  const repararPeriodo = repararPeriodosCaducados && necesitaReparacion;
  const candidatas = repararOcultas ? todasValidas : visiblesValidas;
  const candidatasFinales = repararPeriodo ? todasValidas : candidatas;
  const permitidas = Number.isFinite(limiteAnuncios)
    ? candidatasFinales.slice(0, limiteAnuncios)
    : candidatasFinales;
  const permitidasIds = new Set(permitidas.map(propiedad => String(propiedad._id)));

  let propiedadesVisibles = 0;
  let propiedadesOcultadas = 0;
  let propiedadesRecuperadas = 0;
  let fechasRenovadas = 0;

  for (const propiedad of propiedades) {
    if (
      !tieneOcultacionManualSeparada(propiedad) &&
      tieneEstadoNoDisponible(propiedad) &&
      propiedad.visiblePublicamente !== false
    ) {
      propiedad.visiblePublicamente = false;
      await propiedad.save();
      propiedadesOcultadas += 1;
    }
  }

  for (const propiedad of todasValidas) {
    const debeSerVisible = permitidasIds.has(String(propiedad._id));
    if (debeSerVisible && propiedad.visiblePublicamente !== true) {
      propiedad.visiblePublicamente = true;
      propiedad.fechaExpiracion = fechaExpiracionVisible;
      await propiedad.save();
      propiedadesRecuperadas += 1;
      fechasRenovadas += 1;
    } else if (
      debeSerVisible &&
      fechaExpiracionVisible &&
      (renovarPermitidas || !propiedad.fechaExpiracion || new Date(propiedad.fechaExpiracion) <= now)
    ) {
      propiedad.fechaExpiracion = fechaExpiracionVisible;
      await propiedad.save();
      fechasRenovadas += 1;
    } else if (!debeSerVisible && propiedad.visiblePublicamente !== false) {
      propiedad.visiblePublicamente = false;
      await propiedad.save();
      propiedadesOcultadas += 1;
    }
    if (debeSerVisible) propiedadesVisibles += 1;
  }

  return {
    ok: true,
    plan: planDestino,
    limiteAnuncios,
    limiteFotos,
    propiedadesEvaluadas: propiedades.length,
    propiedadesVisibles,
    propiedadesOcultadas,
    propiedadesRecuperadas,
    fechasRenovadas
  };
}

export async function repararUsuariosGratisTrasVipTrial() {
  const usuarios = await Usuario.find({
    plan: "gratis",
    $or: [
      { trialStartDate: { $exists: true, $ne: null } },
      { trialEndDate: { $exists: true, $ne: null } },
      { trialLimitsAppliedAt: { $exists: true, $ne: null } },
      { "trialReminders.expired": true }
    ]
  });

  let usuariosReparados = 0;
  let propiedadesRecuperadas = 0;

  for (const usuario of usuarios) {
    const resultado = await aplicarLimitesPlanTrasTrial(usuario._id, {
      planDestino: "gratis",
      repararSiNoHayVisibles: true,
      repararPeriodosCaducados: true,
      renovarPermitidas: false
    });

    if (resultado.propiedadesRecuperadas > 0 || resultado.fechasRenovadas > 0) {
      usuariosReparados += 1;
      propiedadesRecuperadas += resultado.propiedadesRecuperadas;
      usuario.trialLimitsRepairedAt = new Date();
      await usuario.save();
    }
  }

  return {
    usuariosReparados,
    propiedadesRecuperadas
  };
}

export async function limitarFotosPublicasPorPlan(data) {
  const esArray = Array.isArray(data);
  const propiedades = esArray ? data : [data];
  const usuarioIds = [
    ...new Set(
      propiedades
        .map(propiedad => propiedad?.usuarioId)
        .filter(Boolean)
        .map(usuarioId => String(usuarioId))
    )
  ];

  if (!usuarioIds.length) return data;

  const usuarios = await Usuario.find(
    { _id: { $in: usuarioIds } },
    { plan: 1, planActivo: 1, trialAccepted: 1 }
  ).lean();
  const usuariosPorId = new Map(usuarios.map(usuario => [String(usuario._id), usuario]));

  const limitadas = propiedades.map(propiedad => {
    if (!propiedad) return propiedad;

    const item = typeof propiedad.toObject === "function"
      ? propiedad.toObject()
      : { ...propiedad };
    const usuario = usuariosPorId.get(String(item.usuarioId || ""));
    let plan = usuario?.plan || "gratis";
    if (plan === "vip_trial" && (!usuario?.trialAccepted || !usuario?.planActivo)) {
      plan = "gratis";
    }

    const limiteFotos = getLimiteFotosPlan(plan);
    if (Array.isArray(item.imagenes) && Number.isFinite(limiteFotos)) {
      item.imagenes = item.imagenes.slice(0, limiteFotos);
    }
    return item;
  });

  return esArray ? limitadas : limitadas[0];
}
