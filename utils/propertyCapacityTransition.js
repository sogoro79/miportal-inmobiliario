import Usuario from "../models/Usuario.js";
import Propiedad from "../models/Propiedad.js";
import { consumesPublicationQuota, publicationPlanIsCurrent } from "./publishEligibility.js";
import { getPublicationAvailability } from "./propertyCreation.js";
import { fencePublicationUser, publicationTransactionOptions } from "./publicationCapacity.js";
import { propertyRevisionError, isPropertyRevisionConflict } from "./propertyRevision.js";

export const capacityTransitionError = (code, message, status = 403, retainImages = false) =>
  Object.assign(new Error(message), { code, status, retainImages });
export function isCapacityTransitionError(error) {
  return ["PUBLICATION_PLAN_LIMIT", "PUBLICATION_PLAN_INACTIVE", "PUBLICATION_PLAN_CHANGED",
    "PUBLICATION_MISSING_PROTECTED", "PUBLICATION_EDIT_UNCONFIRMED", "PUBLICATION_EDIT_FAILED"].includes(error?.code);
}

function applySet(target, fields = {}) {
  for (const [key, value] of Object.entries(fields)) {
    const parts = key.split("."); let node = target;
    for (const part of parts.slice(0, -1)) node = node[part] ||= {};
    node[parts.at(-1)] = value;
  }
}

export function createPropertyCapacityTransition({ UsuarioModel = Usuario, PropiedadModel = Propiedad,
  now = () => new Date() } = {}) {
  return async (property, before) => {
    const prepared = property.toObject?.() || { ...property };
    const previous = { ...prepared, ...before };
    if (consumesPublicationQuota(previous) || !consumesPublicationQuota(prepared)) {
      await property.save();
      return property;
    }
    // Capture once: callback retries must not repeat document mutations or external effects.
    await property.validate();
    const changes = property.getChanges();
    const where = property.$where;
    const usuarioId = property.usuarioId, propertyId = property._id;
    let session, transactionStarted = false;
    try {
      session = await UsuarioModel.startSession();
      transactionStarted = true;
      await session.withTransaction(async () => {
        const fenced = await fencePublicationUser(UsuarioModel, usuarioId, session);
        if (!fenced.matchedCount) throw capacityTransitionError("PUBLICATION_PLAN_INACTIVE", "El usuario no está disponible.");
        let userQuery = UsuarioModel.findById(usuarioId);
        if (userQuery?.session) userQuery = userQuery.session(session);
        const user = await userQuery;
        if (!publicationPlanIsCurrent(user, now())) throw capacityTransitionError("PUBLICATION_PLAN_INACTIVE", "Necesitas un plan vigente para publicar.");
        let query = PropiedadModel.findOne({ _id: propertyId, usuarioId });
        if (query?.select) query = query.select("+hiddenByMissingRunId");
        if (query?.session) query = query.session(session);
        if (query?.lean) query = query.lean();
        const current = await query;
        if (!current) throw propertyRevisionError();
        const expected = where?.contentRevision ?? (prepared.contentRevision ?? 0) - (changes.$inc?.contentRevision || 0);
        if (expected !== undefined && (current.contentRevision ?? 0) !== expected) throw propertyRevisionError();
        const next = { ...current };
        applySet(next, changes.$set);
        for (const field of Object.keys(changes.$unset || {})) delete next[field];
        if (!consumesPublicationQuota(next)) throw propertyRevisionError();
        if (current.hiddenByMissingRunId != null || current.removedFromFeedAt != null)
          throw capacityTransitionError("PUBLICATION_MISSING_PROTECTED", "Este anuncio requiere restauración manual desde CRM.", 409);
        if (!consumesPublicationQuota(current) && consumesPublicationQuota(next)) {
          const availability = await getPublicationAvailability(user, { usuarioId, PropiedadModel, session });
          if (!availability.puedePublicarAhora) throw capacityTransitionError("PUBLICATION_PLAN_LIMIT", "Has alcanzado el límite de anuncios de tu plan.");
        }
        const revision = current.contentRevision ?? 0;
        const filter = { _id: propertyId, usuarioId, hiddenByMissingRunId: null, removedFromFeedAt: null,
          $and: [where || {}, revision === 0 ? { $or: [{ contentRevision: 0 }, { contentRevision: { $exists: false } }] }
            : { contentRevision: revision }] };
        const saved = await PropiedadModel.updateOne(filter, { ...changes,
          ...(changes.$set ? { $set: { ...changes.$set } } : {}), ...(changes.$inc ? { $inc: { ...changes.$inc } } : {})
        }, { session, runValidators: true });
        if (saved.matchedCount !== 1) throw propertyRevisionError();
        if (!publicationPlanIsCurrent(user, now())) throw capacityTransitionError("PUBLICATION_PLAN_INACTIVE", "Necesitas un plan vigente para publicar.");
      }, publicationTransactionOptions);
      return property;
    } catch (error) {
      if (isCapacityTransitionError(error) || isPropertyRevisionConflict(error)) throw error;
      const transient = error?.hasErrorLabel?.("TransientTransactionError") || error?.errorLabels?.includes("TransientTransactionError");
      if (error?.hasErrorLabel?.("UnknownTransactionCommitResult") || error?.errorLabels?.includes("UnknownTransactionCommitResult") ||
        (transactionStarted && !transient && error?.code !== 11000))
        throw capacityTransitionError("PUBLICATION_EDIT_UNCONFIRMED", "No se pudo confirmar el guardado. Recarga el anuncio antes de volver a intentarlo.", 503, true);
      throw capacityTransitionError("PUBLICATION_EDIT_FAILED", "No se pudo guardar el anuncio. Recarga la ficha antes de volver a intentarlo.", 500);
    } finally {
      if (session) await session.endSession().catch(() => {});
    }
  };
}

export const savePropertyWithCapacity = createPropertyCapacityTransition();
