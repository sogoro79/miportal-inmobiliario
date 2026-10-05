import Usuario from "../models/Usuario.js";
import { enviarCorreo, escapeEmailHtml } from "./email.js";
import { aplicarCaducidadAnunciosGratis } from "./freeListingExpiration.js";
import {
  aplicarLimitesPlanTrasTrial,
  repararUsuariosGratisTrasVipTrial
} from "./trialPlanLimits.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const VIP_TRIAL_DAYS = 30;

export function usuarioTieneStripeActivo(usuario) {
  const status = String(usuario?.subscriptionStatus || "").toLowerCase();
  return Boolean(usuario?.stripeSubscriptionId) && ["active", "trialing"].includes(status);
}

export function crearDatosVipTrial(now = new Date()) {
  const trialStartDate = new Date(now);
  const trialEndDate = new Date(trialStartDate.getTime() + VIP_TRIAL_DAYS * DAY_MS);
  return {
    plan: "vip_trial",
    planActivo: true,
    planFechaFin: null,
    trialAccepted: true,
    trialStartDate,
    trialEndDate,
    trialReminderSent: false,
    trialReminders: {
      sevenDays: false,
      threeDays: false,
      lastDay: false,
      expired: false
    }
  };
}

function ensureTrialReminders(usuario) {
  usuario.trialReminders = {
    sevenDays: usuario.trialReminders?.sevenDays || false,
    threeDays: usuario.trialReminders?.threeDays || false,
    lastDay: usuario.trialReminders?.lastDay || false,
    expired: usuario.trialReminders?.expired || false
  };
}

function getReminderStage(usuario, now) {
  const end = usuario.trialEndDate?.getTime();
  if (!end) return null;

  const diffMs = end - now.getTime();
  if (diffMs <= 0) return "expired";
  if (diffMs <= DAY_MS) return "lastDay";
  if (diffMs <= 3 * DAY_MS) return "threeDays";
  if (diffMs <= 7 * DAY_MS) return "sevenDays";
  return null;
}

function getTrialEmail(usuario, stage) {
  const nombre = escapeEmailHtml(usuario.nombre || "Hola");
  const fechaFin = usuario.trialEndDate
    ? usuario.trialEndDate.toLocaleDateString("es-ES")
    : "";

  const emails = {
    sevenDays: {
      subject: "Tu prueba VIP termina en 7 días",
      html: `<p>${nombre}, tu prueba gratuita VIP de HomeClick24 termina el ${fechaFin}.</p><p>Puedes seguir disfrutando de las ventajas VIP hasta esa fecha.</p>`
    },
    threeDays: {
      subject: "Tu prueba VIP termina en 3 días",
      html: `<p>${nombre}, tu prueba gratuita VIP de HomeClick24 termina en 3 días, el ${fechaFin}.</p><p>Cuando expire, tu cuenta pasará al plan gratis y se aplicarán sus límites de anuncios y fotos.</p>`
    },
    lastDay: {
      subject: "Último día de tu prueba VIP",
      html: `<p>${nombre}, hoy es el último día de tu prueba gratuita VIP de HomeClick24.</p><p>Al finalizar, tu cuenta pasará al plan gratis y se aplicarán sus límites de anuncios y fotos.</p>`
    },
    expired: {
      subject: "Tu prueba VIP ha finalizado",
      html: `<p>${nombre}, tu prueba gratuita VIP de HomeClick24 ha finalizado.</p><p>Tu cuenta ha pasado al plan gratis. Tus anuncios e imágenes no se han borrado y se han aplicado los límites del plan gratis.</p>`
    }
  };

  return emails[stage];
}

async function sendTrialReminder(usuario, stage, mailer = enviarCorreo) {
  ensureTrialReminders(usuario);
  if (!stage || usuario.trialReminders[stage]) return false;
  if (!usuario.email) return false;

  const email = getTrialEmail(usuario, stage);
  const ok = await mailer(usuario.email, email.subject, email.html);
  if (!ok) return false;

  usuario.trialReminders[stage] = true;
  if (stage !== "expired") usuario.trialReminderSent = true;
  await usuario.save();
  return true;
}

