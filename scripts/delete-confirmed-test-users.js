#!/usr/bin/env node
import "dotenv/config";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import Usuario from "../models/Usuario.js";
import Propiedad from "../models/Propiedad.js";
import Conversacion from "../models/Conversacion.js";
import Mensaje from "../models/Mensaje.js";
import Alerta from "../models/Alerta.js";
import Notificacion from "../models/Notificacion.js";

export const AUTHORIZED_TEST_EMAILS = Object.freeze([
  "sonygr@gmail.com",
  "sogoro0705@gmail.com",
  "sogoro79@gmail.com",
  "elpuertoingles@gmail.com",
  "pujesoca@gmail.com"
]);
export const PROTECTED_ADMIN_EMAIL = "sogoro.portal@gmail.com";
export const CONFIRM_DELETE_CONFIRMED_TEST_USERS = "DELETE_FIVE_CONFIRMED_TEST_USERS_AND_TEST_DATA";

const EXACT_TRUE = "true";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USER_PROJECTION = {
  email: 1,
  role: 1,
  activo: 1,
  stripeCustomerId: 1,
  stripeSubscriptionId: 1,
  pendingPlan: 1,
  pendingPriceId: 1,
  pendingPlanChangeAt: 1,
  pendingPlanLabel: 1
};
const CONVERSACION_PROJECTION = {
  compradorId: 1,
  anuncianteId: 1,
  propiedadId: 1
};
const MENSAJE_PROJECTION = {
  conversacionId: 1,
  userId: 1
};

class ConfirmedTestUserDeletionError extends Error {
  constructor(code, message, summary = null) {
    super(message);
    this.name = "ConfirmedTestUserDeletionError";
    this.code = code;
    this.summary = summary;
  }
}

function exactTrue(value) {
  return value === EXACT_TRUE;
}

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function parseEmailList(value) {
  return typeof value === "string"
    ? value.split(",").map(normalizeEmail).filter(Boolean)
    : [];
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== "";
}

function idString(value) {
  return String(value?._id || value || "");
}

function sameId(a, b) {
  return idString(a) === idString(b);
}

function uniqueStrings(values) {
  return [...new Set(values.map(String))];
}

function createEmptySummary() {
  return {
    usuariosEsperados: AUTHORIZED_TEST_EMAILS.length,
    usuariosEncontrados: 0,
    usuariosDesactivados: 0,
    usuariosActivos: 0,
    usuariosConRoleUser: 0,
    usuariosConRoleAdminHistorico: 0,
    propiedadesAsociadas: 0,
    conversacionesAutorizadas: 0,
    conversacionesConAdminProtegido: 0,
    conversacionesConUsuariosExternos: 0,
    mensajesAutorizados: 0,
    alertasPropias: 0,
    notificacionesPropias: 0,
    eliminacionPermitida: false,
    motivosBloqueo: [],
    aplicariaCambios: false
  };
}

function addBlock(summary, reason) {
  if (!summary.motivosBloqueo.includes(reason)) {
    summary.motivosBloqueo.push(reason);
  }
}

