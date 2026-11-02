import express from "express";
import { requireAdmin } from "../middleware/auth.js";
import { getPublicationAvailability } from "../utils/propertyCreation.js";
import { publicationPlanIsCurrent } from "../utils/publishEligibility.js";
import { maskFeedUrl } from "../utils/import/feedSecurity.js";
import { z } from "../utils/validation.js";

const id = z.string().regex(/^[a-fA-F0-9]{24}$/);
const selection = z.object({
  runId: id,
  externalIds: z.array(z.string().trim().min(1).max(200).refine(v => !/https?:\/\/|[<>&?=\u0000-\u001f]/i.test(v)))
    .min(1).max(10).refine(ids => new Set(ids).size === ids.length)
}).strict();
const authorization = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(true), expressConsentConfirmed: z.literal(true) }).strict(),
  z.object({ enabled: z.literal(false) }).strict()
]);
const denied = () => Object.assign(new Error(), { code: "CRM_DELEGATION_DENIED", status: 403 });
const matchesSource = (source, userId, grant) => source && grant && source.activo === true &&
  source.feedType === "inmoweb" && grant.enabled === true && grant.provider === "inmoweb" &&
  String(grant.usuarioId) === String(userId) && String(source.usuarioId) === String(userId) &&
  String(grant.importSourceId) === String(source._id) && grant.sourceIdentityHash === source.feedUrlHash;

// Internal capability constructed from authenticated server state, never from request JSON.
export function delegatedContext({ actorAdminId, expiresAt, userId, grant, UsuarioModel, GrantModel }) {
  function filters(source) {
    if ((expiresAt != null && Date.now() >= expiresAt) || !matchesSource(source, userId, grant)) throw denied();
    return {
      actor: { _id: actorAdminId, activo: true, role: "admin" },
      target: { _id: userId, activo: true, role: "user" },
      consent: { _id: grant._id, usuarioId: userId, importSourceId: source._id, provider: "inmoweb",
        enabled: true, sourceIdentityHash: source.feedUrlHash }
    };
  }
  return {
    id: grant._id, actorAdminId,
    async assert(source, session) {
      const { actor, target, consent } = filters(source);
      // Sequential: concurrent Mongo operations on one transaction session are unsupported.
      for (const [model, filter] of [[UsuarioModel, actor], [UsuarioModel, target], [GrantModel, consent]]) {
        if (!await model.exists(filter).session(session || null)) throw denied();
      }
    },
    async fence(source, session) {
      if (!session) throw denied();
      const { actor, target, consent } = filters(source);
      const owner = await UsuarioModel.findOne(target).session(session);
      if (!publicationPlanIsCurrent(owner)) {
        throw Object.assign(new Error(), { code: "SYNC_NEW_PLAN_REQUIRED", status: 403 });
      }
      // Serialize demotion/deactivation and revocation with publication. The shared
      // publication pipeline already fences the target user and the CRM source.
      for (const [model, filter, field] of [[UsuarioModel, actor, "crmDelegationFence"], [GrantModel, consent, "fence"]]) {
        const result = await model.updateOne(filter, { $inc: { [field]: 1 } }, { session, timestamps: false });
        if (result.matchedCount !== 1) throw denied();
      }
    }
  };
}

