#!/usr/bin/env node
import { evaluarExpiracionPlanManual } from "../utils/manualPlanExpirations.js";

const now = new Date("2026-08-05T12:00:00.000Z");

const casos = [
  {
    nombre: "vip manual vencido",
    usuario: { plan: "vip", planActivo: true, planFechaFin: "2026-05-10T00:00:00.000Z" }
  },
  {
    nombre: "vip futuro",
    usuario: { plan: "vip", planActivo: true, planFechaFin: "2026-09-10T00:00:00.000Z" }
  },
  {
    nombre: "plan con Stripe",
    usuario: { plan: "basico", planActivo: true, planFechaFin: "2026-07-07T00:00:00.000Z", stripeSubscriptionId: "sub_mock" }
  },
  {
    nombre: "plan desconocido",
    usuario: { plan: "inventado", planActivo: true, planFechaFin: "2026-07-07T00:00:00.000Z" }
  },
  {
    nombre: "cambio programado vencido",
    usuario: { plan: "agencia_basica", pendingPlan: "basico", pendingPlanChangeAt: "2026-07-04T00:00:00.000Z", pendingPriceId: "price_mock", stripeSubscriptionId: "sub_mock" }
  },
  {
    nombre: "cambio ya aplicado",
    usuario: { plan: "basico", pendingPlan: "basico", pendingPlanChangeAt: "2026-07-04T00:00:00.000Z", pendingPriceId: "price_mock", stripeSubscriptionId: "sub_mock" }
  },
  {
    nombre: "vip_trial excluido",
    usuario: { plan: "vip_trial", planActivo: true, trialEndDate: "2026-07-01T00:00:00.000Z" }
  }
];

const resultados = casos.map(caso => ({
  caso: caso.nombre,
  evaluacionManual: evaluarExpiracionPlanManual(caso.usuario, now),
  pendingPlanVencido: Boolean(
    caso.usuario.pendingPlan &&
    caso.usuario.pendingPriceId &&
    caso.usuario.pendingPlanChangeAt &&
    new Date(caso.usuario.pendingPlanChangeAt) <= now
  ),
  cambioYaAplicado: Boolean(caso.usuario.pendingPlan && caso.usuario.plan === caso.usuario.pendingPlan)
}));

console.log(JSON.stringify({
  dryRun: true,
  tipo: "simulacion_local",
  fuente: "datos simulados",
  auditoriaProduccion: false,
  mongo: false,
  stripe: false,
  now: now.toISOString(),
  resultados
}, null, 2));