export function validateConfirmedTestUsersConfig({
  env = process.env,
  argv = process.argv
} = {}) {
  if (argv.slice(2).length > 0) {
    return { ok: false, code: "argumentos_no_permitidos" };
  }
  if (!exactTrue(env.DELETE_CONFIRMED_TEST_USERS)) {
    return { ok: false, code: "flag_requerida" };
  }
  if (!hasValue(env.MONGODB_URI)) {
    return { ok: false, code: "mongodb_uri_requerida" };
  }
  const protectedAdminEmail = normalizeEmail(env.PROTECTED_ADMIN_EMAIL);
  if (protectedAdminEmail !== PROTECTED_ADMIN_EMAIL) {
    return { ok: false, code: "admin_protegido_invalido" };
  }

  const targetEmails = parseEmailList(env.TARGET_TEST_EMAILS);
  if (targetEmails.length !== AUTHORIZED_TEST_EMAILS.length) {
    return { ok: false, code: "lista_objetivo_invalida" };
  }
  if (targetEmails.some(email => !EMAIL_PATTERN.test(email))) {
    return { ok: false, code: "email_invalido" };
  }
  if (new Set(targetEmails).size !== targetEmails.length) {
    return { ok: false, code: "emails_duplicados" };
  }
  if (targetEmails.includes(PROTECTED_ADMIN_EMAIL)) {
    return { ok: false, code: "admin_protegido_incluido" };
  }

  const expected = new Set(AUTHORIZED_TEST_EMAILS);
  if (targetEmails.some(email => !expected.has(email))) {
    return { ok: false, code: "cuentas_adicionales" };
  }
  if (AUTHORIZED_TEST_EMAILS.some(email => !targetEmails.includes(email))) {
    return { ok: false, code: "cuentas_ausentes" };
  }

  return { ok: true, targetEmails, protectedAdminEmail };
}

function defaultModels() {
  return {
    Usuario,
    Propiedad,
    Conversacion,
    Mensaje,
    Alerta,
    Notificacion
  };
}

function applySession(query, session) {
  return session && query && typeof query.session === "function"
    ? query.session(session)
    : query;
}

async function readLean(query, session) {
  const sessionQuery = applySession(query, session);
  return typeof sessionQuery?.lean === "function" ? sessionQuery.lean() : sessionQuery;
}

async function readCount(query, session) {
  return Number(await applySession(query, session) || 0);
}

async function writeResult(query, session) {
  return applySession(query, session);
}

async function loadDeletionState({
  targetEmails = AUTHORIZED_TEST_EMAILS,
  protectedAdminEmail = PROTECTED_ADMIN_EMAIL,
  models = defaultModels(),
  session = null
} = {}) {
  const usuarios = await readLean(
    models.Usuario.find({ email: { $in: targetEmails } }, USER_PROJECTION),
    session
  );
  const adminProtegido = await readLean(
    models.Usuario.findOne({ email: protectedAdminEmail }, USER_PROJECTION),
    session
  );
  const userIds = uniqueStrings((Array.isArray(usuarios) ? usuarios : []).map(usuario => usuario._id).filter(Boolean));

  const propiedadesAsociadas = userIds.length
    ? await readCount(models.Propiedad.countDocuments({ usuarioId: { $in: userIds } }), session)
    : 0;
  const conversaciones = userIds.length
    ? await readLean(models.Conversacion.find({
      $or: [
        { compradorId: { $in: userIds } },
        { anuncianteId: { $in: userIds } }
      ]
    }, CONVERSACION_PROJECTION), session)
    : [];
  const conversationIds = uniqueStrings((Array.isArray(conversaciones) ? conversaciones : []).map(conversacion => conversacion._id).filter(Boolean));
  const mensajes = conversationIds.length
    ? await readLean(models.Mensaje.find({ conversacionId: { $in: conversationIds } }, MENSAJE_PROJECTION), session)
    : [];
  const alertasPropias = userIds.length
    ? await readCount(models.Alerta.countDocuments({ usuarioId: { $in: userIds } }), session)
    : 0;
  const notificacionesPropias = userIds.length
    ? await readCount(models.Notificacion.countDocuments({ usuarioId: { $in: userIds } }), session)
    : 0;

  return {
    usuarios: Array.isArray(usuarios) ? usuarios : [],
    adminProtegido,
    userIds,
    conversaciones: Array.isArray(conversaciones) ? conversaciones : [],
    conversationIds,
    mensajes: Array.isArray(mensajes) ? mensajes : [],
    propiedadesAsociadas,
    alertasPropias,
    notificacionesPropias
  };
}

function userHasPendingPlanChange(usuario = {}) {
  return hasValue(usuario.pendingPlan) ||
    hasValue(usuario.pendingPriceId) ||
    hasValue(usuario.pendingPlanChangeAt) ||
    hasValue(usuario.pendingPlanLabel);
}

