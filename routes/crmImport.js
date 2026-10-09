import express from "express";
import Propiedad from "../models/Propiedad.js";
import Usuario from "../models/Usuario.js";
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

const analyzeSchema = z.object({
  feedUrl: z.string().trim().url().max(2000)
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
  rateLimitMiddleware = securityRateLimits.crmImportAnalyze
} = {}) {
  const router = express.Router();

  router.post("/analyze", requireAuth, rateLimitMiddleware, async (req, res) => {
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
        maxProperties: DEFAULT_MAX_PREVIEW_PROPERTIES
      });

      const properties = analyzed.properties.map(propiedad => {
        const resumenFotos = crearResumenFotos(propiedad, {
          limiteFotos,
          fotosIlimitadas
        });

        return {
          previewId: propiedad.previewId,
          externalId: propiedad.externalId || "",
          duplicado: false,
          titulo: propiedad.titulo || "",
          tipoOperacion: propiedad.tipoOperacion || "",
          precio: propiedad.precio,
          localidad: propiedad.localidad || "",
          fotosDisponibles: resumenFotos.fotosDisponibles,
          fotosImportables: resumenFotos.fotosImportables,
          errors: propiedad.errors || [],
          warnings: propiedad.warnings || []
        };
      });

      return res.json({
        feedType: analyzed.feedType,
        total: properties.length,
        plan: disponibilidad.plan,
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
        status: response.status
      });
      return res.status(response.status).json({ error: response.error });
    }
  });

  return router;
}

export default createCrmImportRouter();
