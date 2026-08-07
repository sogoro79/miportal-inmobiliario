import crypto from "node:crypto";
import Usuario from "../models/Usuario.js";
import ProfessionalTrialRedemption from "../models/ProfessionalTrialRedemption.js";
import { getPlanConfig } from "./planLimits.js";
import { aplicarLimitesPlanTrasTrial } from "./trialPlanLimits.js";

export const PROFESSIONAL_PROMO_CAMPAIGN = "professional-60-2026";
export const PROFESSIONAL_PROMO_PUBLIC_KEY = "professional-60";
export const PROFESSIONAL_PROMO_PLAN = "professional_trial_60d";
export const PROFESSIONAL_PROMO_VISIBLE_NAME = "Promoción Profesional 60 días";
export const PROFESSIONAL_PROMO_END_ISO = "2026-10-31T22:59:59.000Z";
export const PROFESSIONAL_PROMO_DURATION_DAYS = 60;
export const PROFESSIONAL_PROMO_DURATION_MS = PROFESSIONAL_PROMO_DURATION_DAYS * 24 * 60 * 60 * 1000;

const DNI_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";
const CIF_CONTROL_LETTERS = "JABCDEFGHI";
const PROFESSIONAL_TYPES = new Set([
  "inmobiliaria",
  "agente_autonomo",
  "otro_profesional_inmobiliario"
]);
const PAID_STRIPE_STATES = new Set(["active", "trialing", "past_due", "unpaid", "incomplete", "paused"]);
const JWT_FALLBACK_HMAC_KEY_VERSION = "jwt_secret_fallback_v1";
const DEDICATED_HMAC_KEY_VERSION = "professional_promo_hmac_v1";

export class ProfessionalPromotionError extends Error {
  constructor(status, code, message = "No es posible activar esta promoción con los datos facilitados.") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function isProfessionalPromotionActive(now = new Date()) {
  return new Date(now).getTime() <= new Date(PROFESSIONAL_PROMO_END_ISO).getTime();
}

export function calculateProfessionalPromotionEndsAt(activatedAt = new Date()) {
  return new Date(new Date(activatedAt).getTime() + PROFESSIONAL_PROMO_DURATION_MS);
}

function normalizeBasicIdentifier(value = "") {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[\s._-]+/g, "")
    .trim();
}

function dniLetterForNumber(value) {
  return DNI_LETTERS[Number(value) % 23];
}

function normalizeNieForControl(value) {
  return value.replace(/^X/, "0").replace(/^Y/, "1").replace(/^Z/, "2");
}

function validateCifControl(value) {
  const first = value[0];
  const body = value.slice(1, 8);
  const control = value[8];
  let sum = 0;

  for (let index = 0; index < body.length; index += 1) {
    const digit = Number(body[index]);
    if (index % 2 === 0) {
      const doubled = digit * 2;
      sum += Math.floor(doubled / 10) + (doubled % 10);
    } else {
      sum += digit;
    }
  }

  const controlDigit = (10 - (sum % 10)) % 10;
  const expectedDigit = String(controlDigit);
  const expectedLetter = CIF_CONTROL_LETTERS[controlDigit];
  if ("ABEH".includes(first)) return control === expectedDigit;
  if ("KPQS".includes(first)) return control === expectedLetter;
  return control === expectedDigit || control === expectedLetter;
}

export function normalizeSpanishIdentityDocument(value = "") {
  const normalized = normalizeBasicIdentifier(value);
  if (/^\d{8}[A-Z]$/.test(normalized)) {
    const digits = normalized.slice(0, 8);
    if (normalized[8] !== dniLetterForNumber(digits)) {
      return { ok: false, reason: "invalid_control" };
    }
    return { ok: true, type: "dni", normalized };
  }

  if (/^[XYZ]\d{7}[A-Z]$/.test(normalized)) {
    const controlValue = normalizeNieForControl(normalized).slice(0, 8);
    if (normalized[8] !== dniLetterForNumber(controlValue)) {
      return { ok: false, reason: "invalid_control" };
    }
    return { ok: true, type: "nie", normalized };
  }

  if (/^[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J]$/.test(normalized)) {
    if (!validateCifControl(normalized)) {
      return { ok: false, reason: "invalid_control" };
    }
    return { ok: true, type: "nif", normalized };
  }

  return { ok: false, reason: "invalid_format" };
}