function userHasStripe(usuario = {}) {
  return hasValue(usuario.stripeCustomerId) || hasValue(usuario.stripeSubscriptionId);
}

function isProtectedAdminValid(adminProtegido) {
  return Boolean(adminProtegido && adminProtegido.activo === true && adminProtegido.role === "admin");
}

function summarizeDeletionState(state) {
  const summary = createEmptySummary();
  const usuarios = state.usuarios;
  const userIdSet = new Set(state.userIds);
  const protectedAdminId = idString(state.adminProtegido);

  summary.usuariosEncontrados = usuarios.length;
  summary.usuariosDesactivados = usuarios.filter(usuario => usuario.activo === false).length;
  summary.usuariosActivos = usuarios.filter(usuario => usuario.activo === true).length;
  summary.usuariosConRoleUser = usuarios.filter(usuario => usuario.role === "user").length;
  summary.usuariosConRoleAdminHistorico = usuarios.filter(usuario => usuario.role === "admin").length;
  summary.propiedadesAsociadas = state.propiedadesAsociadas;
  summary.alertasPropias = state.alertasPropias;
  summary.notificacionesPropias = state.notificacionesPropias;

  if (usuarios.length === 0) {
    addBlock(summary, "cuentas_ya_eliminadas");
    return summary;
  }
  if (usuarios.length !== AUTHORIZED_TEST_EMAILS.length) addBlock(summary, "cuentas_no_encontradas");
  if (summary.usuariosActivos > 0) addBlock(summary, "usuarios_activos");
  if (usuarios.some(usuario => normalizeEmail(usuario.email) === PROTECTED_ADMIN_EMAIL)) {
    addBlock(summary, "admin_protegido_en_objetivos");
  }
  if (usuarios.some(userHasStripe)) addBlock(summary, "stripe_local_presente");
  if (usuarios.some(userHasPendingPlanChange)) addBlock(summary, "cambios_pendientes");
  if (usuarios.some(usuario => !["user", "admin"].includes(usuario.role))) addBlock(summary, "role_no_permitido");
  if (state.propiedadesAsociadas > 0) addBlock(summary, "propiedades_presentes");
  if (!isProtectedAdminValid(state.adminProtegido)) addBlock(summary, "admin_protegido_invalido");

  const authorizedConversationIds = new Set();
  for (const conversacion of state.conversaciones) {
    const compradorId = idString(conversacion.compradorId);
    const anuncianteId = idString(conversacion.anuncianteId);
    const compradorEsTest = userIdSet.has(compradorId);
    const anuncianteEsTest = userIdSet.has(anuncianteId);
    const compradorEsAdmin = protectedAdminId && compradorId === protectedAdminId;
    const anuncianteEsAdmin = protectedAdminId && anuncianteId === protectedAdminId;
    const onlyAuthorizedParticipants = (compradorEsTest || compradorEsAdmin) && (anuncianteEsTest || anuncianteEsAdmin);

    if (onlyAuthorizedParticipants) {
      authorizedConversationIds.add(idString(conversacion));
      summary.conversacionesAutorizadas += 1;
      if (compradorEsAdmin || anuncianteEsAdmin) {
        summary.conversacionesConAdminProtegido += 1;
      }
    } else {
      summary.conversacionesConUsuariosExternos += 1;
    }
  }
  if (summary.conversacionesConUsuariosExternos > 0) addBlock(summary, "conversaciones_con_usuarios_externos");

  const conversationsById = new Map(state.conversaciones.map(conversacion => [idString(conversacion), conversacion]));
  for (const mensaje of state.mensajes) {
    const conversationId = idString(mensaje.conversacionId);
    const conversacion = conversationsById.get(conversationId);
    const authorId = idString(mensaje.userId);
    if (!authorizedConversationIds.has(conversationId) || !conversacion) continue;

    const participantIds = new Set([idString(conversacion.compradorId), idString(conversacion.anuncianteId)]);
    if (participantIds.has(authorId)) {
      summary.mensajesAutorizados += 1;
    } else {
      addBlock(summary, "mensajes_con_autor_externo");
    }
  }

  summary.eliminacionPermitida = summary.motivosBloqueo.length === 0;
  return summary;
}