export async function expirarVipTrialUsuario(usuario, { mailer = enviarCorreo, enviarEmail = true } = {}) {
  if (!usuario || usuario.plan !== "vip_trial") {
    return { ok: false, reason: "not_vip_trial" };
  }

  if (usuarioTieneStripeActivo(usuario)) {
    return { ok: false, reason: "stripe_active" };
  }

  if (enviarEmail) {
    await sendTrialReminder(usuario, "expired", mailer);
  }

  ensureTrialReminders(usuario);
  usuario.plan = "gratis";
  usuario.planActivo = false;
  usuario.planFechaFin = null;
  usuario.trialAccepted = false;
  usuario.trialReminderSent = true;
  usuario.trialReminders.expired = true;
  usuario.trialLimitsAppliedAt = new Date();
  await usuario.save();

  const limites = await aplicarLimitesPlanTrasTrial(usuario._id, { planDestino: "gratis" });

  return {
    ok: true,
    ...limites
  };
}

async function normalizarVipTrialsSinFechas(now = new Date(), mailer = enviarCorreo) {
  const usuarios = await Usuario.find({
    plan: "vip_trial",
    $or: [
      { trialEndDate: { $exists: false } },
      { trialEndDate: null }
    ]
  });

  let normalizados = 0;
  let expirados = 0;

  for (const usuario of usuarios) {
    if (usuarioTieneStripeActivo(usuario)) continue;

    const base = usuario.trialStartDate || usuario.updatedAt || usuario.createdAt || now;
    const trialStartDate = new Date(base);
    const trialEndDate = new Date(trialStartDate.getTime() + VIP_TRIAL_DAYS * DAY_MS);

    usuario.trialAccepted = true;
    usuario.trialStartDate = usuario.trialStartDate || trialStartDate;
    usuario.trialEndDate = trialEndDate;
    ensureTrialReminders(usuario);

    if (trialEndDate <= now) {
      await usuario.save();
      const resultado = await expirarVipTrialUsuario(usuario, { mailer, enviarEmail: true });
      if (resultado.ok) expirados += 1;
      continue;
    }

    usuario.planActivo = true;
    usuario.trialReminderSent = false;
    usuario.trialReminders.expired = false;
    await usuario.save();
    normalizados += 1;
  }

  return { normalizados, expirados };
}

export async function sendVipTrialReminders(now = new Date(), mailer = enviarCorreo) {
  const usuarios = await Usuario.find({
    trialAccepted: true,
    trialEndDate: { $exists: true, $ne: null },
    $or: [
      { plan: "vip_trial", planActivo: true },
      { "trialReminders.expired": { $ne: true } }
    ]
  });

  let enviados = 0;

  for (const usuario of usuarios) {
    const stage = getReminderStage(usuario, now);
    if (!stage) continue;
    if (stage === "expired" && usuario.plan === "vip_trial") continue;
    if (stage !== "expired" && usuario.plan !== "vip_trial") continue;
    if (await sendTrialReminder(usuario, stage, mailer)) enviados += 1;
  }

  return enviados;
}

export async function expireVipTrials(now = new Date(), mailer = enviarCorreo) {
  const legacy = await normalizarVipTrialsSinFechas(now, mailer);
  await repararUsuariosGratisTrasVipTrial();
  await aplicarCaducidadAnunciosGratis(now);
  const expirados = await Usuario.find({
    plan: "vip_trial",
    trialEndDate: { $lte: now }
  });

  let totalExpirados = legacy.expirados;

  for (const usuario of expirados) {
    const resultado = await expirarVipTrialUsuario(usuario, { mailer, enviarEmail: true });
    if (resultado.ok) totalExpirados += 1;
  }

  return totalExpirados;
}

export function scheduleVipTrialExpiration() {
  const intervalMs = 6 * 60 * 60 * 1000;

  sendVipTrialReminders().catch(err => {
    console.error("❌ Error enviando recordatorios VIP Trial:", err.message);
  });

  expireVipTrials().catch(err => {
    console.error("❌ Error expirando pruebas VIP:", err.message);
  });

  return setInterval(() => {
    sendVipTrialReminders().catch(err => {
      console.error("❌ Error enviando recordatorios VIP Trial:", err.message);
    });

    expireVipTrials().catch(err => {
      console.error("❌ Error expirando pruebas VIP:", err.message);
    });
  }, intervalMs);
}
