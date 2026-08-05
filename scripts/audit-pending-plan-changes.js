#!/usr/bin/env node
import "dotenv/config";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import Usuario from "../models/Usuario.js";
import { getPriceIdByPlan, getPlanByPriceId } from "../utils/stripePlans.js";
import { getStripePlanIds } from "../utils/planLimits.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const COMPATIBLE_STRIPE_STATUSES = new Set(["active", "trialing"]);

function emptySummary({ stripeDisponible }) {
  return {
    auditoria: "pending_plan_changes",
    soloLectura: true,
    fecha: null,
    stripeDisponible,
    totalCandidatos: 0,
    porPlanActual: {},
    porPlanPendiente: {},
    porSubscriptionStatusMongo: {},
    conCancelAtPeriodEnd: 0,
    sinCancelAtPeriodEnd: 0,
    pendingPlanValido: 0,
    pendingPlanInvalido: 0,
    pendingPriceConfigurado: 0,
    pendingPriceNoConfigurado: 0,
    fechaAtrasadaMenosDe7Dias: 0,
    fechaAtrasadaEntre7y30Dias: 0,
    fechaAtrasadaMasDe30Dias: 0,
    stripeConsultadas: 0,
    stripeNoEncontradas: 0,
    stripeErrores: 0,
    stripeEstadoActive: 0,
    stripeEstadoTrialing: 0,
    stripeEstadoIncompatible: 0,
    stripeConUnItem: 0,
    stripeConMultiplesItems: 0,
    stripePriceActualCoincideConPlanActual: 0,
    stripePriceActualYaCoincideConPlanPendiente: 0,
    stripePriceActualNoReconocido: 0,
    candidatosAplicables: 0,
    candidatosYaAplicadosEnStripe: 0,
    candidatosBloqueados: 0,
    inconsistenciasMongoStripe: 0,
    comprobacionStripePendiente: 0,
    casos: []
  };
}

function count(map, key) {
  const safeKey = key || "sin_valor";
  map[safeKey] = (map[safeKey] || 0) + 1;
}

function daysLate(fecha, now) {
  const time = new Date(fecha).getTime();
  if (!Number.isFinite(time)) return null;
  return Math.max(0, Math.floor((now.getTime() - time) / DAY_MS));
}

function addLateBucket(summary, atrasoDias) {
  if (atrasoDias === null) return;
  if (atrasoDias < 7) {
    summary.fechaAtrasadaMenosDe7Dias += 1;
  } else if (atrasoDias <= 30) {
    summary.fechaAtrasadaEntre7y30Dias += 1;
  } else {
    summary.fechaAtrasadaMasDe30Dias += 1;
  }
}

function currentPriceId(subscription) {
  return subscription?.items?.data?.[0]?.price?.id || null;
}

function itemCount(subscription) {
  return subscription?.items?.data?.length || 0;
}

function isMissingStripeSubscriptionError(err) {
  return err?.statusCode === 404 || err?.code === "resource_missing" || err?.type === "StripeInvalidRequestError";
}

function classifyCase({
  pendienteCoherente,
  stripeEncontrada,
  stripeStatus,
  numeroItems,
  priceActualRepresentaPlanActual,
  priceActualYaRepresentaPlanPendiente,
  priceActualReconocido,
  cancelAtPeriodEndCoincide
}) {
  if (!pendienteCoherente) return "inconsistente";
  if (!stripeEncontrada) return "bloqueado";
  if (!COMPATIBLE_STRIPE_STATUSES.has(stripeStatus)) return "bloqueado";
  if (numeroItems !== 1) return "bloqueado";
  if (priceActualYaRepresentaPlanPendiente) return "ya_aplicado_en_stripe";
  if (!cancelAtPeriodEndCoincide) return "inconsistente";
  if (!priceActualReconocido || !priceActualRepresentaPlanActual) return "inconsistente";
  return "aplicable";
}

async function buildStripeClient(stripeSecretKey) {
  if (!stripeSecretKey) return null;
  const { default: Stripe } = await import("stripe");
  return new Stripe(stripeSecretKey);
}

