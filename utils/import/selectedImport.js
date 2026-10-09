import crypto from "node:crypto";
import Propiedad from "../../models/Propiedad.js";
import Usuario from "../../models/Usuario.js";
import ImportSource from "../../models/ImportSource.js";
import { buildPropiedadCreateData, getPublicationAvailability } from "../propertyCreation.js";
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
  downloadImage = fetchImportImage,
  uploadImage = buffer => { configureCloudinary(); return uploadBuffer(buffer); },
  deleteImage = destroyByPublicId,
  now = () => new Date()
} = {}) {
  return async ({ usuarioId, feedUrl, analyzed, selectedExternalIds }) => {
    const hash = feedHash(feedUrl);
    const user = await UsuarioModel.findById(usuarioId);
    if (!user || user.activo === false) throw new ImportError("Usuario no disponible.", 403);
    const initial = await getPublicationAvailability(user, { usuarioId, PropiedadModel });
    if (!initial.planActivoParaPublicar) throw new ImportError("Necesitas activar un plan para importar.", 403);
    const selected = [...new Set(selectedExternalIds)];
    const matches = new Map();
    for (const property of analyzed.properties) {
      if (!matches.has(property.externalId)) matches.set(property.externalId, []);
      matches.get(property.externalId).push(property);
    }
    if (selected.some(id => !matches.has(id))) throw new ImportError("La selección no corresponde al feed actual. Analízalo de nuevo.");
    // Esperar a los índices antes de permitir escrituras CRM en producción.
    await Promise.all([PropiedadModel.init?.(), ImportSourceModel.init?.()]);
    let source = await ImportSourceModel.findOne({ usuarioId });
    if (source && source.feedUrlHash !== hash) throw new ImportError("Solo se admite una fuente CRM por usuario en esta fase.");
    if (!source) {
      try {
        source = await ImportSourceModel.create({ usuarioId, feedType: analyzed.feedType, feedUrlHash: hash,
          feedUrlMasked: maskFeedUrl(feedUrl), lastAnalyzedAt: now() });
      } catch (error) {
        if (error?.code !== 11000) throw error;
        source = await ImportSourceModel.findOne({ usuarioId });
        if (!source || source.feedUrlHash !== hash) throw new ImportError("Ya existe otra fuente CRM para este usuario.", 409);
      }
    }
    const lockToken = crypto.randomUUID();
    const start = now();
    const locked = await ImportSourceModel.findOneAndUpdate({ _id: source._id, activo: true,
      $or: [{ importLockUntil: { $exists: false } }, { importLockUntil: null }, { importLockUntil: { $lte: start } }]
    }, { $set: { importLockToken: lockToken, importLockUntil: new Date(start.getTime() + 15 * 60 * 1000), lastAnalyzedAt: start } }, { new: true });
    if (!locked) throw new ImportError("Ya hay una importación en curso. Espera a que termine.", 409);
    const results = [];
    const identity = externalId => ({ usuarioId, importSourceId: source._id, externalId, source: "crm" });
    const cleanup = async images => {
      for (const image of images) {
        try {
          const result = await deleteImage(image.publicId);
          if (result?.ok === false) console.warn("[CRM Import Cleanup]", { code: "IMAGE_CLEANUP_FAILED" });
        }
        catch { console.warn("[CRM Import Cleanup]", { code: "IMAGE_CLEANUP_FAILED" }); }
      }
    };
    const boundedUpload = buffer => new Promise((resolve, reject) => {
      let expired = false;
      const timer = setTimeout(() => { expired = true; reject(new ImportError("Tiempo de subida de imagen agotado.")); }, 30000);
      Promise.resolve().then(() => uploadImage(buffer)).then(image => {
        clearTimeout(timer);
        if (expired) { void cleanup([image]); return; }
        resolve(image);
      }, error => { clearTimeout(timer); if (!expired) reject(error); });
    });
    try {
      const existing = await PropiedadModel.find({ usuarioId, importSourceId: source._id, source: "crm", externalId: { $in: selected } });
      const duplicateIds = new Set(existing.map(item => item.externalId));
      const toCreate = selected.filter(id => !duplicateIds.has(id));
      const availability = await getPublicationAvailability(user, { usuarioId, PropiedadModel });
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
        let persisted = false;
        try {
          if (now().getTime() - start.getTime() > 10 * 60 * 1000) throw new ImportError("Tiempo máximo de importación alcanzado.");
          const freshUser = await UsuarioModel.findById(usuarioId);
          if (!freshUser || freshUser.activo === false) throw new ImportError("El usuario ya no está disponible.");
          const fresh = await getPublicationAvailability(freshUser, { usuarioId, PropiedadModel });
          if (!fresh.puedePublicarAhora) throw new ImportError("El plan o el cupo disponible ha cambiado.");
          const maxPhotos = getLimiteFotosPlan(getPlanParaFotos(freshUser));
          for (const url of properties[0].fotos.slice(0, maxPhotos)) {
            if (now().getTime() - start.getTime() > 10 * 60 * 1000) throw new ImportError("Tiempo máximo de importación alcanzado.");
            try { images.push(await boundedUpload(await downloadImage(url))); }
            catch { warnings.push("No se pudo importar una imagen: formato, tamaño, conexión o subida."); }
          }
          // Revalidar después de las descargas, antes de publicar.
          const finalUser = await UsuarioModel.findById(usuarioId);
          if (!finalUser || finalUser.activo === false) throw new ImportError("El usuario ya no está disponible.");
          const finalAvailability = await getPublicationAvailability(finalUser, { usuarioId, PropiedadModel });
          if (!finalAvailability.puedePublicarAhora || now().getTime() - start.getTime() > 10 * 60 * 1000) throw new ImportError("El plan, cupo o tiempo disponible ha cambiado.");
          if (images.length > getLimiteFotosPlan(getPlanParaFotos(finalUser))) throw new ImportError("El límite de fotos del plan ha cambiado.");
          const data = buildPropiedadCreateData(validation.data, { usuarioId, plan: finalAvailability.plan, imagenes: images.map(image => image.url) });
          const date = now();
          const created = await PropiedadModel.create({ ...data, ...identity(externalId), visiblePublicamente: true, importedAt: date, lastImportedAt: date });
          persisted = true;
          results.push({ externalId, status: "imported", propertyId: String(created._id), warnings });
        } catch (error) {
          if (!persisted) await cleanup(images);
          results.push({ externalId, status: "skipped", reason: error?.code === 11000 ? "duplicate" : "creation_failed",
            errors: [error instanceof ImportError ? error.message : "No se pudo crear el inmueble."], warnings });
        }
      }
      await ImportSourceModel.updateOne({ _id: source._id, importLockToken: lockToken }, { $set: { lastImportedAt: now() } });
      const imported = results.filter(item => item.status === "imported").length;
      return { requested: selected.length, imported, skipped: results.length - imported, results };
    } finally {
      await ImportSourceModel.updateOne({ _id: source._id, importLockToken: lockToken }, { $unset: { importLockToken: "", importLockUntil: "" } });
    }
  };
}