export function normalizeSpanishMobile(value = "") {
  let normalized = String(value || "").trim();
  normalized = normalized.replace(/[()\s.-]+/g, "");
  normalized = normalized.replace(/^00/, "+");
  if (/^34[67]\d{8}$/.test(normalized)) normalized = `+${normalized}`;
  if (/^[67]\d{8}$/.test(normalized)) normalized = `+34${normalized}`;
  if (!/^\+34[67]\d{8}$/.test(normalized)) {
    return { ok: false, reason: "invalid_mobile" };
  }
  return { ok: true, normalized };
}

export function getProfessionalPromotionHmacConfig({ secret, keyVersion } = {}) {
  const hasDedicatedSecret = Boolean(process.env.PROFESSIONAL_PROMO_HMAC_SECRET);
  const effectiveSecret = secret || process.env.PROFESSIONAL_PROMO_HMAC_SECRET || process.env.JWT_SECRET;
  const effectiveKeyVersion = keyVersion ||
    process.env.PROFESSIONAL_PROMO_HMAC_KEY_VERSION ||
    (hasDedicatedSecret ? DEDICATED_HMAC_KEY_VERSION : JWT_FALLBACK_HMAC_KEY_VERSION);

  if (!effectiveSecret || String(effectiveSecret).length < 8) {
    throw new ProfessionalPromotionError(500, "hash_secret_missing", "Configuración de promoción incompleta.");
  }
  return {
    secret: effectiveSecret,
    keyVersion: effectiveKeyVersion,
    usingJwtFallback: !secret && !hasDedicatedSecret
  };
}

function legacyHmacSecrets() {
  return String(process.env.PROFESSIONAL_PROMO_HMAC_LEGACY_SECRETS || "")
    .split(",")
    .map(item => item.trim())
    .filter(item => item.length >= 8);
}

export function deterministicPromotionHash(value, {
  secret,
  keyVersion,
  purpose = "professional-promotion"
} = {}) {
  const config = getProfessionalPromotionHmacConfig({ secret, keyVersion });
  return crypto
    .createHmac("sha256", String(config.secret))
    .update(`${purpose}:${value}`)
    .digest("hex");
}

export function getPromotionHashCandidates(value, {
  secret,
  purpose = "professional-promotion"
} = {}) {
  const primary = deterministicPromotionHash(value, { secret, purpose });
  if (secret) return [primary];
  return [
    primary,
    ...legacyHmacSecrets().map(legacySecret => deterministicPromotionHash(value, {
      secret: legacySecret,
      purpose
    }))
  ].filter((hash, index, list) => list.indexOf(hash) === index);
}

export function usuarioTienePlanPagoIncompatible(usuario = {}) {
  const plan = usuario.plan || "gratis";
  const status = String(usuario.subscriptionStatus || "").trim().toLowerCase();
  if (usuario.stripeSubscriptionId && PAID_STRIPE_STATES.has(status)) return true;
  if (getPlanConfig(plan).dependeDeStripe && usuario.planActivo && PAID_STRIPE_STATES.has(status)) return true;
  return false;
}

export function usuarioTienePromocionProfesionalActiva(usuario = {}, now = new Date()) {
  return Boolean(
    usuario.plan === PROFESSIONAL_PROMO_PLAN &&
    usuario.planActivo === true &&
    usuario.professionalPromoStatus === "active" &&
    usuario.professionalPromoEndsAt &&
    new Date(usuario.professionalPromoEndsAt).getTime() > new Date(now).getTime()
  );
}

function sanitizeProfileInput(input = {}, usuario = {}) {
  const nombreComercial = String(input.nombreComercial || usuario.nombreComercial || "").trim();
  const responsableNombre = String(input.responsableNombre || usuario.nombre || "").trim();
  const tipoProfesional = String(input.tipoProfesional || usuario.tipoProfesional || "").trim();
  const aceptaCondiciones = input.aceptaCondiciones === true;
  const identity = normalizeSpanishIdentityDocument(input.documento || usuario.numDoc || "");
  const mobile = normalizeSpanishMobile(input.telefonoMovil || usuario.telefonoMovil || "");

  return {
    nombreComercial,
    responsableNombre,
    tipoProfesional,
    aceptaCondiciones,
    identity,
    mobile
  };
}