export async function auditPendingPlanChanges({
  now = new Date(),
  UsuarioModel = Usuario,
  stripeClient = null,
  stripeSecretKey = process.env.STRIPE_SECRET_KEY
} = {}) {
  const activeStripeClient = stripeClient || await buildStripeClient(stripeSecretKey);
  const summary = emptySummary({ stripeDisponible: Boolean(activeStripeClient) });
  summary.fecha = now.toISOString();

  const candidatos = await UsuarioModel.find(
    {
      pendingPlan: { $exists: true, $nin: [null, ""] },
      pendingPriceId: { $exists: true, $nin: [null, ""] },
      pendingPlanChangeAt: { $lte: now },
      stripeSubscriptionId: { $exists: true, $nin: [null, ""] }
    },
    {
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
    }
  ).lean();

  summary.totalCandidatos = candidatos.length;
  if (!activeStripeClient) {
    summary.comprobacionStripePendiente = candidatos.length;
  }

  const stripePlanIds = new Set(getStripePlanIds());

  for (const [index, usuario] of candidatos.entries()) {
    const planActual = usuario.plan || "gratis";
    const planPendiente = usuario.pendingPlan || "sin_valor";
    const mongoStatus = usuario.subscriptionStatus || "sin_valor";
    const atrasoDias = daysLate(usuario.pendingPlanChangeAt, now);
    const expectedPendingPriceId = getPriceIdByPlan(usuario.pendingPlan);
    const pendingPlanValido = stripePlanIds.has(usuario.pendingPlan);
    const pendingPriceConfigurado = Boolean(expectedPendingPriceId && usuario.pendingPriceId === expectedPendingPriceId);

    count(summary.porPlanActual, planActual);
    count(summary.porPlanPendiente, planPendiente);
    count(summary.porSubscriptionStatusMongo, mongoStatus);
    addLateBucket(summary, atrasoDias);

    if (usuario.cancelAtPeriodEnd === true) summary.conCancelAtPeriodEnd += 1;
    else summary.sinCancelAtPeriodEnd += 1;

    if (pendingPlanValido) summary.pendingPlanValido += 1;
    else summary.pendingPlanInvalido += 1;

    if (pendingPriceConfigurado) summary.pendingPriceConfigurado += 1;
    else summary.pendingPriceNoConfigurado += 1;

    const caso = {
      caso: index + 1,
      planActual,
      planPendiente,
      atrasoDias,
      subscriptionStatusMongo: mongoStatus,
      cancelAtPeriodEnd: usuario.cancelAtPeriodEnd === true,
      stripeEncontrada: null,
      stripeStatus: null,
      numeroItems: null,
      priceActualRepresentaPlanActual: null,
      priceActualYaRepresentaPlanPendiente: null,
      pendienteCoherente: Boolean(pendingPlanValido && pendingPriceConfigurado),
      clasificacion: "bloqueado"
    };

    if (!activeStripeClient) {
      summary.candidatosBloqueados += 1;
      summary.casos.push(caso);
      continue;
    }

    try {
      summary.stripeConsultadas += 1;
      const subscription = await activeStripeClient.subscriptions.retrieve(usuario.stripeSubscriptionId);
      const status = String(subscription?.status || "sin_valor").toLowerCase();
      const numeroItems = itemCount(subscription);
      const priceId = currentPriceId(subscription);
      const planFromStripePrice = getPlanByPriceId(priceId);
      const stripeCancelAtPeriodEnd = subscription?.cancel_at_period_end === true;
      const cancelAtPeriodEndCoincide = stripeCancelAtPeriodEnd === (usuario.cancelAtPeriodEnd === true);
      const priceActualReconocido = Boolean(planFromStripePrice);
      const priceActualRepresentaPlanActual = planFromStripePrice === planActual;
      const priceActualYaRepresentaPlanPendiente = Boolean(
        expectedPendingPriceId && priceId === expectedPendingPriceId && planFromStripePrice === planPendiente
      );

      caso.stripeEncontrada = true;
      caso.stripeStatus = status;
      caso.numeroItems = numeroItems;
      caso.priceActualRepresentaPlanActual = priceActualRepresentaPlanActual;
      caso.priceActualYaRepresentaPlanPendiente = priceActualYaRepresentaPlanPendiente;

      if (status === "active") summary.stripeEstadoActive += 1;
      else if (status === "trialing") summary.stripeEstadoTrialing += 1;
      else summary.stripeEstadoIncompatible += 1;

      if (numeroItems === 1) summary.stripeConUnItem += 1;
      else if (numeroItems > 1) summary.stripeConMultiplesItems += 1;

      if (priceActualRepresentaPlanActual) summary.stripePriceActualCoincideConPlanActual += 1;
      if (priceActualYaRepresentaPlanPendiente) summary.stripePriceActualYaCoincideConPlanPendiente += 1;
      if (!priceActualReconocido) summary.stripePriceActualNoReconocido += 1;

      caso.clasificacion = classifyCase({
        pendienteCoherente: caso.pendienteCoherente,
        stripeEncontrada: caso.stripeEncontrada,
        stripeStatus: status,
        numeroItems,
        priceActualRepresentaPlanActual,
        priceActualYaRepresentaPlanPendiente,
        priceActualReconocido,
        cancelAtPeriodEndCoincide
      });
    } catch (err) {
      caso.stripeEncontrada = false;
      if (isMissingStripeSubscriptionError(err)) {
        summary.stripeNoEncontradas += 1;
      } else {
        summary.stripeErrores += 1;
      }
      caso.clasificacion = "bloqueado";
    }

    if (caso.clasificacion === "aplicable") summary.candidatosAplicables += 1;
    else if (caso.clasificacion === "ya_aplicado_en_stripe") summary.candidatosYaAplicadosEnStripe += 1;
    else if (caso.clasificacion === "inconsistente") {
      summary.inconsistenciasMongoStripe += 1;
    } else {
      summary.candidatosBloqueados += 1;
    }

    summary.casos.push(caso);
  }

  return summary;
}

export function validateCli({ env = process.env, argv = process.argv } = {}) {
  if (env.AUDIT_PENDING_PLAN_CHANGES !== "true") {
    return { ok: false, code: 1, message: "AUDIT_PENDING_PLAN_CHANGES debe ser exactamente true." };
  }

  if (!env.MONGODB_URI) {
    return { ok: false, code: 1, message: "Falta MONGODB_URI." };
  }

  if (argv.slice(2).length > 0) {
    return { ok: false, code: 1, message: "Esta auditoría no acepta argumentos ni opciones." };
  }

  return { ok: true };
}

export async function runCli({ env = process.env, argv = process.argv, stdout = console.log, stderr = console.error } = {}) {
  const validation = validateCli({ env, argv });
  if (!validation.ok) {
    stderr(validation.message);
    return validation.code;
  }

  await mongoose.connect(env.MONGODB_URI);
  try {
    const summary = await auditPendingPlanChanges({ stripeSecretKey: env.STRIPE_SECRET_KEY });
    stdout(JSON.stringify(summary, null, 2));
    return 0;
  } finally {
    await mongoose.disconnect();
  }
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  const code = await runCli();
  process.exit(code);
}
