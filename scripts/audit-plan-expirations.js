#!/usr/bin/env node
import "dotenv/config";
import mongoose from "mongoose";
import Usuario from "../models/Usuario.js";

if (process.env.AUDIT_PLAN_EXPIRATIONS !== "true") {
  console.error("AUDIT_PLAN_EXPIRATIONS debe ser exactamente true.");
  process.exit(1);
}

if (!process.env.MONGODB_URI) {
  console.error("Falta MONGODB_URI.");
  process.exit(1);
}

if (process.argv.slice(2).length > 0) {
  console.error("Esta auditoría no acepta opciones de aplicación.");
  process.exit(1);
}

const now = new Date();
const resumen = {
  totalCandidatos: 0,
  porPlan: {},
  conStripe: 0,
  sinStripe: 0,
  vipTrialVencidos: 0,
  vipManualVencidos: 0,
  agenciaProVencidos: 0,
  otrosPlanesVencidosSinStripe: 0,
  planesVencidosConStripe: 0,
  cambiosProgramadosVencidos: 0,
  planesDesconocidosVencidos: 0,
  fechasInvalidas: 0
};

const planesConocidos = new Set([
  "gratis",
  "basico",
  "destacado",
  "starter",
  "pro_agentes",
  "agencia_basica",
  "agencia_pro",
  "vip_trial",
  "vip"
]);

function contarPlan(plan) {
  const key = plan || "sin_plan";
  resumen.porPlan[key] = (resumen.porPlan[key] || 0) + 1;
}

function vencida(fecha) {
  if (!fecha) return false;
  const time = new Date(fecha).getTime();
  if (!Number.isFinite(time)) {
    resumen.fechasInvalidas += 1;
    return false;
  }
  return time <= now.getTime();
}

await mongoose.connect(process.env.MONGODB_URI);

try {
  const usuarios = await Usuario.find(
    {
      $or: [
        { planFechaFin: { $exists: true, $ne: null } },
        { trialEndDate: { $exists: true, $ne: null } },
        { pendingPlanChangeAt: { $exists: true, $ne: null } }
      ]
    },
    {
      plan: 1,
      planFechaFin: 1,
      trialEndDate: 1,
      pendingPlan: 1,
      pendingPlanChangeAt: 1,
      stripeSubscriptionId: 1
    }
  ).lean();

  for (const usuario of usuarios) {
    const plan = usuario.plan || "gratis";
    const tieneStripe = Boolean(usuario.stripeSubscriptionId);
    const planVencido = vencida(usuario.planFechaFin);
    const trialVencido = vencida(usuario.trialEndDate);
    const cambioVencido = vencida(usuario.pendingPlanChangeAt);

    if (!planVencido && !trialVencido && !cambioVencido) continue;

    resumen.totalCandidatos += 1;
    contarPlan(plan);
    if (tieneStripe) resumen.conStripe += 1;
    else resumen.sinStripe += 1;

    if (plan === "vip_trial" && trialVencido) resumen.vipTrialVencidos += 1;
    if (plan === "vip" && planVencido && !tieneStripe) resumen.vipManualVencidos += 1;
    if (plan === "agencia_pro" && planVencido && !tieneStripe) resumen.agenciaProVencidos += 1;
    if (planVencido && tieneStripe) resumen.planesVencidosConStripe += 1;
    if (planVencido && !tieneStripe && !["vip", "agencia_pro", "gratis", "vip_trial"].includes(plan)) {
      resumen.otrosPlanesVencidosSinStripe += 1;
    }
    if (cambioVencido && usuario.pendingPlan) resumen.cambiosProgramadosVencidos += 1;
    if (planVencido && !planesConocidos.has(plan)) resumen.planesDesconocidosVencidos += 1;
  }

  console.log(JSON.stringify({
    auditoria: "plan_expirations",
    soloLectura: true,
    fecha: now.toISOString(),
    resumen
  }, null, 2));
} finally {
  await mongoose.disconnect();
}
