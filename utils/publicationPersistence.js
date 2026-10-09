import mongoose from "mongoose";
import Usuario from "../models/Usuario.js";
import Propiedad from "../models/Propiedad.js";
import { buildPropiedadCreateData, getPublicationAvailability } from "./propertyCreation.js";
import { getLimiteFotosPlan } from "./planLimits.js";
import { getPlanParaFotos } from "./publishEligibility.js";

export class PublicationError extends Error {
  constructor(message, status = 403, options = {}) {
    super(message, options);
    this.status = status;
    this.retainImages = options.retainImages === true;
  }
}

export function createPublicationPersistence({ UsuarioModel = Usuario, PropiedadModel = Propiedad } = {}) {
  const persist = async ({ usuarioId, body, imagenes = [], extra = {}, propertyId = new mongoose.Types.ObjectId(), budget }) => {
    let created;
    let session;
    try {
      budget?.assertActive();
      session = await UsuarioModel.startSession();
      await session.withTransaction(async () => {
        budget?.assertActive();
        // All publishers write this same document before counting, serializing per user.
        const lock = await UsuarioModel.updateOne({ _id: usuarioId, activo: { $ne: false } },
          { $inc: { publicationVersion: 1 } }, { session, ...(budget ? { maxTimeMS: Math.max(1, budget.remainingMs()) } : {}) });
        if (!lock.matchedCount) throw new PublicationError("El usuario no está disponible.");
        let query = UsuarioModel.findById(usuarioId);
        if (query.session) query = query.session(session);
        const user = await query;
        const availability = await getPublicationAvailability(user, { usuarioId, PropiedadModel, session });
        if (!availability.planActivoParaPublicar) throw new PublicationError("Necesitas activar un plan para publicar.");
        if (!availability.puedePublicarAhora) throw new PublicationError("Has alcanzado el límite de anuncios de tu plan.");
        if (imagenes.length > getLimiteFotosPlan(getPlanParaFotos(user))) throw new PublicationError("Has superado el límite de fotos de tu plan.");
        budget?.assertActive();
        const data = buildPropiedadCreateData(body, { usuarioId, plan: availability.plan, imagenes });
        if (extra.source === "crm") data.banos = body.banos ?? 0;
        [created] = await PropiedadModel.create([{ ...data, ...extra, _id: propertyId }], { session });
        budget?.assertActive();
      }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" },
        maxCommitTimeMS: budget ? Math.max(1, budget.remainingMs()) : 10000 });
      return created;
    } catch (error) {
      // A rejected write/commit is not proof that the document was never persisted.
      try {
        let query = PropiedadModel.findById(propertyId);
        if (query.read) query = query.read("primary").readConcern("majority").maxTimeMS(5000);
        const stored = await query;
        if (stored) return stored;
        if (!error.hasErrorLabel?.("UnknownTransactionCommitResult")) throw error;
      } catch (verificationError) {
        if (verificationError === error) throw error;
      }
      throw new PublicationError("Resultado de guardado pendiente de reconciliación. No repitas la importación todavía.", 503,
        { cause: error, retainImages: true });
    } finally {
      if (session) await session.endSession().catch(() => {});
    }
  };
  return async input => {
    if (!input.budget) return persist(input);
    try {
      return await input.budget.run(() => persist(input));
    } catch (error) {
      if (error.code !== "IMPORT_TIMEOUT") throw error;
      // A transaction still completing after the deadline must be reconciled, not cleaned blindly.
      throw new PublicationError("El tiempo de guardado se agotó. El resultado requiere reconciliación.", 504,
        { cause: error, retainImages: true });
    }
  };
}

export const persistPublication = createPublicationPersistence();
