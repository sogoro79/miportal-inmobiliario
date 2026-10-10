import crypto from "node:crypto";
import Propiedad from "../../models/Propiedad.js";
import Usuario from "../../models/Usuario.js";
import ImportSource from "../../models/ImportSource.js";
import ImportReconciliation from "../../models/ImportReconciliation.js";
import mongoose from "mongoose";
import { getPublicationAvailability } from "../propertyCreation.js";
import { createPublicationPersistence } from "../publicationPersistence.js";
import { createImportBudget, MAX_BATCH_PROPERTIES, MAX_BATCH_PHOTOS } from "./importBudget.js";
import { propiedadCreateSchema } from "../propertySchemas.js";
import { getLimiteFotosPlan } from "../planLimits.js";
import { getPlanParaFotos } from "../publishEligibility.js";
import { configureCloudinary, uploadBuffer, destroyByPublicId } from "../cloudinaryService.js";
import { fetchImportImage } from "./imageFetcher.js";
import { maskFeedUrl, parseAndValidateFeedUrl } from "./feedSecurity.js";

export class ImportError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const imageErrorCodes = new Set([
  "DNS_LOOKUP_FAILED", "PRIVATE_IP", "FEED_UNREACHABLE", "FEED_TIMEOUT",
  "FEED_TOO_LARGE", "TOO_MANY_REDIRECTS", "BAD_STATUS", "IMAGE_INVALID",
  "IMAGE_DIMENSIONS_INVALID", "IMPORT_TIMEOUT", "ECONNREFUSED", "ETIMEDOUT",
  "ENETUNREACH", "ENOTFOUND", "ERR_INVALID_IP_ADDRESS"
]);

function logImageFailure(error, phase, imageIndex) {
  const candidate = error?.internalCode || error?.code;
  console.warn("[CRM Import Image]", {
    imageIndex, phase, code: imageErrorCodes.has(candidate) ? candidate : "IMAGE_FAILED"
  });
}

export function feedHash(rawUrl) {
  return crypto.createHash("sha256").update(parseAndValidateFeedUrl(rawUrl).toString()).digest("hex");
}

export function validateImportProperty(property) {
  const text = value => typeof value === "string" ? value.replace(/<[^>]*>/g, "").trim() : value;
  const parsed = propiedadCreateSchema.safeParse({ ...property,
    titulo: text(property.titulo), descripcion: text(property.descripcion), direccion: text(property.direccion),
    superficie: property.superficie ?? undefined
  });
  const errors = [...(property.errors || [])];
  if (!property.externalId) errors.push("No se puede importar: referencia externa ausente");
  if (String(property.externalId || "").length > 200) errors.push("Referencia externa demasiado larga");
  if (!parsed.success) errors.push(`Revisa estos campos: ${[...new Set(parsed.error.issues.map(issue => issue.path.join(".")))].join(", ")}`);
  return { data: parsed.success ? parsed.data : null, errors: [...new Set(errors)] };
}

