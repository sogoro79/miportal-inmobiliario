import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

export const USER_TOKEN_EXPIRES_IN = "7d";
export const ADMIN_TOKEN_EXPIRES_IN = "8h";

export function usuarioSeguro(usuario) {
  return {
    _id: usuario._id,
    nombre: usuario.nombre,
    email: usuario.email,
    plan: usuario.plan || "gratis",
    planActivo: usuario.planActivo || false,
    planFechaFin: usuario.planFechaFin || null,
    trialAccepted: usuario.trialAccepted || false,
    trialStartDate: usuario.trialStartDate || null,
    trialEndDate: usuario.trialEndDate || null,
    trialReminderSent: usuario.trialReminderSent || false,
    stripeCustomerId: usuario.stripeCustomerId || null,
    stripeSubscriptionId: usuario.stripeSubscriptionId || null,
    pendingPlan: usuario.pendingPlan || null,
    pendingPriceId: usuario.pendingPriceId || null,
    pendingPlanChangeAt: usuario.pendingPlanChangeAt || null,
    pendingPlanLabel: usuario.pendingPlanLabel || null
  };
}

function findUserByEmailWithPassword(UsuarioModel, email) {
  return UsuarioModel.findOne({ email }).select("+password role activo verificado");
}

export async function authenticateUserCredentials({ UsuarioModel, email, password }) {
  const usuario = await findUserByEmailWithPassword(UsuarioModel, email);
  if (!usuario) return { ok: false, reason: "invalid_credentials" };
  if (usuario.activo === false) return { ok: false, reason: "inactive" };
  if (!usuario.verificado) return { ok: false, reason: "not_verified" };
  if (!usuario.password) return { ok: false, reason: "missing_password" };

  const ok = await bcrypt.compare(password, usuario.password);
  if (!ok) return { ok: false, reason: "invalid_credentials" };

  return { ok: true, usuario };
}

export async function authenticateAdminCredentials({ UsuarioModel, email, password }) {
  const usuario = await findUserByEmailWithPassword(UsuarioModel, email);
  if (!usuario || usuario.role !== "admin" || usuario.activo === false || !usuario.password) {
    return { ok: false };
  }

  const ok = await bcrypt.compare(password, usuario.password);
  if (!ok) return { ok: false };

  return { ok: true, usuario };
}

export function createUserJwt(usuario, secret = process.env.JWT_SECRET) {
  return jwt.sign(
    { id: usuario._id.toString() },
    secret,
    { expiresIn: USER_TOKEN_EXPIRES_IN }
  );
}

export function createAdminJwt(usuario, secret = process.env.JWT_SECRET) {
  return jwt.sign(
    { id: usuario._id.toString(), role: "admin" },
    secret,
    { expiresIn: ADMIN_TOKEN_EXPIRES_IN }
  );
}
