#!/usr/bin/env node
import "dotenv/config";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import Usuario from "../models/Usuario.js";
import { envFlagEnabled } from "../utils/envFlags.js";

const REQUIRED_CONFIRMATION = "CLEAR_ONE_DISABLED_TEST_USER";

const USER_PROJECTION = {
  email: 1,
  activo: 1,
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function emptyDryRunReport() {
  return {
    encontrado: false,
    usuarioDesactivado: false,
    planCoincide: false,
    pendingPlanCoincide: false,
    tieneStripeCustomer: false,
    tieneStripeSubscription: false,
    tienePendingChange: false,
    accionPropuesta: "abortar",
    aplicariaCambios: false
  };
}

function safeReportFor(usuario, env, apply) {
  return {
    encontrado: Boolean(usuario),
    usuarioDesactivado: usuario?.activo === false,
    planCoincide: usuario?.plan === env.EXPECTED_CURRENT_PLAN,
    pendingPlanCoincide: usuario?.pendingPlan === env.EXPECTED_PENDING_PLAN,
    tieneStripeCustomer: Boolean(usuario?.stripeCustomerId),
    tieneStripeSubscription: Boolean(usuario?.stripeSubscriptionId),
    tienePendingChange: Boolean(usuario?.pendingPlan || usuario?.pendingPriceId || usuario?.pendingPlanChangeAt || usuario?.pendingPlanLabel),
    accionPropuesta: "abortar",
    aplicariaCambios: false,
    ...(apply ? {
      aplicado: false,
      abortReason: null,
      matchedCount: 0,
      modifiedCount: 0,
      verificacionPosterior: null
    } : {})
  };
}

export function validateCli({ env = process.env, argv = process.argv } = {}) {
  if (!envFlagEnabled("CLEAR_STALE_TEST_SUBSCRIPTION", env)) {
    return { ok: false, code: 1, message: "CLEAR_STALE_TEST_SUBSCRIPTION debe ser exactamente true." };
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
  if (!env.TARGET_EMAIL) {
    return { ok: false, code: 1, message: "Falta TARGET_EMAIL." };
  }
  if (!EMAIL_RE.test(env.TARGET_EMAIL)) {
    return { ok: false, code: 1, message: "TARGET_EMAIL no tiene un formato válido." };
  }
  if (env.EXPECTED_ACTIVE !== "false") {
    return { ok: false, code: 1, message: "EXPECTED_ACTIVE debe ser exactamente false." };
  }
  if (!env.EXPECTED_CURRENT_PLAN) {
    return { ok: false, code: 1, message: "Falta EXPECTED_CURRENT_PLAN." };
  }
  if (!env.EXPECTED_PENDING_PLAN) {
    return { ok: false, code: 1, message: "Falta EXPECTED_PENDING_PLAN." };
  }
  if (argv.slice(2).length > 0) {
    return { ok: false, code: 1, message: "Esta limpieza no acepta argumentos ni opciones." };
  }
  if (envFlagEnabled("APPLY_STALE_TEST_CLEANUP", env) && env.CONFIRM_STALE_TEST_CLEANUP !== REQUIRED_CONFIRMATION) {
    return { ok: false, code: 1, message: "CONFIRM_STALE_TEST_CLEANUP no coincide con la confirmación requerida." };
  }
  return { ok: true };
}

function findTargetById(UsuarioModel, targetUserId) {
  const result = UsuarioModel.find({ _id: targetUserId }, USER_PROJECTION);
  return typeof result.limit === "function" ? result.limit(2).lean() : result.lean();
}

function assertCleanable({ usuarios, env }) {
  if (usuarios.length === 0) return { ok: false, reason: "usuario_no_encontrado" };
  if (usuarios.length !== 1) return { ok: false, reason: "seleccion_no_unica" };

  const usuario = usuarios[0];
  if (usuario.email !== env.TARGET_EMAIL) return { ok: false, reason: "email_no_coincide", usuario };
  if (usuario.activo !== false) return { ok: false, reason: "usuario_no_desactivado", usuario };
  if (usuario.plan !== env.EXPECTED_CURRENT_PLAN) return { ok: false, reason: "plan_actual_no_coincide", usuario };
  if (usuario.pendingPlan !== env.EXPECTED_PENDING_PLAN) return { ok: false, reason: "pending_plan_no_coincide", usuario };
  if (!usuario.stripeSubscriptionId) return { ok: false, reason: "sin_stripe_subscription", usuario };
  return { ok: true, usuario };
}

function conditionalFilter({ env, usuario }) {
  const filter = {
    _id: env.TARGET_USER_ID,
    email: env.TARGET_EMAIL,
    activo: false,
    plan: env.EXPECTED_CURRENT_PLAN,
    pendingPlan: env.EXPECTED_PENDING_PLAN,
    stripeSubscriptionId: usuario.stripeSubscriptionId
  };
  if (usuario.pendingPlanChangeAt) {
    filter.pendingPlanChangeAt = usuario.pendingPlanChangeAt;
  }
  if (usuario.pendingPriceId) {
    filter.pendingPriceId = usuario.pendingPriceId;
  }
  return filter;
}

function cleanupUpdate() {
  return {
    $unset: {
      stripeCustomerId: "",
      stripeSubscriptionId: "",
      subscriptionStatus: "",
      cancelAtPeriodEnd: "",
      subscriptionCancelAt: "",
      pendingPlan: "",
      pendingPriceId: "",
      pendingPlanChangeAt: "",
      pendingPlanLabel: ""
    }
  };
}

function verifyAfter(usuario, env) {
  return {
    sigueDesactivado: usuario?.activo === false,
    planPreservado: usuario?.plan === env.EXPECTED_CURRENT_PLAN,
    stripeFieldsVacios: !usuario?.stripeCustomerId && !usuario?.stripeSubscriptionId && !usuario?.subscriptionStatus && !usuario?.cancelAtPeriodEnd && !usuario?.subscriptionCancelAt,
    pendingFieldsVacios: !usuario?.pendingPlan && !usuario?.pendingPriceId && !usuario?.pendingPlanChangeAt && !usuario?.pendingPlanLabel
  };
}

export async function clearStaleTestSubscription({
  env = process.env,
  UsuarioModel = Usuario,
  apply = false,
  confirm = ""
} = {}) {
  const shouldApply = apply === true;
  const usuarios = await findTargetById(UsuarioModel, env.TARGET_USER_ID);
  const cleanable = assertCleanable({ usuarios, env });
  const usuario = cleanable.usuario || usuarios[0] || null;
  const report = shouldApply ? safeReportFor(usuario, env, true) : (usuario ? safeReportFor(usuario, env, false) : emptyDryRunReport());

  if (!cleanable.ok) {
    if (shouldApply) report.abortReason = cleanable.reason;
    return report;
  }

  report.accionPropuesta = "limpiar_stripe_obsoleto_usuario_test_desactivado";
  report.aplicariaCambios = shouldApply;

  if (!shouldApply) {
    return report;
  }

  if (confirm !== REQUIRED_CONFIRMATION) {
    report.aplicariaCambios = false;
    report.abortReason = "confirmacion_requerida";
    return report;
  }

  const actualizado = await UsuarioModel.findOneAndUpdate(
    conditionalFilter({ env, usuario }),
    cleanupUpdate(),
    { new: true, projection: USER_PROJECTION }
  );

  if (!actualizado) {
    report.abortReason = "actualizacion_condicional_sin_coincidencias";
    return report;
  }

  report.aplicado = true;
  report.modifiedCount = 1;

  const reloaded = await UsuarioModel.find({ _id: env.TARGET_USER_ID }, USER_PROJECTION).limit(2).lean();
  const verificado = reloaded.length === 1 ? reloaded[0] : null;
  report.verificacionPosterior = verifyAfter(verificado, env);

  if (
    !report.verificacionPosterior.sigueDesactivado ||
    !report.verificacionPosterior.planPreservado ||
    !report.verificacionPosterior.stripeFieldsVacios ||
    !report.verificacionPosterior.pendingFieldsVacios
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
    const report = await clearStaleTestSubscription({
      env,
      UsuarioModel,
      apply: envFlagEnabled("APPLY_STALE_TEST_CLEANUP", env),
      confirm: env.CONFIRM_STALE_TEST_CLEANUP
    });
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
