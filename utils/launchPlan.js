import Usuario from "../models/Usuario.js";
import { aplicarLimitesPlanTrasTrial } from "./trialPlanLimits.js";

export const LAUNCH_PLAN_ID = "lanzamiento_2026";
export const LAUNCH_PLAN_NAME = "Plan Lanzamiento";
export const LAUNCH_PLAN_END_ISO = "2027-01-31T22:59:59.000Z";
export const LAUNCH_PLAN_END_LABEL = "31/01/2027";

const ACTIVE_STRIPE_STATES = new Set(["active", "trialing", "past_due", "unpaid", "incomplete", "paused"]);

export class LaunchPlanError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function getLaunchPlanEndsAt() {
  return new Date(LAUNCH_PLAN_END_ISO);
}

export function isLaunchPlanCampaignActive(now = new Date()) {
  return new Date(now).getTime() <= getLaunchPlanEndsAt().getTime();
}

export function usuarioTienePlanLanzamientoActivo(usuario = {}, now = new Date()) {
  return Boolean(
    usuario.plan === LAUNCH_PLAN_ID &&
    usuario.planActivo === true &&
    usuario.planFechaFin &&
    new Date(usuario.planFechaFin).getTime() > new Date(now).getTime()
  );
}

function usuarioTieneEstadoStripePeligroso(usuario = {}) {
  const status = String(usuario.subscriptionStatus || "").trim().toLowerCase();
  return Boolean(usuario.stripeSubscriptionId && ACTIVE_STRIPE_STATES.has(status));
}

function usuarioTieneCambioPendiente(usuario = {}) {
  return Boolean(usuario.pendingPlan || usuario.pendingPriceId || usuario.pendingPlanChangeAt || usuario.pendingPlanLabel);
}

export function getLaunchPlanPublicStatus(usuario = {}, now = new Date()) {
  const campaignActive = isLaunchPlanCampaignActive(now);
  const active = usuarioTienePlanLanzamientoActivo(usuario, now);
  const stripeIncompatible = usuarioTieneEstadoStripePeligroso(usuario);
  const pendingIncompatible = usuarioTieneCambioPendiente(usuario);
  const admin = usuario.role === "admin";
  const paidOrInternalPlan = Boolean(
    usuario.plan &&
    usuario.plan !== "gratis" &&
    usuario.plan !== LAUNCH_PLAN_ID
  );

  return {
    plan: LAUNCH_PLAN_ID,
    nombre: LAUNCH_PLAN_NAME,
    campaignActive,
    active,
    eligible: Boolean(campaignActive && !active && !admin && !stripeIncompatible && !pendingIncompatible && !paidOrInternalPlan),
    endsAt: active ? usuario.planFechaFin : getLaunchPlanEndsAt(),
    endLabel: LAUNCH_PLAN_END_LABEL,
    stripeIncompatible,
    pendingIncompatible,
    paidOrInternalPlan,
    adminNoElegible: admin
  };
}

export async function activateLaunchPlan({
  userId,
  models = { Usuario },
  now = new Date()
} = {}) {
  if (!isLaunchPlanCampaignActive(now)) {
    throw new LaunchPlanError(410, "campaign_expired", "El Plan Lanzamiento ya no está disponible.");
  }

  const usuario = await models.Usuario.findById(userId);
  if (!usuario) throw new LaunchPlanError(404, "user_not_found", "Usuario no encontrado.");

  const status = getLaunchPlanPublicStatus(usuario, now);
  if (status.active) {
    return { activated: false, alreadyActive: true, usuario, status };
  }
  if (!status.eligible) {
    throw new LaunchPlanError(409, "not_eligible", "No es posible activar el Plan Lanzamiento para esta cuenta.");
  }

  usuario.plan = LAUNCH_PLAN_ID;
  usuario.planActivo = true;
  usuario.planFechaFin = getLaunchPlanEndsAt();
  await usuario.save();

  return {
    activated: true,
    alreadyActive: false,
    usuario,
    status: getLaunchPlanPublicStatus(usuario, now)
  };
}

export async function expireLaunchPlans(now = new Date(), {
  UsuarioModel = Usuario,
  applyLimits = aplicarLimitesPlanTrasTrial,
  logger = console
} = {}) {
  const usuarios = await UsuarioModel.find({
    plan: LAUNCH_PLAN_ID,
    planActivo: true,
    planFechaFin: { $exists: true, $ne: null, $lte: now }
  });

  let expirados = 0;
  let omitidos = 0;

  for (const usuario of usuarios) {
    if (usuario.plan !== LAUNCH_PLAN_ID) {
      omitidos += 1;
      continue;
    }

    usuario.plan = "gratis";
    usuario.planActivo = false;
    usuario.planFechaFin = null;
    await usuario.save();
    await applyLimits(usuario._id, { planDestino: "gratis", now });
    expirados += 1;
  }

  if (expirados > 0) {
    logger.info?.("Plan Lanzamiento expirado", { expirados });
  }

  return { revisados: usuarios.length, expirados, omitidos };
}

let scheduledLaunchPlanExpiration = null;
let launchPlanExpirationRunning = false;

async function runLaunchPlanExpirationOnce({ processor = expireLaunchPlans, logger = console } = {}) {
  if (launchPlanExpirationRunning) return { skipped: true };
  launchPlanExpirationRunning = true;
  try {
    return await processor(new Date(), { logger });
  } catch (error) {
    logger.error?.("Error expirando Plan Lanzamiento:", error.message);
    return { error: true };
  } finally {
    launchPlanExpirationRunning = false;
  }
}

export function scheduleLaunchPlanExpiration({
  intervalMs = 6 * 60 * 60 * 1000,
  setIntervalFn = setInterval,
  processor = expireLaunchPlans,
  logger = console
} = {}) {
  if (scheduledLaunchPlanExpiration) return scheduledLaunchPlanExpiration;
  runLaunchPlanExpirationOnce({ processor, logger });
  scheduledLaunchPlanExpiration = setIntervalFn(() => {
    runLaunchPlanExpirationOnce({ processor, logger });
  }, intervalMs);
  return scheduledLaunchPlanExpiration;
}

export function resetLaunchPlanSchedulerForTests() {
  scheduledLaunchPlanExpiration = null;
  launchPlanExpirationRunning = false;
}