export function createAdminCrmRouter({ UsuarioModel, ImportSourceModel, GrantModel, PropiedadModel,
  ImportSyncRunModel, runSimulation, runNewImport, runReader, simulationLimits, importLimits }) {
  const router = express.Router({ mergeParams: true });
  router.use(requireAdmin);
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!id.safeParse(req.params.userId).success || Object.keys(req.query).length) {
      return res.status(400).json({ error: "Solicitud no válida." });
    }
    next();
  });
  async function load(req, includeInactive = false) {
    const userId = req.params.userId;
    const user = await UsuarioModel.findOne({ _id: userId, role: "user", ...(includeInactive ? {} : { activo: true }) })
      .select("_id nombre plan activo role planActivo planFechaFin trialAccepted trialEndDate professionalPromoStatus professionalPromoEndsAt").lean();
    if (!user || String(user._id) !== userId) throw denied();
    const source = await ImportSourceModel.findOne({ usuarioId: userId, activo: true, feedType: "inmoweb" })
      .select("_id usuarioId feedType activo feedUrlHash feedUrlMasked").lean();
    if (source && (String(source.usuarioId) !== userId || source.feedType !== "inmoweb" || !source.activo)) throw denied();
    const grant = await GrantModel.findOne({ usuarioId: userId, provider: "inmoweb", enabled: true })
      .select("+sourceIdentityHash").lean();
    return { user, source, grant, userId };
  }
  function handle(fn) {
    return async (req, res) => {
      try { await fn(req, res); }
      catch (err) {
        const status = err.code === "CRM_DELEGATION_DENIED" ? 403 : err.code === 11000 ? 409 :
          [400, 403, 404, 409, 429, 503, 504].includes(err.status) ? err.status : 500;
        res.status(status).json({ error: status === 403 ? "Importación delegada no autorizada." :
          "No se pudo completar la operación. Consulta la revisión antes de volver a intentarlo." });
      }
    };
  }
  async function permitted(req) {
    const state = await load(req);
    const { source, userId, grant } = state;
    if (!matchesSource(source, userId, grant)) throw denied();
    const delegation = delegatedContext({ actorAdminId: req.user.id, expiresAt: req.adminTokenExpiresAt,
      userId, grant, UsuarioModel, GrantModel });
    await delegation.assert(source);
    return { ...state, delegation };
  }
  router.get("/source", handle(async (req, res) => {
    const { user, source, userId, grant } = await load(req, true);
    const capacity = await getPublicationAvailability(user, { usuarioId: userId, PropiedadModel });
    res.json({ userId, nombre: user.nombre, sourceConfigured: Boolean(source), provider: source?.feedType || null,
      feedUrlMasked: source ? maskFeedUrl(source.feedUrlMasked) : null,
      active: user.activo === true, grantActive: Boolean(grant), authorized: user.activo === true && Boolean(matchesSource(source, userId, grant)),
      plan: capacity.plan, planActive: publicationPlanIsCurrent(user), available: capacity.cupoDisponible });
  }));
  router.put("/authorization", handle(async (req, res) => {
    const body = authorization.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Confirma la autorización expresa del titular." });
    const { userId, source, grant } = await load(req, !body.data.enabled);
    if (body.data.enabled) {
      if (!source || String(source.usuarioId) !== userId || source.feedType !== "inmoweb" || !source.activo || !source.feedUrlHash) throw denied();
      if (grant && !matchesSource(source, userId, grant)) throw denied();
      if (!grant) {
        await GrantModel.init();
        await GrantModel.create({ usuarioId: userId, importSourceId: source._id, sourceIdentityHash: source.feedUrlHash,
          provider: "inmoweb", enabled: true, grantedBy: req.user.id, grantedAt: new Date() });
      }
    } else if (grant) {
      await GrantModel.updateOne({ _id: grant._id, usuarioId: userId, enabled: true },
        { $set: { enabled: false, revokedBy: req.user.id, revokedAt: new Date() } });
    }
    res.json({ ok: true });
  }));
  router.post("/simulate", ...simulationLimits, handle(async (req, res) => {
    if (Object.keys(req.body || {}).length) return res.status(400).json({ error: "Solicitud no válida." });
    const { userId, source, delegation } = await permitted(req);
    const result = await runSimulation({ usuarioId: userId, importSourceId: source._id, delegation });
    await delegation.assert(source);
    res.json(await runReader.byId(result.runId, userId, delegation.actorAdminId));
  }));
  router.post("/import-new", ...importLimits, handle(async (req, res) => {
    const body = selection.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Selección no válida." });
    const { userId, user, delegation } = await permitted(req);
    if (!publicationPlanIsCurrent(user)) {
      return res.status(403).json({ error: "El plan del titular no permite publicar." });
    }
    // Record pre-claim failures too. Until the pipeline validates the selection,
    // client-supplied references must not be written to logs. Claimed selections
    // and individual outcomes are stored in the run receipt.
    const audit = { action: "import-new", actorAdminId: delegation.actorAdminId, targetUserId: userId,
      runId: body.data.runId, requestedCount: body.data.externalIds.length };
    try {
      const result = await runNewImport({ ...body.data, usuarioId: userId, delegation });
      console.info("[Admin CRM]", { ...audit, at: new Date().toISOString(), outcome: result.newImport.status,
        alreadyImported: result.alreadyImported, counts: result.newImport.counts });
      res.json(result);
    } catch (err) {
      console.warn("[Admin CRM]", { ...audit, at: new Date().toISOString(), outcome: "not-confirmed" });
      throw err;
    }
  }));
  router.get("/runs/:runId", handle(async (req, res) => {
    if (!id.safeParse(req.params.runId).success) return res.status(400).json({ error: "Revisión no válida." });
    const { userId, source, delegation } = await permitted(req);
    const run = await ImportSyncRunModel.findOne({ _id: req.params.runId, usuarioId: userId, importSourceId: source._id,
      feedType: "inmoweb", actorAdminId: delegation.actorAdminId, delegationId: delegation.id }).select("+plan").lean();
    if (!run) return res.status(404).json({ error: "Revisión no encontrada." });
    res.json(await runReader.evaluate(run, userId, source, delegation.actorAdminId));
  }));
  return router;
}
