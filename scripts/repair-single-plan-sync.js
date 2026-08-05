#!/usr/bin/env node
import "dotenv/config";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import Usuario from "../models/Usuario.js";
import { envFlagEnabled } from "../utils/envFlags.js";

const REQUIRED_CONFIRMATION = "SYNC_ONE_TEST_USER";
const ALLOWED_TARGET_PLAN = "basico";

const USER_PROJECTION = {
  plan: 1,
  planActivo: 1,
  planFechaFin: 1,
  pendingPlan: 1,
  pendingPlanLabel: 1,
  pendingPriceId: 1,
  pendingPlanChangeAt: 1,
  stripeCustomerId: 1,
  stripeSubscriptionId: 1,
  subscriptionStatus: 1,
  cancelAtPeriodEnd: 1,
  subscriptionCancelAt: 1
};

function dateValue(fecha) {
  const value = new Date(fecha).getTime();
  return Number.isFinite(value) ? value : null;
}

function isPastOrNow(fecha, now) {
  const value = dateValue(fecha);
  return value !== null && value <= now.getTime();
}

function planFechaFinPreservable(fecha, now) {
  const value = dateValue(fecha);
  return value !== null && value > now.getTime();
}

function safePlan(value) {
  return value || "sin_valor";
}

function safeState(usuario = {}, { targetPlan, now }) {
  return {
    encontrado: Boolean(usuario),
    planActual: safePlan(usuario?.plan),
    planPendiente: safePlan(usuario?.pendingPlan),
    planObjetivo: targetPlan || "sin_valor",
    cambioVencido: Boolean(usuario?.pendingPlanChangeAt && isPastOrNow(usuario.pendingPlanChangeAt, now)),
    subscriptionStatus: safePlan(usuario?.subscriptionStatus),
    subscriptionStatusCoincide: usuario?.subscriptionStatus === "active",
    tieneStripeSubscription: Boolean(usuario?.stripeSubscriptionId),
    planFechaFinFuturaPreservable: Boolean(usuario?.planFechaFin && planFechaFinPreservable(usuario.planFechaFin, now))
  };
}

function emptyReport({ now, targetPlan }) {
  return {
    herramienta: "repair_single_plan_sync",
    soloUnUsuario: true,
    dryRun: true,
    fecha: now.toISOString(),
    encontrado: false,
    planActual: "sin_valor",
    planPendiente: "sin_valor",
    planObjetivo: targetPlan || "sin_valor",
    cambioVencido: false,
    subscriptionStatus: "sin_valor",
    subscriptionStatusCoincide: false,
    tieneStripeSubscription: false,
    accionPropuesta: "abortar",
    aplicariaCambios: false,
    aplicado: false,
    abortReason: null,
    matchedCount: 0,
    modifiedCount: 0,
    before: null,
    afterEsperado: null,
    afterVerificado: null
  };
}

function expectedAfter({ usuario, now }) {
  return {
    plan: ALLOWED_TARGET_PLAN,
    planActivo: true,
    subscriptionStatus: "active",
    pendingFieldsVacios: true,
    stripeSubscriptionPreservada: Boolean(usuario?.stripeSubscriptionId),
    stripeCustomerPreservado: Boolean(usuario?.stripeCustomerId),
    cancelAtPeriodEndPreservado: usuario?.cancelAtPeriodEnd === true,
    subscriptionCancelAtPreservado: Boolean(usuario?.subscriptionCancelAt),
    planFechaFinPreservadaSiFutura: Boolean(usuario?.planFechaFin && planFechaFinPreservable(usuario.planFechaFin, now))
  };
}

function summarizeAfter(usuario = {}) {
  return {
    plan: safePlan(usuario.plan),
    planActivo: usuario.planActivo === true,
    subscriptionStatus: safePlan(usuario.subscriptionStatus),
    pendingFieldsVacios: !usuario.pendingPlan && !usuario.pendingPriceId && !usuario.pendingPlanChangeAt && !usuario.pendingPlanLabel,
    stripeSubscriptionPreservada: Boolean(usuario.stripeSubscriptionId)
  };
}

