import express from "express";
import Propiedad from "../models/Propiedad.js";
import Usuario from "../models/Usuario.js";
import ImportSource from "../models/ImportSource.js";
import { createSelectedImporter, feedHash, validateImportProperty, ImportError } from "../utils/import/selectedImport.js";
import { requireAuth } from "../middleware/auth.js";
import { securityRateLimits } from "../utils/security.js";
import {
  DEFAULT_MAX_PREVIEW_PROPERTIES,
  FeedSecurityError,
  maskFeedUrl
} from "../utils/import/feedSecurity.js";
import { FeedFetchError, fetchFeedXml as defaultFetchFeedXml } from "../utils/import/feedFetcher.js";
import { analyzeFeedXml } from "../utils/importers/importerRegistry.js";
import { getPublicationAvailability } from "../utils/propertyCreation.js";
import { getLimiteFotosPlan, planTieneLimiteFotos } from "../utils/planLimits.js";
import { getPlanParaFotos } from "../utils/publishEligibility.js";
import { z } from "../utils/validation.js";
import { createImportBudget, MAX_BATCH_PROPERTIES } from "../utils/import/importBudget.js";

const analyzeSchema = z.object({
  feedUrl: z.string().trim().url().max(2000)
}).strict();

const importSchema = z.object({
  feedUrl: z.string().trim().url().max(2000),
  selectedExternalIds: z.array(z.string().trim().min(1).max(200)).min(1).max(MAX_BATCH_PROPERTIES)
}).strict();

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function normalizarErrorFeed(error) {
  if (error instanceof FeedSecurityError) {
    return { status: 400, error: error.message };
  }
  if (error instanceof FeedFetchError) {
    const status = error.code === "FEED_TIMEOUT" ? 504 : 400;
    return { status, error: error.message };
  }
  if (["XML_INVALID", "XML_EMPTY", "UNSUPPORTED_FEED_TYPE"].includes(error?.code)) {
    return { status: 400, error: error.message };
  }
  return { status: 500, error: "No se pudo analizar el feed XML." };
}

function crearResumenFotos(propiedad, { limiteFotos, fotosIlimitadas }) {
  const fotosDisponibles = Array.isArray(propiedad.fotos) ? propiedad.fotos.length : 0;
  return {
    fotosDisponibles,
    fotosImportables: fotosIlimitadas ? fotosDisponibles : Math.min(fotosDisponibles, limiteFotos || 0)
  };
}

