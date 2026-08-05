import Stripe from "stripe";
import Usuario from "../models/Usuario.js";
import { getStripePlanIds } from "./planLimits.js";
import { getPriceIdByPlan } from "./stripePlans.js";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
let scheduledPendingPlanChanges = null;
let pendingPlanChangesRunning = false;
let defaultStripeClient = null;

function getDefaultStripeClient() {
  if (!defaultStripeClient) {
    defaultStripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return defaultStripeClient;
}

function fechaFinPeriodo(subscription) {
  const timestamp = subscription.current_period_end || subscription.items?.data?.[0]?.current_period_end;
  return timestamp ? new Date(timestamp * 1000) : null;
}

function crearResumen() {
  return {
    candidatos: 0,
    aplicados: 0,
    omitidos: 0,
    errores: 0
  };
}

function safeUserRef(usuario) {
  return usuario?._id?.toString?.() || "unknown";
}

function isPendingStillDue(usuario, now) {
  return Boolean(
    usuario?.pendingPlan &&
    usuario?.pendingPriceId &&
    usuario?.pendingPlanChangeAt &&
    new Date(usuario.pendingPlanChangeAt) <= now &&
    usuario?.stripeSubscriptionId
  );
}

function isPendingPlanValid(usuario) {
  return getStripePlanIds().includes(usuario?.pendingPlan);
}

function isPendingPriceValid(usuario) {
  const expectedPriceId = getPriceIdByPlan(usuario?.pendingPlan);
  return Boolean(expectedPriceId && usuario?.pendingPriceId && expectedPriceId === usuario.pendingPriceId);
}

function isSubscriptionCompatible(subscription) {
  return ["active", "trialing"].includes(String(subscription?.status || "").toLowerCase());
}

function getSingleSubscriptionItem(subscription) {
  const items = subscription?.items?.data || [];
  return items.length === 1 ? items[0] : null;
}

function pendingAlreadyApplied(usuario) {
  return Boolean(usuario?.pendingPlan && usuario.plan === usuario.pendingPlan);
}

function clearPendingFields(usuario) {
  usuario.pendingPlan = null;
  usuario.pendingPriceId = null;
  usuario.pendingPlanChangeAt = null;
  usuario.pendingPlanLabel = null;
}

async function saveAppliedChange(usuario, subscriptionActualizada, now, UsuarioModel) {
  const fechaFin = fechaFinPeriodo(subscriptionActualizada);
  const update = {
    plan: usuario.pendingPlan,
    planActivo: true,
    pendingPlan: null,
    pendingPriceId: null,
    pendingPlanChangeAt: null,
    pendingPlanLabel: null
  };
  if (fechaFin) update.planFechaFin = fechaFin;

  if (typeof UsuarioModel.findOneAndUpdate === "function") {
    const actualizado = await UsuarioModel.findOneAndUpdate(
      {
        _id: usuario._id,
        pendingPlan: usuario.pendingPlan,
        pendingPriceId: usuario.pendingPriceId,
        pendingPlanChangeAt: usuario.pendingPlanChangeAt,
        stripeSubscriptionId: usuario.stripeSubscriptionId
      },
      { $set: update },
      { new: true }
    );
    return Boolean(actualizado);
  }

  Object.assign(usuario, update);
  await usuario.save();
  return true;
}

async function localPendingStillMatches(UsuarioModel, usuario) {
  const query = {
    _id: usuario._id,
    pendingPlan: usuario.pendingPlan,
    pendingPriceId: usuario.pendingPriceId,
    pendingPlanChangeAt: usuario.pendingPlanChangeAt,
    stripeSubscriptionId: usuario.stripeSubscriptionId
  };

  if (typeof UsuarioModel.exists === "function") {
    return Boolean(await UsuarioModel.exists(query));
  }

  if (typeof UsuarioModel.findOne === "function") {
    return Boolean(await UsuarioModel.findOne(query));
  }

  return true;
}

export async function applyPendingPlanChanges(now = new Date(), {
  UsuarioModel = Usuario,
  stripeClient = null,
  logger = console
} = {}) {
  const resumen = crearResumen();
  const activeStripeClient = stripeClient || getDefaultStripeClient();
  const usuarios = await UsuarioModel.find({
    pendingPlan: { $exists: true, $ne: null },
    pendingPriceId: { $exists: true, $ne: null },
    pendingPlanChangeAt: { $lte: now },
    stripeSubscriptionId: { $exists: true, $ne: null }
  });
  resumen.candidatos = usuarios.length;

  for (const usuario of usuarios) {
    try {
      if (pendingAlreadyApplied(usuario)) {
        clearPendingFields(usuario);
        await usuario.save();
        resumen.omitidos += 1;
        continue;
      }

      if (!isPendingStillDue(usuario, now)) {
        resumen.omitidos += 1;
        continue;
      }

      if (!isPendingPlanValid(usuario) || !isPendingPriceValid(usuario)) {
        resumen.omitidos += 1;
        continue;
      }

      if (!await localPendingStillMatches(UsuarioModel, usuario)) {
        resumen.omitidos += 1;
        continue;
      }

      const subscription = await activeStripeClient.subscriptions.retrieve(usuario.stripeSubscriptionId);
      if (!isSubscriptionCompatible(subscription)) {
        resumen.omitidos += 1;
        continue;
      }

      const item = getSingleSubscriptionItem(subscription);
      if (!item?.id) {
        resumen.omitidos += 1;
        continue;
      }

      const subscriptionActualizada = await activeStripeClient.subscriptions.update(usuario.stripeSubscriptionId, {
        items: [{ id: item.id, price: usuario.pendingPriceId }],
        proration_behavior: "none",
        metadata: {
          userId: safeUserRef(usuario),
          usuarioId: safeUserRef(usuario),
          plan: usuario.pendingPlan,
          priceId: usuario.pendingPriceId
        }
      });

      const aplicado = await saveAppliedChange(usuario, subscriptionActualizada, now, UsuarioModel);
      if (aplicado) {
        resumen.aplicados += 1;
      } else {
        logger.error("❌ Stripe actualizó el cambio programado, pero MongoDB ya no coincidía:", {
          pendingPlan: usuario.pendingPlan,
          error: "local_state_mismatch_after_stripe_update"
        });
        resumen.omitidos += 1;
      }
    } catch (err) {
      resumen.errores += 1;
      logger.error("❌ Error aplicando cambio de plan programado:", {
        pendingPlan: usuario.pendingPlan,
        error: err.message
      });
    }
  }

  return resumen;
}

async function runPendingPlanChangesOnce({ logger = console, processor = applyPendingPlanChanges } = {}) {
  if (pendingPlanChangesRunning) {
    return { candidatos: 0, aplicados: 0, omitidos: 1, errores: 0, skipped: "already_running" };
  }

  pendingPlanChangesRunning = true;
  try {
    const resumen = await processor();
    logger.info?.("Cambios de plan programados revisados", resumen);
    return resumen;
  } catch (err) {
    logger.error("❌ Error revisando cambios de plan programados:", err.message);
    return { candidatos: 0, aplicados: 0, omitidos: 0, errores: 1 };
  } finally {
    pendingPlanChangesRunning = false;
  }
}

export function schedulePendingPlanChanges({
  intervalMs = DEFAULT_INTERVAL_MS,
  setIntervalFn = setInterval,
  logger = console,
  processor = applyPendingPlanChanges
} = {}) {
  if (scheduledPendingPlanChanges) return scheduledPendingPlanChanges;

  runPendingPlanChangesOnce({ logger, processor });

  scheduledPendingPlanChanges = setIntervalFn(() => {
    runPendingPlanChangesOnce({ logger, processor });
  }, intervalMs);
  return scheduledPendingPlanChanges;
}

export function resetPendingPlanChangesSchedulerForTests() {
  scheduledPendingPlanChanges = null;
  pendingPlanChangesRunning = false;
}