export function validateCli({ env = process.env, argv = process.argv } = {}) {
  if (!envFlagEnabled("REPAIR_SINGLE_PLAN_SYNC", env)) {
    return { ok: false, code: 1, message: "REPAIR_SINGLE_PLAN_SYNC debe ser exactamente true." };
  }
  if (!env.MONGODB_URI) {
    return { ok: false, code: 1, message: "Falta MONGODB_URI." };
  }
  if (!env.TARGET_USER_ID) {
    return { ok: false, code: 1, message: "Falta TARGET_USER_ID." };
  }
  if (!mongoose.Types.ObjectId.isValid(env.TARGET_USER_ID)) {
    return { ok: false, code: 1, message: "TARGET_USER_ID no es un ObjectId válido." };
  }
  if (!env.EXPECTED_CURRENT_PLAN) {
    return { ok: false, code: 1, message: "Falta EXPECTED_CURRENT_PLAN." };
  }
  if (!env.EXPECTED_PENDING_PLAN) {
    return { ok: false, code: 1, message: "Falta EXPECTED_PENDING_PLAN." };
  }
  if (!env.TARGET_PLAN) {
    return { ok: false, code: 1, message: "Falta TARGET_PLAN." };
  }
  if (env.TARGET_PLAN !== ALLOWED_TARGET_PLAN) {
    return { ok: false, code: 1, message: "TARGET_PLAN debe ser basico." };
  }
  if (!env.EXPECTED_SUBSCRIPTION_STATUS) {
    return { ok: false, code: 1, message: "Falta EXPECTED_SUBSCRIPTION_STATUS." };
  }
  if (env.EXPECTED_SUBSCRIPTION_STATUS !== "active") {
    return { ok: false, code: 1, message: "EXPECTED_SUBSCRIPTION_STATUS debe ser active." };
  }
  if (argv.slice(2).length > 0) {
    return { ok: false, code: 1, message: "Esta reparación no acepta argumentos ni opciones." };
  }
  if (envFlagEnabled("APPLY_PLAN_SYNC", env) && env.CONFIRM_PLAN_SYNC !== REQUIRED_CONFIRMATION) {
    return { ok: false, code: 1, message: "CONFIRM_PLAN_SYNC no coincide con la confirmación requerida." };
  }
  return { ok: true };
}

function findByTargetId(UsuarioModel, targetUserId) {
  const query = { _id: targetUserId };
  const result = UsuarioModel.find(query, USER_PROJECTION);
  return typeof result.limit === "function" ? result.limit(2).lean() : result.lean();
}

function assertRepairable({ usuarios, env, now }) {
  if (usuarios.length === 0) return { ok: false, reason: "usuario_no_encontrado" };
  if (usuarios.length !== 1) return { ok: false, reason: "seleccion_no_unica" };

  const usuario = usuarios[0];
  if (usuario.plan !== env.EXPECTED_CURRENT_PLAN) return { ok: false, reason: "plan_actual_no_coincide" };
  if (usuario.pendingPlan !== env.EXPECTED_PENDING_PLAN) return { ok: false, reason: "pending_plan_no_coincide" };
  if (env.EXPECTED_PENDING_PLAN !== env.TARGET_PLAN) return { ok: false, reason: "pending_y_target_no_coinciden" };
  if (usuario.subscriptionStatus !== env.EXPECTED_SUBSCRIPTION_STATUS) return { ok: false, reason: "subscription_status_no_coincide" };
  if (!usuario.stripeSubscriptionId) return { ok: false, reason: "sin_stripe_subscription" };
  if (!usuario.pendingPriceId) return { ok: false, reason: "sin_pending_price" };
  if (!usuario.pendingPlanChangeAt) return { ok: false, reason: "sin_pending_change_at" };
  if (!isPastOrNow(usuario.pendingPlanChangeAt, now)) return { ok: false, reason: "cambio_no_vencido" };
  if (usuario.plan === env.TARGET_PLAN && !usuario.pendingPlan) return { ok: false, reason: "ya_sincronizado" };

  return { ok: true, usuario };
}