export function createSelectedImporter({
  PropiedadModel = Propiedad, UsuarioModel = Usuario, ImportSourceModel = ImportSource,
  ReconciliationModel = ImportReconciliation,
  persist = createPublicationPersistence({ PropiedadModel, UsuarioModel }),
  downloadImage = fetchImportImage,
  uploadImage = buffer => { configureCloudinary(); return uploadBuffer(buffer); },
  deleteImage = destroyByPublicId,
  now = () => new Date()
} = {}) {
  return async ({ usuarioId, feedUrl, analyzed, selectedExternalIds, budget: suppliedBudget }) => {
    const budget = suppliedBudget || createImportBudget({ now: () => now().getTime() });
    try {
      budget.assertActive();
      const hash = feedHash(feedUrl);
      const user = await budget.run(() => UsuarioModel.findById(usuarioId));
      if (!user || user.activo === false) throw new ImportError("Usuario no disponible.", 403);
      const initial = await budget.run(() => getPublicationAvailability(user, { usuarioId, PropiedadModel }));
      if (!initial.planActivoParaPublicar) throw new ImportError("Necesitas activar un plan para importar.", 403);
      const selected = [...new Set(selectedExternalIds)];
      if (selected.length > MAX_BATCH_PROPERTIES) throw new ImportError(`Selecciona como máximo ${MAX_BATCH_PROPERTIES} inmuebles por lote.`);
      const matches = new Map();
      for (const property of analyzed.properties) {
        if (!matches.has(property.externalId)) matches.set(property.externalId, []);
        matches.get(property.externalId).push(property);
      }
      if (selected.some(id => !matches.has(id))) throw new ImportError("La selección no corresponde al feed actual. Analízalo de nuevo.");
      const maxPhotosForBatch = getLimiteFotosPlan(getPlanParaFotos(user));
      const plannedPhotos = new Map(selected.map(id => [id, matches.get(id)[0].fotos.slice(0, maxPhotosForBatch)]));
      const importablePhotos = [...plannedPhotos.values()].reduce((total, photos) => total + photos.length, 0);
      if (importablePhotos > MAX_BATCH_PHOTOS) throw new ImportError("El lote supera 100 fotos importables. Reduce la selección.");
      // Esperar a los índices antes de permitir escrituras CRM en producción.
      await budget.run(() => Promise.all([PropiedadModel.init?.(), ImportSourceModel.init?.(), ReconciliationModel.init?.()]));
      let source = await budget.run(() => ImportSourceModel.findOne({ usuarioId }));
      if (source && source.feedUrlHash !== hash) throw new ImportError("Solo se admite una fuente CRM por usuario en esta fase.");
      if (!source) {
        try {
          source = await budget.run(() => ImportSourceModel.create({ usuarioId, feedType: analyzed.feedType, feedUrlHash: hash,
            feedUrlMasked: maskFeedUrl(feedUrl), lastAnalyzedAt: now() }));
        } catch (error) {
          if (error?.code !== 11000) throw error;
          source = await budget.run(() => ImportSourceModel.findOne({ usuarioId }));
          if (!source || source.feedUrlHash !== hash) throw new ImportError("Ya existe otra fuente CRM para este usuario.", 409);
        }
      }
      const lockToken = crypto.randomUUID();
      const start = now();
      const locked = await budget.run(() => ImportSourceModel.findOneAndUpdate({ _id: source._id, activo: true, feedUrlHash: hash,
        $or: [{ importLockUntil: { $exists: false } }, { importLockUntil: null }, { importLockUntil: { $lte: start } }]
      }, { $set: { importLockToken: lockToken, importLockUntil: new Date(start.getTime() + 15 * 60 * 1000), lastAnalyzedAt: start } }, { new: true }), {
        onLateResult: () => ImportSourceModel.updateOne({ _id: source._id, importLockToken: lockToken }, { $unset: { importLockToken: "", importLockUntil: "" } })
      });
      if (!locked) throw new ImportError("Ya hay una importación en curso. Espera a que termine.", 409);
      const results = [];
      const identity = externalId => ({ usuarioId, importSourceId: source._id, externalId, source: "crm" });
      const cleanup = async images => {
        let complete = true;
        for (const image of images) {
          try {
            const result = await deleteImage(image.publicId);
            if (result?.ok === false) { complete = false; console.warn("[CRM Import Cleanup]", { code: "IMAGE_CLEANUP_FAILED" }); }
          }
          catch { complete = false; console.warn("[CRM Import Cleanup]", { code: "IMAGE_CLEANUP_FAILED" }); }
        }
        return complete;
      };
      try {
        const existing = await budget.run(() => PropiedadModel.find({ usuarioId, importSourceId: source._id, source: "crm", externalId: { $in: selected } }));
        const duplicateIds = new Set(existing.map(item => item.externalId));
        const toCreate = selected.filter(id => !duplicateIds.has(id));
        const availability = await budget.run(() => getPublicationAvailability(user, { usuarioId, PropiedadModel }));
        if (toCreate.length > availability.cupoDisponible) {
          throw new ImportError(`Tu plan permite importar ${availability.cupoDisponible} inmuebles más. Has seleccionado ${toCreate.length}.`);
        }
        for (const externalId of selected) {
          if (duplicateIds.has(externalId)) { results.push({ externalId, status: "skipped", reason: "duplicate" }); continue; }
          const properties = matches.get(externalId);
          const validation = validateImportProperty(properties[0]);
          if (properties.length !== 1 || validation.errors.length) {
            results.push({ externalId, status: "skipped", reason: "invalid_data", errors: properties.length !== 1 ? ["Referencia repetida dentro del feed"] : validation.errors });
            continue;
          }
          const images = [];
          const warnings = [];
          let attemptedImages = 0;
          let skippedImages = 0;
          let persisted = false;
          let journaled = false;
          const propertyId = new mongoose.Types.ObjectId();
          try {
            budget.assertActive();
            const pending = await budget.run(() => ReconciliationModel.findOne({ usuarioId, importSourceId: source._id, externalId }));
            if (pending) throw new ImportError("Hay recursos pendientes de reconciliación para este inmueble. Solicita revisión antes de repetirlo.", 409);
            const freshUser = await budget.run(() => UsuarioModel.findById(usuarioId));
            if (!freshUser || freshUser.activo === false) throw new ImportError("El usuario ya no está disponible.");
            const fresh = await budget.run(() => getPublicationAvailability(freshUser, { usuarioId, PropiedadModel }));
            if (!fresh.puedePublicarAhora) throw new ImportError("El plan o el cupo disponible ha cambiado.");
            const maxPhotos = getLimiteFotosPlan(getPlanParaFotos(freshUser));
            await budget.run(() => ReconciliationModel.create({ propiedadId: propertyId, usuarioId, importSourceId: source._id, externalId, publicIds: [], state: "prepared" }));
            journaled = true;
            for (const url of plannedPhotos.get(externalId).slice(0, maxPhotos)) {
              budget.assertActive();
              attemptedImages += 1;
              let phase = "download";
              try {
                const buffer = await budget.run(() => downloadImage(url, { budget }));
                budget.assertActive();
                phase = "upload";
                images.push(await budget.run(() => uploadImage(buffer), { onLateResult: async image => {
                  if (!await cleanup([image])) {
                    await ReconciliationModel.updateOne({ propiedadId: propertyId }, { $set: {
                      usuarioId, importSourceId: source._id, externalId, state: "cleanup_required"
                    }, $addToSet: { publicIds: image.publicId } }, { upsert: true }).catch(() => {});
                  }
                } }));
              }
              catch (error) {
                skippedImages += 1;
                logImageFailure(error, phase, attemptedImages);
                if (error.code === "IMPORT_TIMEOUT") throw error;
                warnings.push("No se pudo importar una imagen: formato, tamaño, conexión o subida.");
              }
              await budget.run(() => ReconciliationModel.updateOne({ propiedadId: propertyId }, { $set: { publicIds: images.map(image => image.publicId) } }));
            }
            // Revalidar después de las descargas, antes de publicar.
            const finalUser = await budget.run(() => UsuarioModel.findById(usuarioId));
            if (!finalUser || finalUser.activo === false) throw new ImportError("El usuario ya no está disponible.");
            const finalAvailability = await budget.run(() => getPublicationAvailability(finalUser, { usuarioId, PropiedadModel }));
            budget.assertActive();
            if (!finalAvailability.puedePublicarAhora) throw new ImportError("El plan o cupo disponible ha cambiado.");
            if (images.length > getLimiteFotosPlan(getPlanParaFotos(finalUser))) throw new ImportError("El límite de fotos del plan ha cambiado.");
            const date = now();
            const created = await persist({ usuarioId, body: validation.data, propertyId, budget,
              imagenes: images.map(image => image.url), extra: { ...identity(externalId), visiblePublicamente: true, importedAt: date, lastImportedAt: date } });
            persisted = true;
            results.push({ externalId, status: "imported", propertyId: String(created._id), warnings,
              attemptedImages, importedImages: images.length, skippedImages });
            await ReconciliationModel.deleteOne({ propiedadId: propertyId }).catch(() => {});
          } catch (error) {
            if (persisted) continue;
            if (error.retainImages) {
              if (journaled) await ReconciliationModel.updateOne({ propiedadId: propertyId }, { $set: { state: "unknown" } }).catch(() => {});
            } else {
              const cleaned = await cleanup(images);
              if (journaled) {
                if (cleaned) await ReconciliationModel.deleteOne({ propiedadId: propertyId }).catch(() => {});
                else await ReconciliationModel.updateOne({ propiedadId: propertyId }, { $set: { state: "cleanup_required" } }).catch(() => {});
              }
            }
            results.push({ externalId, status: "skipped", reason: error.retainImages ? "reconciliation_required" : error?.code === 11000 ? "duplicate" : "creation_failed",
              attemptedImages, importedImages: 0, skippedImages,
              errors: [error instanceof ImportError || error.status ? error.message : "No se pudo crear el inmueble."], warnings });
            if (error.code === "IMPORT_TIMEOUT" || error.retainImages) {
              for (const remaining of selected.slice(selected.indexOf(externalId) + 1)) results.push({ externalId: remaining, status: "skipped", reason: "not_started" });
              break;
            }
          }
        }
        await ImportSourceModel.updateOne({ _id: source._id, importLockToken: lockToken }, { $set: { lastImportedAt: now() } }).catch(() => console.warn("[CRM Import]", { code: "SOURCE_TIMESTAMP_FAILED" }));
        const imported = results.filter(item => item.status === "imported").length;
        const imageTotals = results.reduce((totals, item) => {
          for (const key of Object.keys(totals)) totals[key] += item[key] || 0;
          return totals;
        }, { attemptedImages: 0, importedImages: 0, skippedImages: 0 });
        return { requested: selected.length, imported, skipped: results.length - imported, ...imageTotals, results };
      } finally {
        await ImportSourceModel.updateOne({ _id: source._id, importLockToken: lockToken }, { $unset: { importLockToken: "", importLockUntil: "" } }).catch(() => console.warn("[CRM Import]", { code: "SOURCE_UNLOCK_FAILED" }));
      }
    } finally {
      if (!suppliedBudget) budget.dispose();
    }
  };
}