export async function auditConfirmedTestUsersDeletion({
  targetEmails = AUTHORIZED_TEST_EMAILS,
  protectedAdminEmail = PROTECTED_ADMIN_EMAIL,
  models = defaultModels(),
  session = null
} = {}) {
  const state = await loadDeletionState({ targetEmails, protectedAdminEmail, models, session });
  const summary = summarizeDeletionState(state);
  return {
    summary,
    state
  };
}

function assertApplyBarrier({ apply, confirm }) {
  if (apply !== true) return false;
  if (confirm !== CONFIRM_DELETE_CONFIRMED_TEST_USERS) {
    throw new ConfirmedTestUserDeletionError("confirmacion_requerida", "Confirmacion requerida.");
  }
  return true;
}

function userDeleteFilter(usuarios) {
  return {
    $or: usuarios.map(usuario => ({ _id: usuario._id, email: normalizeEmail(usuario.email) })),
    activo: false,
    stripeCustomerId: { $in: [null, ""] },
    stripeSubscriptionId: { $in: [null, ""] },
    pendingPlan: { $in: [null, ""] },
    pendingPriceId: { $in: [null, ""] },
    pendingPlanChangeAt: { $in: [null, ""] },
    pendingPlanLabel: { $in: [null, ""] }
  };
}

async function deleteMany(Model, filter, session) {
  const result = await writeResult(Model.deleteMany(filter), session);
  return Number(result?.deletedCount || 0);
}

function deletionAllowedOrAlreadyDone(summary) {
  return summary.eliminacionPermitida || summary.motivosBloqueo.includes("cuentas_ya_eliminadas");
}