function conditionalFilter({ targetUserId, usuario, env }) {
  return {
    _id: targetUserId,
    plan: env.EXPECTED_CURRENT_PLAN,
    pendingPlan: env.EXPECTED_PENDING_PLAN,
    pendingPriceId: usuario.pendingPriceId,
    pendingPlanChangeAt: usuario.pendingPlanChangeAt,
    stripeSubscriptionId: usuario.stripeSubscriptionId,
    subscriptionStatus: env.EXPECTED_SUBSCRIPTION_STATUS
  };
}

function repairUpdate() {
  return {
    $set: {
      plan: ALLOWED_TARGET_PLAN,
      planActivo: true,
      subscriptionStatus: "active"
    },
    $unset: {
      pendingPlan: "",
      pendingPriceId: "",
      pendingPlanChangeAt: "",
      pendingPlanLabel: ""
    }
  };
}

export async function repairSinglePlanSync({
  now = new Date(),
  env = process.env,
  UsuarioModel = Usuario
} = {}) {
  const apply = envFlagEnabled("APPLY_PLAN_SYNC", env);
  const report = emptyReport({ now, targetPlan: env.TARGET_PLAN });
  report.dryRun = !apply;

  const usuarios = await findByTargetId(UsuarioModel, env.TARGET_USER_ID);
  report.matchedCount = usuarios.length;

  const repairable = assertRepairable({ usuarios, env, now });
  const usuario = repairable.usuario || usuarios[0] || null;
  Object.assign(report, safeState(usuario, { targetPlan: env.TARGET_PLAN, now }));
  report.before = usuario ? {
    plan: safePlan(usuario.plan),
    planActivo: usuario.planActivo === true,
    pendingPlan: safePlan(usuario.pendingPlan),
    subscriptionStatus: safePlan(usuario.subscriptionStatus),
    cambioVencido: report.cambioVencido,
    tieneStripeSubscription: report.tieneStripeSubscription
  } : null;
  report.afterEsperado = usuario ? expectedAfter({ usuario, now }) : null;

  if (!repairable.ok) {
    report.abortReason = repairable.reason;
    return report;
  }

  report.accionPropuesta = "sincronizar_mongo_con_stripe_test";
  report.aplicariaCambios = apply;

  if (!apply) {
    return report;
  }

  const actualizado = await UsuarioModel.findOneAndUpdate(
    conditionalFilter({ targetUserId: env.TARGET_USER_ID, usuario, env }),
    repairUpdate(),
    { new: true, projection: USER_PROJECTION }
  );

  if (!actualizado) {
    report.abortReason = "actualizacion_condicional_sin_coincidencias";
    return report;
  }

  report.modifiedCount = 1;
  report.aplicado = true;

  const reloaded = await UsuarioModel.find({ _id: env.TARGET_USER_ID }, USER_PROJECTION).limit(2).lean();
  const verificado = reloaded.length === 1 ? reloaded[0] : null;
  report.afterVerificado = verificado ? summarizeAfter(verificado) : null;

  if (
    !verificado ||
    verificado.plan !== ALLOWED_TARGET_PLAN ||
    verificado.planActivo !== true ||
    verificado.subscriptionStatus !== "active" ||
    verificado.pendingPlan ||
    verificado.pendingPriceId ||
    verificado.pendingPlanChangeAt ||
    verificado.pendingPlanLabel ||
    verificado.stripeSubscriptionId !== usuario.stripeSubscriptionId
  ) {
    report.abortReason = "verificacion_posterior_fallida";
  }

  return report;
}

export async function runCli({
  env = process.env,
  argv = process.argv,
  stdout = console.log,
  stderr = console.error,
  mongooseClient = mongoose,
  UsuarioModel = Usuario
} = {}) {
  const validation = validateCli({ env, argv });
  if (!validation.ok) {
    stderr(validation.message);
    return validation.code;
  }

  await mongooseClient.connect(env.MONGODB_URI);
  try {
    const report = await repairSinglePlanSync({ env, UsuarioModel });
    stdout(JSON.stringify(report, null, 2));
    return report.abortReason ? 1 : 0;
  } finally {
    await mongooseClient.disconnect();
  }
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  const code = await runCli();
  process.exit(code);
}
