import Usuario from "../models/Usuario.js";
import { aplicarLimitesPlanTrasTrial } from "./trialPlanLimits.js";
import { getKnownPlanIds } from "./planLimits.js";

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const MANUAL_EXPIRABLE_PLAN_IDS = Object.freeze(["vip", "agencia_pro"]);
let scheduledManualPlanExpirations = null;
let manualPlanExpirationsRunning = false;

function crearResumen() {
  return {
    candidatos: 0,
    aplicados: 0,
    omitidos: 0,
    alertas: 0,
    errores: 0,
    cambios: []
  };
}

function safePlan(plan) {
  return String(plan || "gratis");
}

function hasStripeSubscription(usuario = {}) {
  return Boolean(usuario.stripeSubscriptionId);
}

function fechaVencida(fecha, now) {
  if (!fecha) return false;
  const value = new Date(fecha).getTime();
  return Number.isFinite(value) && value <= now.getTime();
}

export function evaluarExpiracionPlanManual(usuario = {}, now = new Date()) {
  const plan = safePlan(usuario.plan);
  const knownPlans = new Set(getKnownPlanIds());

  if (plan === "gratis") return { accion: "omitir", reason: "gratis" };
  if (plan === "vip_trial") return { accion: "omitir", reason: "vip_trial" };
  if (hasStripeSubscription(usuario)) return { accion: "omitir", reason: "stripe_subscription" };
  if (!knownPlans.has(plan)) return { accion: "alerta", reason: "unknown_plan" };
  if (!MANUAL_EXPIRABLE_PLAN_IDS.includes(plan)) return { accion: "omitir", reason: "manual_plan_not_enabled" };
  if (!usuario.planFechaFin) return { accion: "omitir", reason: "missing_planFechaFin" };
  if (!fechaVencida(usuario.planFechaFin, now)) return { accion: "omitir", reason: "future_planFechaFin" };

  return {
    accion: "expirar",
    reason: "manual_plan_expired",
    fromPlan: plan,
    toPlan: "gratis",
    before: {
      plan,
      planActivo: Boolean(usuario.planActivo),
      planFechaFin: usuario.planFechaFin
    },
    after: {
      plan: "gratis",
      planActivo: false,
      planFechaFin: null
    }
  };
}

async function guardarExpiracionManual(usuario, evaluacion, { applyFreePlanLimits }) {
  usuario.plan = evaluacion.after.plan;
  usuario.planActivo = evaluacion.after.planActivo;
  usuario.planFechaFin = evaluacion.after.planFechaFin;
  await usuario.save();
  if (applyFreePlanLimits) {
    // Puede cambiar visiblePublicamente y fechaExpiracion de propiedades del usuario.
    await applyFreePlanLimits(usuario._id, { planDestino: "gratis" });
  }
}

async function guardarExpiracionManualCondicional(usuario, evaluacion, { UsuarioModel, applyFreePlanLimits }) {
  if (typeof UsuarioModel.findOneAndUpdate === "function") {
    const actualizado = await UsuarioModel.findOneAndUpdate(
      {
        _id: usuario._id,
        plan: evaluacion.fromPlan,
        stripeSubscriptionId: { $in: [null, ""] },
        planFechaFin: usuario.planFechaFin
      },
      { $set: evaluacion.after },
      { new: true }
    );
    if (!actualizado) return false;
    if (applyFreePlanLimits) {
      await applyFreePlanLimits(usuario._id, { planDestino: "gratis" });
    }
    return true;
  }

  await guardarExpiracionManual(usuario, evaluacion, { applyFreePlanLimits });
  return true;
}

export async function processManualPlanExpirations(now = new Date(), {
  UsuarioModel = Usuario,
  applyFreePlanLimits = aplicarLimitesPlanTrasTrial,
  logger = console,
  apply = false,
  usuarios = null
} = {}) {
  const resumen = crearResumen();
  const candidatos = usuarios || await UsuarioModel.find({
    plan: { $in: MANUAL_EXPIRABLE_PLAN_IDS },
    planFechaFin: { $exists: true, $ne: null, $lte: now }
  });
  resumen.candidatos = candidatos.length;

  for (const usuario of candidatos) {
    const evaluacion = evaluarExpiracionPlanManual(usuario, now);

    if (evaluacion.accion === "alerta") {
      resumen.alertas += 1;
      logger.warn?.("Plan manual vencido desconocido omitido", {
        plan: safePlan(usuario.plan),
        reason: evaluacion.reason
      });
      continue;
    }

    if (evaluacion.accion !== "expirar") {
      resumen.omitidos += 1;
      continue;
    }

    resumen.cambios.push({
      before: evaluacion.before,
      after: evaluacion.after
    });

    if (!apply) {
      resumen.omitidos += 1;
      continue;
    }

    try {
      const aplicado = await guardarExpiracionManualCondicional(usuario, evaluacion, { UsuarioModel, applyFreePlanLimits });
      if (aplicado) {
        resumen.aplicados += 1;
      } else {
        resumen.omitidos += 1;
      }
    } catch (err) {
      resumen.errores += 1;
      logger.error("❌ Error expirando plan manual:", {
        plan: evaluacion.fromPlan,
        error: err.message
      });
    }
  }

  return resumen;
}

async function runManualPlanExpirationsOnce({ logger = console, processor = processManualPlanExpirations } = {}) {
  if (manualPlanExpirationsRunning) {
    return { candidatos: 0, aplicados: 0, omitidos: 1, alertas: 0, errores: 0, cambios: [], skipped: "already_running" };
  }

  manualPlanExpirationsRunning = true;
  try {
    const resumen = await processor(new Date(), { apply: true });
    logger.info?.("Expiraciones de planes manuales revisadas", {
      candidatos: resumen.candidatos,
      aplicados: resumen.aplicados,
      omitidos: resumen.omitidos,
      alertas: resumen.alertas,
      errores: resumen.errores
    });
    return resumen;
  } catch (err) {
    logger.error("❌ Error revisando expiraciones de planes manuales:", err.message);
    return { candidatos: 0, aplicados: 0, omitidos: 0, alertas: 0, errores: 1, cambios: [] };
  } finally {
    manualPlanExpirationsRunning = false;
  }
}

export function scheduleManualPlanExpirations({
  intervalMs = DEFAULT_INTERVAL_MS,
  setIntervalFn = setInterval,
  logger = console,
  processor = processManualPlanExpirations
} = {}) {
  if (scheduledManualPlanExpirations) return scheduledManualPlanExpirations;

  runManualPlanExpirationsOnce({ logger, processor });
  scheduledManualPlanExpirations = setIntervalFn(() => {
    runManualPlanExpirationsOnce({ logger, processor });
  }, intervalMs);

  return scheduledManualPlanExpirations;
}

export function resetManualPlanExpirationsSchedulerForTests() {
  scheduledManualPlanExpirations = null;
  manualPlanExpirationsRunning = false;
}