export function getProfessionalPromotionPublicStatus({
  usuario,
  input = {},
  identityUsed = false,
  phoneUsed = false,
  userUsed = false,
  now = new Date()
} = {}) {
  const profile = sanitizeProfileInput(input, usuario);
  const datosIncompletos = !profile.nombreComercial ||
    !profile.responsableNombre ||
    !PROFESSIONAL_TYPES.has(profile.tipoProfesional) ||
    !profile.identity.ok ||
    !profile.mobile.ok ||
    !profile.aceptaCondiciones;
  const campaignActive = isProfessionalPromotionActive(now);
  const emailVerified = usuario?.verificado === true;
  const admin = usuario?.role === "admin";
  const paidPlan = usuarioTienePlanPagoIncompatible(usuario);
  const promotionActive = usuarioTienePromocionProfesionalActiva(usuario, now);
  const promotionUsed = Boolean(userUsed || usuario?.professionalPromoCampaign === PROFESSIONAL_PROMO_CAMPAIGN);
  const notEligible = Boolean(identityUsed || phoneUsed || admin);

  return {
    campaign: PROFESSIONAL_PROMO_CAMPAIGN,
    publicKey: PROFESSIONAL_PROMO_PUBLIC_KEY,
    visibleName: PROFESSIONAL_PROMO_VISIBLE_NAME,
    campaignActive,
    eligible: Boolean(campaignActive && emailVerified && !datosIncompletos && !notEligible && !paidPlan && !promotionActive && !promotionUsed),
    datosIncompletos,
    emailNoVerificado: !emailVerified,
    documentoYaUsado: Boolean(identityUsed),
    movilYaUsado: Boolean(phoneUsed),
    promocionYaUtilizada: promotionUsed,
    planPagoIncompatible: paidPlan,
    promocionActiva: promotionActive,
    adminNoElegible: admin,
    endsAt: usuario?.professionalPromoEndsAt || null,
    movilVerificadoRealDisponible: false
  };
}

function duplicateKeyError(error) {
  return error?.code === 11000 || /duplicate key/i.test(String(error?.message || ""));
}

async function runWithRequiredTransaction(mongooseClient, operation) {
  if (!mongooseClient || typeof mongooseClient.startSession !== "function") {
    throw new ProfessionalPromotionError(503, "transaction_required", "No se puede garantizar una activación atómica.");
  }

  let session;
  try {
    session = await mongooseClient.startSession();
  } catch (error) {
    throw new ProfessionalPromotionError(503, "transaction_required", "No se puede garantizar una activación atómica.");
  }

  if (!session || typeof session.withTransaction !== "function") {
    await session?.endSession?.();
    throw new ProfessionalPromotionError(503, "transaction_required", "No se puede garantizar una activación atómica.");
  }

  try {
    let result;
    await session.withTransaction(async () => {
      result = await operation(session);
    });
    return result;
  } finally {
    await session.endSession?.();
  }
}

function withSession(queryOrPromise, session) {
  return queryOrPromise && session && typeof queryOrPromise.session === "function"
    ? queryOrPromise.session(session)
    : queryOrPromise;
}

export async function getProfessionalPromotionStatusForUser({
  userId,
  input = {},
  models = { Usuario, ProfessionalTrialRedemption },
  now = new Date(),
  secret
} = {}) {
  const usuario = await models.Usuario.findById(userId);
  if (!usuario) throw new ProfessionalPromotionError(404, "user_not_found", "Usuario no encontrado.");

  const profile = sanitizeProfileInput(input, usuario);
  let identityUsed = false;
  let phoneUsed = false;

  if (profile.identity.ok) {
    const hashes = getPromotionHashCandidates(profile.identity.normalized, { secret, purpose: "identity" });
    identityUsed = Boolean(await models.ProfessionalTrialRedemption.findOne({
      campaign: PROFESSIONAL_PROMO_CAMPAIGN,
      normalizedIdentityHash: { $in: hashes }
    }));
  }

  if (profile.mobile.ok) {
    const hashes = getPromotionHashCandidates(profile.mobile.normalized, { secret, purpose: "mobile" });
    phoneUsed = Boolean(await models.ProfessionalTrialRedemption.findOne({
      campaign: PROFESSIONAL_PROMO_CAMPAIGN,
      normalizedPhoneHash: { $in: hashes }
    }));
  }

  const userUsed = Boolean(await models.ProfessionalTrialRedemption.findOne({
    campaign: PROFESSIONAL_PROMO_CAMPAIGN,
    userId: usuario._id
  }));

  return getProfessionalPromotionPublicStatus({ usuario, input, identityUsed, phoneUsed, userUsed, now });
}

