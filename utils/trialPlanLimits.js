import Propiedad from "../models/Propiedad.js";
import Usuario from "../models/Usuario.js";
import { consumesPublicationQuota, getPlanParaLimites, publicationPlanIsCurrent } from "./publishEligibility.js";
import { getPublicationAvailability } from "./propertyCreation.js";
import { fencePublicationUser, publicationTransactionOptions } from "./publicationCapacity.js";
import { capacityTransitionError, isCapacityTransitionError } from "./propertyCapacityTransition.js";
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
  if (propiedad.hiddenByMissingRunId != null || propiedad.removedFromFeedAt != null) return false;
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
  now = new Date(),
  UsuarioModel = Usuario,
  PropiedadModel = Propiedad
} = {}) {
  let session, result;
  const canRecover = repararSiNoHayVisibles || repararPeriodosCaducados;
  try {
    session = await UsuarioModel.startSession();
    await session.withTransaction(async () => {
      // A purely reducing/renewing operation does not acquire publication capacity.
      if (canRecover) {
        const fence = await fencePublicationUser(UsuarioModel, usuarioId, session);
        if (!fence.matchedCount) throw capacityTransitionError("PUBLICATION_PLAN_INACTIVE", "El usuario no está disponible.");
      }
      let userQuery = UsuarioModel.findById(usuarioId);
      if (userQuery?.session) userQuery = userQuery.session(session);
      const user = await userQuery;
      if (!user || getPlanParaLimites(user) !== planDestino)
        throw capacityTransitionError("PUBLICATION_PLAN_CHANGED", "El plan ha cambiado. Vuelve a comprobar sus límites.", 409);
      const limiteAnuncios = getLimiteAnunciosPlan(planDestino), limiteFotos = getLimiteFotosPlan(planDestino);
      const fechaExpiracionVisible = calcularFechaExpiracionPlan(planDestino, now);
      let query = PropiedadModel.find({ usuarioId });
      if (query?.select) query = query.select("+hiddenByMissingRunId");
      if (query?.session) query = query.session(session);
      if (query?.lean) query = query.lean();
      const propiedades = await query;
      const availability = await getPublicationAvailability(user, { usuarioId, PropiedadModel, session });
      const visibles = ordenarPropiedadesParaPlan(propiedades.filter(p => propiedadValidaParaLimites(p)));
      const validas = ordenarPropiedadesParaPlan(propiedades.filter(p => propiedadValidaParaLimites(p, { incluirOcultas: true })));
      const recover = (repararSiNoHayVisibles && !visibles.some(p => propiedadVigenteEnGratis(p, now))) ||
        (repararPeriodosCaducados && validas.some(p => propiedadNecesitaNuevoPeriodoGratis(p, now)));
      let occupied = availability.anunciosActuales;
      let propiedadesOcultadas = 0, propiedadesRecuperadas = 0, fechasRenovadas = 0;
      async function write(p, fields, protection = false) {
        const filter = { _id: p._id, usuarioId,
          ...(protection ? { hiddenByMissingRunId: null, removedFromFeedAt: null } : {}),
          $or: (p.contentRevision ?? 0) === 0 ? [{ contentRevision: 0 }, { contentRevision: { $exists: false } }]
            : [{ contentRevision: p.contentRevision }] };
        const saved = await PropiedadModel.updateOne(filter, { $set: fields }, { session, runValidators: true });
        if (saved.matchedCount !== 1) return false;
        Object.assign(p, fields);
        return true;
      }
      for (const p of propiedades) if (!tieneOcultacionManualSeparada(p) && tieneEstadoNoDisponible(p) && p.visiblePublicamente !== false) {
        const consumed = consumesPublicationQuota(p);
        if (await write(p, { visiblePublicamente: false })) {
          if (consumed) occupied--;
          propiedadesOcultadas++;
        }
      }
      // Preserve already-public properties first. Only a real downgrade hides excess;
      // recovery never displaces an existing publication to make room for a hidden one.
      const permitted = [];
      const externalOccupied = Math.max(0, occupied - visibles.filter(consumesPublicationQuota).length);
      const visibleCapacity = Math.max(0, limiteAnuncios - externalOccupied);
      for (const p of visibles) {
        if (Number.isFinite(visibleCapacity) && permitted.length >= visibleCapacity) {
          const consumed = consumesPublicationQuota(p);
          if (await write(p, { visiblePublicamente: false }, true)) {
            if (consumed) occupied--;
            propiedadesOcultadas++;
          }
        } else permitted.push(p);
      }
      const recoveredIds = new Set();
      if (recover && publicationPlanIsCurrent(user, now)) for (const p of validas) {
        if (p.visiblePublicamente !== false || !propiedadValidaParaLimites(p, { incluirOcultas: true })) continue;
        if (occupied >= limiteAnuncios) break;
        if (await write(p, { visiblePublicamente: true, fechaExpiracion: fechaExpiracionVisible }, true)) {
          occupied++; permitted.push(p); recoveredIds.add(String(p._id)); propiedadesRecuperadas++; fechasRenovadas++;
        }
      }
      for (const p of permitted) if (!recoveredIds.has(String(p._id)) && fechaExpiracionVisible &&
        (renovarPermitidas || !p.fechaExpiracion || new Date(p.fechaExpiracion) <= now)) {
        if (await write(p, { fechaExpiracion: fechaExpiracionVisible }, true)) fechasRenovadas++;
      }
      if (propiedadesRecuperadas && !publicationPlanIsCurrent(user, new Date(Math.max(+now, Date.now()))))
        throw capacityTransitionError("PUBLICATION_PLAN_INACTIVE", "Necesitas un plan vigente para publicar.");
      result = { ok: true, plan: planDestino, limiteAnuncios, limiteFotos,
        propiedadesEvaluadas: propiedades.length, propiedadesVisibles: permitted.length,
        propiedadesOcultadas, propiedadesRecuperadas, fechasRenovadas };
    }, publicationTransactionOptions);
    return result;
  } catch (error) {
    if (isCapacityTransitionError(error)) throw error;
    throw capacityTransitionError("PUBLICATION_EDIT_UNCONFIRMED", "No se pudo confirmar la revisión de límites. Consulta el estado antes de repetirla.", 503);
  } finally {
    if (session) await session.endSession().catch(() => {});
  }
}

export async function repararUsuariosGratisTrasVipTrial() {
  const usuarios = await Usuario.find({
    plan: "gratis",
    activo: { $ne: false },
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