export function createCrmImportRouter({
  fetchFeedXml = defaultFetchFeedXml,
  UsuarioModel = Usuario,
  PropiedadModel = Propiedad,
  ImportSourceModel = ImportSource,
  importSelected,
  importRateLimitMiddleware = securityRateLimits.crmImport,
  importUserRateLimitMiddleware = securityRateLimits.crmImportByUser,
  rateLimitMiddleware = securityRateLimits.crmImportAnalyze,
  userRateLimitMiddleware = securityRateLimits.crmImportAnalyzeByUser
} = {}) {
  const router = express.Router();
  const runImport = importSelected || createSelectedImporter({ UsuarioModel, PropiedadModel, ImportSourceModel });

  router.post("/import", requireAuth, importUserRateLimitMiddleware, importRateLimitMiddleware, async (req, res) => {
    if (req.body && ("ownerId" in req.body || "usuarioId" in req.body)) {
      return res.status(400).json({ error: "No se permite indicar propietario en la importación." });
    }
    const parsed = importSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: "Indica un feed válido y selecciona entre 1 y 5 inmuebles por lote." });
    const budget = createImportBudget();
    try {
      const fetched = await fetchFeedXml(parsed.data.feedUrl, { budget });
      const analyzed = analyzeFeedXml(fetched.xml, { maxProperties: DEFAULT_MAX_PREVIEW_PROPERTIES, maxPhotos: Infinity });
      return res.json(await runImport({ usuarioId: req.user.id, ...parsed.data, analyzed, budget }));
    } catch (error) {
      const response = error instanceof ImportError || error.code === "IMPORT_TIMEOUT" ? { status: error.status, error: error.message } : normalizarErrorFeed(error);
      console.warn("[CRM Import]", { feedUrl: maskFeedUrl(parsed.data.feedUrl), code: error instanceof ImportError ? "IMPORT_REJECTED" : error?.code || "IMPORT_FAILED", status: response.status });
      return res.status(response.status).json({ error: response.error });
    } finally {
      budget.dispose();
    }
  });

  router.post("/analyze", requireAuth, userRateLimitMiddleware, rateLimitMiddleware, async (req, res) => {
    if (req.body && ("ownerId" in req.body || "usuarioId" in req.body)) {
      return res.status(400).json({ error: "No se permite indicar propietario en el análisis." });
    }

    const parsed = analyzeSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Indica una URL de feed válida." });
    }

    const usuarioId = req.user.id;
    const feedUrl = parsed.data.feedUrl;

    try {
      const usuario = await UsuarioModel.findById(usuarioId);
      if (!usuario) return res.status(404).json({ error: "Usuario no encontrado." });

      const disponibilidad = await getPublicationAvailability(usuario, {
        usuarioId,
        PropiedadModel
      });
      const planFotos = getPlanParaFotos(usuario);
      const fotosIlimitadas = !planTieneLimiteFotos(planFotos);
      const limiteFotos = fotosIlimitadas ? null : getLimiteFotosPlan(planFotos);
      const fetched = await fetchFeedXml(feedUrl);
      const analyzed = analyzeFeedXml(fetched.xml, {
        maxProperties: DEFAULT_MAX_PREVIEW_PROPERTIES,
        ...(fotosIlimitadas ? { maxPhotos: Infinity } : {})
      });
      const source = await ImportSourceModel.findOne({ usuarioId, feedUrlHash: feedHash(feedUrl) });
      const imported = source ? await PropiedadModel.find({ usuarioId, importSourceId: source._id, source: "crm" }) : [];
      const duplicateIds = new Set(imported.map(item => item.externalId));
      const referenceCounts = new Map();
      for (const property of analyzed.properties) referenceCounts.set(property.externalId, (referenceCounts.get(property.externalId) || 0) + 1);

      const properties = analyzed.properties.map(propiedad => {
        const resumenFotos = crearResumenFotos(propiedad, {
          limiteFotos,
          fotosIlimitadas
        });

        return {
          previewId: propiedad.previewId,
          externalId: propiedad.externalId || "",
          duplicado: duplicateIds.has(propiedad.externalId),
          titulo: propiedad.titulo || "",
          tipoOperacion: propiedad.tipoOperacion || "",
          precio: propiedad.precio,
          localidad: propiedad.localidad || "",
          fotosDisponibles: resumenFotos.fotosDisponibles,
          fotosImportables: resumenFotos.fotosImportables,
          errors: [...validateImportProperty(propiedad).errors, ...(referenceCounts.get(propiedad.externalId) > 1 ? ["Referencia repetida dentro del feed"] : [])],
          warnings: propiedad.warnings || []
        };
      });

      return res.json({
        feedType: analyzed.feedType,
        total: properties.length,
        plan: disponibilidad.plan,
        puedePublicarAhora: disponibilidad.puedePublicarAhora,
        motivo: disponibilidad.motivo,
        limiteAnuncios: finiteOrNull(disponibilidad.limiteAnuncios),
        anunciosActuales: disponibilidad.anunciosActuales,
        cupoDisponible: finiteOrNull(disponibilidad.cupoDisponible),
        limiteFotos,
        fotosIlimitadas,
        properties
      });
    } catch (error) {
      const safeUrl = maskFeedUrl(feedUrl);
      const response = normalizarErrorFeed(error);
      console.warn("[CRM Import Analyze]", {
        userId: usuarioId,
        feedUrl: safeUrl,
        code: error?.code || error?.name || "ERROR",
        ...(error instanceof FeedFetchError && error.internalCode ? { internalCode: error.internalCode } : {}),
        status: response.status
      });
      return res.status(response.status).json({ error: response.error });
    }
  });

  return router;
}

export default createCrmImportRouter();