export async function activateProfessionalPromotion({
  userId,
  input = {},
  models = { Usuario, ProfessionalTrialRedemption },
  mongooseClient = null,
  now = new Date(),
  secret
} = {}) {
  if (!isProfessionalPromotionActive(now)) {
    throw new ProfessionalPromotionError(410, "campaign_expired", "Esta promoción ya ha finalizado.");
  }

  return runWithRequiredTransaction(mongooseClient, async session => {
    const usuario = await withSession(models.Usuario.findById(userId), session);
    if (!usuario) throw new ProfessionalPromotionError(404, "user_not_found", "Usuario no encontrado.");
    if (usuario.role === "admin") throw new ProfessionalPromotionError(403, "admin_not_eligible");
    if (usuario.activo === false) throw new ProfessionalPromotionError(403, "inactive_user");
    if (usuario.verificado !== true) {
      throw new ProfessionalPromotionError(403, "email_not_verified", "Verifica tu correo electrónico antes de activar la promoción.");
    }
    if (usuarioTienePlanPagoIncompatible(usuario)) {
      throw new ProfessionalPromotionError(409, "paid_plan", "Ya tienes un plan activo.");
    }
    if (usuarioTienePromocionProfesionalActiva(usuario, now)) {
      throw new ProfessionalPromotionError(409, "already_active", `Ya disfrutas de la ${PROFESSIONAL_PROMO_VISIBLE_NAME}.`);
    }

    const profile = sanitizeProfileInput(input, usuario);
    if (
      !profile.nombreComercial ||
      !profile.responsableNombre ||
      !PROFESSIONAL_TYPES.has(profile.tipoProfesional) ||
      !profile.identity.ok ||
      !profile.mobile.ok ||
      !profile.aceptaCondiciones
    ) {
      throw new ProfessionalPromotionError(400, "incomplete_data", "Completa tus datos profesionales para continuar.");
    }

    const hmacConfig = getProfessionalPromotionHmacConfig({ secret });
    const normalizedIdentityHash = deterministicPromotionHash(profile.identity.normalized, {
      secret: hmacConfig.secret,
      keyVersion: hmacConfig.keyVersion,
      purpose: "identity"
    });
    const normalizedPhoneHash = deterministicPromotionHash(profile.mobile.normalized, {
      secret: hmacConfig.secret,
      keyVersion: hmacConfig.keyVersion,
      purpose: "mobile"
    });
    const userUsed = await withSession(models.ProfessionalTrialRedemption.findOne({
      campaign: PROFESSIONAL_PROMO_CAMPAIGN,
      userId: usuario._id
    }), session);
    if (userUsed || usuario.professionalPromoCampaign === PROFESSIONAL_PROMO_CAMPAIGN) {
      throw new ProfessionalPromotionError(409, "user_used");
    }

    const activatedAt = new Date(now);
    const endsAt = calculateProfessionalPromotionEndsAt(activatedAt);
    let redemption;

    try {
      const created = await models.ProfessionalTrialRedemption.create([{
        campaign: PROFESSIONAL_PROMO_CAMPAIGN,
        normalizedIdentityHash,
        normalizedPhoneHash,
        hmacKeyVersion: hmacConfig.keyVersion,
        userId: usuario._id,
        activatedAt,
        endsAt,
        status: "active"
      }], session ? { session } : undefined);
      redemption = created[0];
    } catch (error) {
      if (duplicateKeyError(error)) {
        throw new ProfessionalPromotionError(409, "duplicate_redemption");
      }
      throw error;
    }

    usuario.nombreComercial = profile.nombreComercial;
    usuario.nombre = profile.responsableNombre;
    usuario.tipoProfesional = profile.tipoProfesional;
    usuario.tipoDoc = profile.identity.type.toUpperCase();
    usuario.numDoc = profile.identity.normalized;
    usuario.telefonoMovil = profile.mobile.normalized;
    usuario.plan = PROFESSIONAL_PROMO_PLAN;
    usuario.planActivo = true;
    usuario.planFechaFin = endsAt;
    usuario.professionalPromoCampaign = PROFESSIONAL_PROMO_CAMPAIGN;
    usuario.professionalPromoStatus = "active";
    usuario.professionalPromoActivatedAt = activatedAt;
    usuario.professionalPromoEndsAt = endsAt;
    usuario.professionalPromoAcceptedAt = activatedAt;
    usuario.professionalPromoRedemptionId = redemption._id;
    await usuario.save(session ? { session } : undefined);

    return {
      activada: true,
      endsAt,
      plan: PROFESSIONAL_PROMO_PLAN,
      promocion: PROFESSIONAL_PROMO_VISIBLE_NAME
    };
  });
}

