import express from "express";
import Propiedad from "../models/Propiedad.js";
import Usuario from "../models/Usuario.js";
import ImportSource from "../models/ImportSource.js";
import ImportSyncRun from "../models/ImportSyncRun.js";
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
import { createSyncSimulator, safeSimulationCode } from "../utils/import/syncSimulation.js";
import { createSyncSourceManager } from "../utils/import/syncSource.js";
import { createSyncEnroller } from "../utils/import/syncEnroll.js";
import { safeRunSummary } from "../utils/import/syncPlan.js";

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
  ImportSyncRunModel = ImportSyncRun,
  simulateSync,
  enrollSync,
  syncSourceManager,
  importSelected,
  importRateLimitMiddleware = securityRateLimits.crmImport,
  importUserRateLimitMiddleware = securityRateLimits.crmImportByUser,
  rateLimitMiddleware = securityRateLimits.crmImportAnalyze,
  userRateLimitMiddleware = securityRateLimits.crmImportAnalyzeByUser
} = {}) {
  const router = express.Router();
  const runImport = importSelected || createSelectedImporter({ UsuarioModel, PropiedadModel, ImportSourceModel });
  const runSimulation = simulateSync || createSyncSimulator({ ImportSourceModel, ImportSyncRunModel, PropiedadModel, fetchXml: fetchFeedXml });
  const runEnrollment = enrollSync || createSyncEnroller({ ImportSourceModel, PropiedadModel, fetchXml: fetchFeedXml });
  const sourceManager = syncSourceManager || createSyncSourceManager({ ImportSourceModel, PropiedadModel });

  function sourceError(res, error) {
    const code = ["SYNC_SOURCE_BUSY", "SYNC_SOURCE_URL_MISMATCH"].includes(error?.code) ? error.code : safeSimulationCode(error);
    console.warn("[CRM Sync Source]", { code });
    const message = code === "SYNC_SOURCE_NOT_CONFIGURED" ? "La configuración de cifrado CRM no está disponible. La importación manual sigue disponible."
      : code === "SYNC_SOURCE_BUSY" ? "Hay una importación o configuración en curso. Espera y vuelve a intentarlo."
      : code === "SYNC_SOURCE_URL_MISMATCH" ? "Esta cuenta ya tiene inmuebles vinculados a otra fuente CRM. En esta fase solo puedes configurar la misma fuente."
      : "No se pudo configurar la fuente CRM. Revisa que la URL sea pública y válida.";
    return res.status(["SYNC_SOURCE_NOT_CONFIGURED", "SYNC_SOURCE_BUSY", "SYNC_SOURCE_URL_MISMATCH"].includes(code) ? 409 : code === "FEED_TIMEOUT" ? 504 : code === "SYNC_RUN_FAILED" ? 500 : 400).json({ code, error: message });
  }

  router.get("/sync/source", requireAuth, async (req, res) => {
    if (Object.keys(req.query || {}).length) return res.status(400).json({ error: "No se permite indicar una fuente o propietario." });
    try { return res.json(await sourceManager.get(req.user.id)); }
    catch (error) { return sourceError(res, error); }
  });

  router.put("/sync/source", requireAuth, userRateLimitMiddleware, rateLimitMiddleware, async (req, res) => {
    const parsed = analyzeSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: "Indica solamente una URL pública de feed válida." });
    try { return res.json(await sourceManager.configure(req.user.id, parsed.data.feedUrl)); }
    catch (error) { return sourceError(res, error); }
  });

  router.post("/sync/simulate", requireAuth, userRateLimitMiddleware, rateLimitMiddleware, async (req, res) => {
    const parsed = z.object({ importSourceId: z.string().regex(/^[a-fA-F0-9]{24}$/) }).strict().safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: "Indica solamente una fuente CRM válida." });
    try {
      return res.json(await runSimulation({ usuarioId: req.user.id, importSourceId: parsed.data.importSourceId }));
    } catch (error) {
      const code = safeSimulationCode(error);
      console.warn("[CRM Sync Simulation]", { code });
      const status = code === "SYNC_SOURCE_NOT_FOUND" ? 404 : ["SYNC_SOURCE_NOT_CONFIGURED", "SYNC_SOURCE_BUSY"].includes(code) ? 409
        : code === "FEED_TIMEOUT" || code === "IMPORT_TIMEOUT" ? 504 : code === "SYNC_RUN_FAILED" ? 500 : 400;
      return res.status(status).json({ code, error: code === "SYNC_SOURCE_NOT_CONFIGURED"
        ? "La fuente CRM necesita una URL cifrada configurada antes de simular. La importación manual sigue disponible."
        : code === "SYNC_SOURCE_BUSY" ? "Hay otra operación CRM en curso. Espera y vuelve a intentarlo."
        : "No se pudo completar la simulación CRM." });
    }
  });

  router.post("/sync/enroll", requireAuth, userRateLimitMiddleware, rateLimitMiddleware, async (req, res) => {
    const parsed = z.object({ importSourceId: z.string().regex(/^[a-fA-F0-9]{24}$/),
      externalIds: z.array(z.string().trim().min(1).max(200)).min(1).max(10)
        .refine(values => new Set(values).size === values.length)
    }).strict().safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: "Indica una fuente y entre 1 y 10 referencias distintas, sin otros datos." });
    try {
      return res.json(await runEnrollment({ usuarioId: req.user.id, ...parsed.data }));
    } catch (error) {
      const code = safeSimulationCode(error);
      const status = code === "SYNC_SOURCE_NOT_FOUND" ? 404 : code === "SYNC_RUN_FAILED" ? 500
        : ["FEED_TIMEOUT", "IMPORT_TIMEOUT"].includes(code) ? 504 : 409;
      console.warn("[CRM Sync Enroll]", { code });
      return res.status(status).json({ code, error: code === "SYNC_SOURCE_BUSY"
        ? "Hay otra operación CRM en curso. Espera y vuelve a intentarlo."
        : code === "SYNC_ENROLL_BASELINE_MISMATCH" ? "El anuncio no coincide con el feed o su vinculación requiere revisión. No se ha modificado su contenido."
        : code === "SYNC_SNAPSHOT_INCOMPLETE" ? "El feed no está completo. No se ha vinculado ningún anuncio."
        : "No se pudo vincular el anuncio. Revisa la fuente y vuelve a simular." });
    }
  });

  router.get("/sync/runs/:id", requireAuth, async (req, res) => {
    if (!/^[a-fA-F0-9]{24}$/.test(req.params.id) || Object.keys(req.query || {}).length) {
      return res.status(400).json({ error: "Indica solamente una simulación válida." });
    }
    try {
      let query = ImportSyncRunModel.findOne({ _id: req.params.id, usuarioId: req.user.id });
      if (query?.select) query = query.select("+plan");
      if (query?.lean) query = query.lean();
      const run = await query;
      if (!run) return res.status(404).json({ error: "Simulación no encontrada." });
      return res.json(safeRunSummary(run));
    } catch {
      return res.status(500).json({ error: "No se pudo consultar la simulación." });
    }
  });

  router.post("/import", requireAuth, importUserRateLimitMiddleware, importRateLimitMiddleware, async (req, res) => {
    if (req.body && ("ownerId" in req.body || "usuarioId" in req.body)) {
      return res.status(400).json({ error: "No se permite indicar propietario en la importación." });
    }
    const parsed = importSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: `Indica un feed válido y selecciona entre 1 y ${MAX_BATCH_PROPERTIES} inmuebles por lote.` });
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