export async function deleteConfirmedTestUsers({
  targetEmails = AUTHORIZED_TEST_EMAILS,
  protectedAdminEmail = PROTECTED_ADMIN_EMAIL,
  models = defaultModels(),
  mongooseClient = mongoose,
  apply = false,
  confirm
} = {}) {
  const wantsApply = assertApplyBarrier({ apply, confirm });
  const dryRun = await auditConfirmedTestUsersDeletion({ targetEmails, protectedAdminEmail, models });

  if (!wantsApply) {
    return dryRun.summary;
  }
  if (dryRun.summary.motivosBloqueo.includes("cuentas_ya_eliminadas")) {
    return {
      ...dryRun.summary,
      aplicoCambios: false,
      verificacionCorrecta: true
    };
  }
  if (!dryRun.summary.eliminacionPermitida) {
    throw new ConfirmedTestUserDeletionError("eliminacion_bloqueada", "Eliminacion bloqueada.", dryRun.summary);
  }
  if (!mongooseClient || typeof mongooseClient.startSession !== "function") {
    throw new ConfirmedTestUserDeletionError("transaccion_no_disponible", "Transaccion no disponible.");
  }

  const session = await mongooseClient.startSession();
  let finalSummary = null;

  try {
    await session.withTransaction(async () => {
      const { summary, state } = await auditConfirmedTestUsersDeletion({
        targetEmails,
        protectedAdminEmail,
        models,
        session
      });
      if (!deletionAllowedOrAlreadyDone(summary)) {
        throw new ConfirmedTestUserDeletionError("eliminacion_bloqueada", "Eliminacion bloqueada.", summary);
      }
      if (summary.motivosBloqueo.includes("cuentas_ya_eliminadas")) {
        finalSummary = {
          ...summary,
          aplicoCambios: false,
          verificacionCorrecta: true
        };
        return;
      }

      const conversationIds = state.conversationIds;
      const userIds = state.userIds;
      const mensajesEliminados = conversationIds.length
        ? await deleteMany(models.Mensaje, { conversacionId: { $in: conversationIds } }, session)
        : 0;
      const conversacionesEliminadas = conversationIds.length
        ? await deleteMany(models.Conversacion, { _id: { $in: conversationIds } }, session)
        : 0;
      const alertasEliminadas = await deleteMany(models.Alerta, { usuarioId: { $in: userIds } }, session);
      const notificacionesEliminadas = await deleteMany(models.Notificacion, { usuarioId: { $in: userIds } }, session);
      const usuariosEliminados = await deleteMany(models.Usuario, userDeleteFilter(state.usuarios), session);

      if (mensajesEliminados !== summary.mensajesAutorizados ||
        conversacionesEliminadas !== summary.conversacionesAutorizadas ||
        alertasEliminadas !== summary.alertasPropias ||
        notificacionesEliminadas !== summary.notificacionesPropias ||
        usuariosEliminados !== AUTHORIZED_TEST_EMAILS.length) {
        throw new ConfirmedTestUserDeletionError("eliminacion_incompleta", "Eliminacion incompleta.");
      }

      const post = await auditConfirmedTestUsersDeletion({
        targetEmails,
        protectedAdminEmail,
        models,
        session
      });
      const conversacionesRestantes = conversationIds.length
        ? await readCount(models.Conversacion.countDocuments({ _id: { $in: conversationIds } }), session)
        : 0;
      const mensajesRestantes = conversationIds.length
        ? await readCount(models.Mensaje.countDocuments({ conversacionId: { $in: conversationIds } }), session)
        : 0;
      const propiedadesRestantes = userIds.length
        ? await readCount(models.Propiedad.countDocuments({ usuarioId: { $in: userIds } }), session)
        : 0;

      const verificacionCorrecta = post.summary.motivosBloqueo.includes("cuentas_ya_eliminadas") &&
        conversacionesRestantes === 0 &&
        mensajesRestantes === 0 &&
        post.summary.alertasPropias === 0 &&
        post.summary.notificacionesPropias === 0 &&
        propiedadesRestantes === 0 &&
        isProtectedAdminValid(post.state.adminProtegido);
      if (!verificacionCorrecta) {
        throw new ConfirmedTestUserDeletionError("verificacion_posterior_fallida", "Verificacion posterior fallida.");
      }

      finalSummary = {
        ...post.summary,
        conversacionesAutorizadas: 0,
        mensajesAutorizados: 0,
        aplicariaCambios: false,
        aplicoCambios: true,
        verificacionCorrecta: true
      };
    });
  } finally {
    await session.endSession();
  }

  return finalSummary;
}

export async function runDeleteConfirmedTestUsersCli({
  env = process.env,
  argv = process.argv,
  stdout = console.log,
  stderr = console.error,
  mongooseClient = mongoose,
  models = defaultModels()
} = {}) {
  const validation = validateConfirmedTestUsersConfig({ env, argv });
  if (!validation.ok) {
    stderr(JSON.stringify({ ok: false, error: validation.code, aplicariaCambios: false }));
    return 1;
  }

  const apply = exactTrue(env.APPLY_CONFIRMED_TEST_USER_DELETION);
  const confirm = env.CONFIRM_CONFIRMED_TEST_USER_DELETION;

  try {
    await mongooseClient.connect(env.MONGODB_URI);
    const summary = await deleteConfirmedTestUsers({
      targetEmails: validation.targetEmails,
      protectedAdminEmail: validation.protectedAdminEmail,
      models,
      mongooseClient,
      apply,
      confirm
    });
    stdout(JSON.stringify(summary, null, 2));
    return 0;
  } catch (error) {
    stderr(JSON.stringify({
      ok: false,
      error: error?.code || "eliminacion_no_completada",
      aplicariaCambios: false
    }));
    return 1;
  } finally {
    await mongooseClient.disconnect().catch(() => {});
  }
}

const isCliExecution = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCliExecution) {
  const code = await runDeleteConfirmedTestUsersCli();
  process.exitCode = code;
}