export async function expireProfessionalPromotions(now = new Date(), {
  models = { Usuario, ProfessionalTrialRedemption },
  applyLimits = aplicarLimitesPlanTrasTrial,
  logger = console
} = {}) {
  const usuarios = await models.Usuario.find({
    plan: PROFESSIONAL_PROMO_PLAN,
    professionalPromoStatus: "active",
    professionalPromoEndsAt: { $lte: now }
  });

  let expiradas = 0;
  let omitidasPorPago = 0;

  for (const usuario of usuarios) {
    if (usuarioTienePlanPagoIncompatible(usuario)) {
      usuario.professionalPromoStatus = "converted";
      await usuario.save();
      omitidasPorPago += 1;
      continue;
    }

    usuario.plan = "gratis";
    usuario.planActivo = false;
    usuario.planFechaFin = null;
    usuario.professionalPromoStatus = "expired";
    await usuario.save();
    await applyLimits(usuario._id, { planDestino: "gratis", now });
    await models.ProfessionalTrialRedemption.updateOne(
      { campaign: PROFESSIONAL_PROMO_CAMPAIGN, userId: usuario._id, status: "active" },
      { $set: { status: "expired" } }
    );
    expiradas += 1;
  }

  if (expiradas > 0 || omitidasPorPago > 0) {
    logger.info?.("Promoción profesional revisada", { expiradas, omitidasPorPago });
  }

  return { revisadas: usuarios.length, expiradas, omitidasPorPago };
}

export async function getProfessionalPromotionAdminStats({
  models = { Usuario, ProfessionalTrialRedemption },
  now = new Date()
} = {}) {
  const sevenDays = new Date(new Date(now).getTime() + 7 * 24 * 60 * 60 * 1000);
  const [activacionesTotales, activas, expiradas, bloqueadas, proximasAExpirar] = await Promise.all([
    models.ProfessionalTrialRedemption.countDocuments({ campaign: PROFESSIONAL_PROMO_CAMPAIGN }),
    models.ProfessionalTrialRedemption.countDocuments({ campaign: PROFESSIONAL_PROMO_CAMPAIGN, status: "active" }),
    models.ProfessionalTrialRedemption.countDocuments({ campaign: PROFESSIONAL_PROMO_CAMPAIGN, status: "expired" }),
    models.ProfessionalTrialRedemption.countDocuments({ campaign: PROFESSIONAL_PROMO_CAMPAIGN, status: "blocked" }),
    models.ProfessionalTrialRedemption.countDocuments({
      campaign: PROFESSIONAL_PROMO_CAMPAIGN,
      status: "active",
      endsAt: { $lte: sevenDays, $gt: now }
    })
  ]);

  return {
    campaign: PROFESSIONAL_PROMO_CAMPAIGN,
    activacionesTotales,
    activas,
    expiradas,
    bloqueadas,
    proximasAExpirar
  };
}

export function resetProfessionalPromotionSchedulerForTests() {
  scheduledProfessionalPromotionExpiration = null;
  professionalPromotionExpirationRunning = false;
}

let scheduledProfessionalPromotionExpiration = null;
let professionalPromotionExpirationRunning = false;

async function runProfessionalPromotionExpirationOnce({ processor = expireProfessionalPromotions, logger = console } = {}) {
  if (professionalPromotionExpirationRunning) return { skipped: true };
  professionalPromotionExpirationRunning = true;
  try {
    return await processor(new Date(), { logger });
  } catch (error) {
    logger.error?.("Error expirando Promoción Profesional 60 días:", error.message);
    return { error: true };
  } finally {
    professionalPromotionExpirationRunning = false;
  }
}

export function scheduleProfessionalPromotionExpiration({
  intervalMs = 6 * 60 * 60 * 1000,
  setIntervalFn = setInterval,
  processor = expireProfessionalPromotions,
  logger = console
} = {}) {
  if (scheduledProfessionalPromotionExpiration) return scheduledProfessionalPromotionExpiration;
  runProfessionalPromotionExpirationOnce({ processor, logger });
  scheduledProfessionalPromotionExpiration = setIntervalFn(() => {
    runProfessionalPromotionExpirationOnce({ processor, logger });
  }, intervalMs);
  return scheduledProfessionalPromotionExpiration;
}
