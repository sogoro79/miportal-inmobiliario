#!/usr/bin/env node
import "dotenv/config";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import Usuario from "../models/Usuario.js";
import Propiedad from "../models/Propiedad.js";
import { envFlagEnabled } from "../utils/envFlags.js";

const REQUIRED_CONFIRMATION = "CLEAR_ONE_DISABLED_TEST_USER_CHAT";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AMBIGUITY_REASONS = [
  "falta_comprador",
  "falta_anunciante",
  "ambos_participantes_iguales",
  "usuario_objetivo_no_participa",
  "participante_no_encontrado",
  "identificador_invalido",
  "estructura_inconsistente",
  "otra_ambiguedad"
];

function getOrCreateModel(name, schemaDefinition) {
  return mongoose.models[name] || mongoose.model(name, new mongoose.Schema(schemaDefinition, { strict: false }));
}

function defaultModels() {
  return {
    Usuario,
    Propiedad,
    Conversacion: getOrCreateModel("Conversacion", {
      propiedadId: mongoose.Schema.Types.Mixed,
      compradorId: mongoose.Schema.Types.Mixed,
      anuncianteId: mongoose.Schema.Types.Mixed
    }),
    Mensaje: getOrCreateModel("Mensaje", {
      conversacionId: mongoose.Schema.Types.Mixed,
      userId: mongoose.Schema.Types.Mixed,
      texto: String
    })
  };
}

function safeEmptySummary() {
  return {
    conversacionesTotales: 0,
    mensajesTotales: 0,
    conversacionesConOtroUsuarioActivo: 0,
    conversacionesSoloUsuariosDesactivados: 0,
    conversacionesConPropiedadExistente: 0,
    conversacionesConParticipanteTestActivo: 0,
    conversacionesConParticipanteTestDesactivado: 0,
    conversacionesConParticipanteNoTest: 0,
    conversacionesConParticipanteNoResoluble: 0,
    todosLosParticipantesSonTest: true,
    mensajesPropios: 0,
    mensajesDeOtros: 0,
    conversacionesAmbiguas: 0,
    conversacionesAmbiguasPorMotivo: Object.fromEntries(AMBIGUITY_REASONS.map(reason => [reason, 0])),
    relacionesInconsistentes: 0,
    participantesDesconocidos: 0,
    propiedadesDesconocidas: 0,
    mensajesAutorDesconocido: 0,
    mensajesRelacionInconsistente: 0,
    eliminablesConSeguridad: 0,
    bloqueadas: 0,
    motivosBloqueo: [],
    aplicariaCambios: false
  };
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean).map(value => String(value)))];
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function parseKnownTestEmails(value) {
  if (!value) return { ok: false, message: "Falta KNOWN_TEST_EMAILS." };
  const emails = String(value).split(",").map(normalizeEmail).filter(Boolean);
  if (emails.length === 0) return { ok: false, message: "KNOWN_TEST_EMAILS debe incluir emails válidos." };
  if (emails.some(email => !EMAIL_RE.test(email))) {
    return { ok: false, message: "KNOWN_TEST_EMAILS contiene un email inválido." };
  }
  if (new Set(emails).size !== emails.length) {
    return { ok: false, message: "KNOWN_TEST_EMAILS no admite duplicados." };
  }
  return { ok: true, emails };
}

function idString(value) {
  if (!value) return "";
  return String(value);
}

function isValidObjectIdValue(value) {
  const id = idString(value);
  return Boolean(id && mongoose.Types.ObjectId.isValid(id));
}

function dedupeByInternalId(items = []) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const id = idString(item?._id);
    if (!id) {
      result.push(item);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(item);
  }
  return result;
}

function otherParticipantIds(conversaciones, targetUserId) {
  const target = String(targetUserId);
  return uniqueStrings(dedupeByInternalId(conversaciones).flatMap(conv => (
    [conv.compradorId, conv.anuncianteId].map(idString).filter(id => id && id !== target)
  )));
}

function conversationIds(conversaciones) {
  return uniqueStrings(dedupeByInternalId(conversaciones).map(conv => idString(conv._id)));
}

function propertyIds(conversaciones) {
  return uniqueStrings(dedupeByInternalId(conversaciones).map(conv => idString(conv.propiedadId)));
}

async function readLean(queryOrPromise) {
  if (queryOrPromise && typeof queryOrPromise.lean === "function") {
    return queryOrPromise.lean();
  }
  return queryOrPromise;
}

async function findTargetUser(UsuarioModel, env) {
  return readLean(UsuarioModel.findOne({
    _id: env.TARGET_USER_ID,
    email: env.TARGET_EMAIL
  }, {
    activo: 1,
    email: 1
  }));
}

async function findConversaciones(ConversacionModel, targetUserId) {
  return readLean(ConversacionModel.find({
    $or: [{ compradorId: targetUserId }, { anuncianteId: targetUserId }]
  }, {
    propiedadId: 1,
    compradorId: 1,
    anuncianteId: 1
  }));
}

async function findUsuarios(UsuarioModel, ids) {
  if (ids.length === 0) return [];
  return readLean(UsuarioModel.find({
    _id: { $in: ids }
  }, {
    activo: 1,
    email: 1
  }));
}

async function findPropiedades(PropiedadModel, ids) {
  if (ids.length === 0) return [];
  return readLean(PropiedadModel.find({
    _id: { $in: ids }
  }, {
    _id: 1,
    visiblePublicamente: 1
  }));
}

async function findMensajes(MensajeModel, ids) {
  if (ids.length === 0) return [];
  return readLean(MensajeModel.find({
    conversacionId: { $in: ids }
  }, {
    conversacionId: 1,
    userId: 1
  }));
}

function userActiveMap(usuarios) {
  return new Map(usuarios.map(usuario => [idString(usuario._id), usuario.activo]));
}

function userEmailMap(usuarios) {
  return new Map(usuarios.map(usuario => [idString(usuario._id), normalizeEmail(usuario.email)]));
}

function existingPropertySet(propiedades) {
  return new Set(propiedades.map(propiedad => idString(propiedad._id)));
}

async function safeRelatedRead(loader) {
  try {
    return { ok: true, data: await loader() };
  } catch {
    return { ok: false, data: [] };
  }
}

function participantStatus(conv, targetUserId, activeByUser, emailByUser, knownTestEmails, usersQueryOk) {
  const compradorId = idString(conv?.compradorId);
  const anuncianteId = idString(conv?.anuncianteId);
  const conversationId = idString(conv?._id);
  const target = String(targetUserId);
  const motivos = [];
  const ambiguityReasons = [];

  if (!conversationId || !isValidObjectIdValue(conversationId)) {
    motivos.push("relacion_mensaje_inconsistente");
    ambiguityReasons.push("estructura_inconsistente");
  }
  if (!compradorId) {
    motivos.push("participante_faltante");
    ambiguityReasons.push("falta_comprador");
  }
  if (!anuncianteId) {
    motivos.push("participante_faltante");
    ambiguityReasons.push("falta_anunciante");
  }
  if ((compradorId && !isValidObjectIdValue(compradorId)) || (anuncianteId && !isValidObjectIdValue(anuncianteId))) {
    motivos.push("participante_invalido");
    ambiguityReasons.push("identificador_invalido");
  }

  const compradorEsTarget = compradorId === target;
  const anuncianteEsTarget = anuncianteId === target;
  if (compradorId && anuncianteId && compradorId === anuncianteId) {
    motivos.push("participantes_inconsistentes");
    ambiguityReasons.push("ambos_participantes_iguales");
  } else if (!compradorEsTarget && !anuncianteEsTarget) {
    motivos.push("participantes_inconsistentes");
    ambiguityReasons.push("usuario_objetivo_no_participa");
  }

  const otherId = compradorEsTarget ? anuncianteId : compradorId;
  if (!motivos.length && !usersQueryOk) {
    motivos.push("participante_desconocido");
    ambiguityReasons.push("participante_no_encontrado");
  }
  if (!motivos.length && !activeByUser.has(otherId)) {
    motivos.push("participante_desconocido");
    ambiguityReasons.push("participante_no_encontrado");
  }

  const active = activeByUser.get(otherId);
  const email = emailByUser.get(otherId);
  const knownTest = Boolean(email && knownTestEmails.has(email));
  if (!motivos.length && typeof active !== "boolean") {
    motivos.push("estado_participante_desconocido");
    ambiguityReasons.push("otra_ambiguedad");
  }
  return {
    otherActive: active === true,
    otherInactive: active === false,
    knownTest,
    notTest: !motivos.length && !knownTest,
    resolvable: motivos.length === 0,
    ambiguityReasons,
    motivos
  };
}

function propertyStatus(conv, existingProperties, propertiesQueryOk) {
  const propertyId = idString(conv?.propiedadId);
  const motivos = [];

  if (!propertyId) motivos.push("propiedad_faltante");
  if (propertyId && !isValidObjectIdValue(propertyId)) motivos.push("propiedad_invalida");
  if (!motivos.length && !propertiesQueryOk) motivos.push("propiedad_desconocida");

  const exists = !motivos.length && existingProperties.has(propertyId);
  if (exists) motivos.push("propiedad_existente");

  return {
    exists,
    absentConfirmed: !motivos.length && !exists,
    motivos
  };
}

function messagesByConversation(mensajes) {
  const byConversation = new Map();
  for (const mensaje of dedupeByInternalId(mensajes)) {
    const conversationId = idString(mensaje?.conversacionId);
    const list = byConversation.get(conversationId) || [];
    list.push(mensaje);
    byConversation.set(conversationId, list);
  }
  return byConversation;
}

function messageStatus({ conv, mensajes, targetUserId, activeByUser, usersQueryOk, messagesQueryOk }) {
  const status = {
    propios: 0,
    deOtros: 0,
    autorDesconocido: 0,
    relacionInconsistente: 0,
    motivos: []
  };
  const conversationId = idString(conv?._id);
  const participantes = new Set([idString(conv?.compradorId), idString(conv?.anuncianteId)].filter(Boolean));
  const target = String(targetUserId);

  if (!conversationId || !isValidObjectIdValue(conversationId)) {
    status.relacionInconsistente += 1;
    status.motivos.push("relacion_mensaje_inconsistente");
  }
  if (!messagesQueryOk) {
    status.relacionInconsistente += 1;
    status.motivos.push("mensajes_desconocidos");
    return status;
  }

  for (const mensaje of mensajes) {
    const mensajeConversationId = idString(mensaje?.conversacionId);
    const authorId = idString(mensaje?.userId);

    if (mensajeConversationId !== conversationId) {
      status.relacionInconsistente += 1;
      status.motivos.push("relacion_mensaje_inconsistente");
      continue;
    }
    if (!authorId || !isValidObjectIdValue(authorId)) {
      status.autorDesconocido += 1;
      status.motivos.push("autor_mensaje_desconocido");
      continue;
    }
    if (!participantes.has(authorId)) {
      status.relacionInconsistente += 1;
      status.motivos.push("relacion_mensaje_inconsistente");
      continue;
    }
    if (authorId !== target && (!usersQueryOk || !activeByUser.has(authorId))) {
      status.autorDesconocido += 1;
      status.motivos.push("autor_mensaje_desconocido");
      continue;
    }

    if (authorId === target) status.propios += 1;
    else status.deOtros += 1;
  }

  status.motivos = [...new Set(status.motivos)];
  return status;
}

function classify({ targetUserId, conversaciones, mensajes, usuariosRelacionados, propiedades, knownTestEmails, queryStatus = {} }) {
  const summary = safeEmptySummary();
  const uniqueConversations = dedupeByInternalId(conversaciones);
  const uniqueMessages = dedupeByInternalId(mensajes);
  const activeByUser = userActiveMap(usuariosRelacionados);
  const emailByUser = userEmailMap(usuariosRelacionados);
  const existingProperties = existingPropertySet(propiedades);
  const byConversation = messagesByConversation(uniqueMessages);
  const blockingReasons = new Set();
  const usersQueryOk = queryStatus.usuarios !== false;
  const propertiesQueryOk = queryStatus.propiedades !== false;
  const messagesQueryOk = queryStatus.mensajes !== false;

  summary.conversacionesTotales = uniqueConversations.length;
  summary.mensajesTotales = uniqueMessages.length;

  if (!usersQueryOk) blockingReasons.add("participante_desconocido");
  if (!propertiesQueryOk) blockingReasons.add("propiedad_desconocida");
  if (!messagesQueryOk) blockingReasons.add("mensajes_desconocidos");

  for (const conv of uniqueConversations) {
    const participant = participantStatus(conv, targetUserId, activeByUser, emailByUser, knownTestEmails, usersQueryOk);
    const property = propertyStatus(conv, existingProperties, propertiesQueryOk);
    const message = messageStatus({
      conv,
      mensajes: byConversation.get(idString(conv?._id)) || [],
      targetUserId,
      activeByUser,
      usersQueryOk,
      messagesQueryOk
    });
    const motivos = [...participant.motivos, ...property.motivos, ...message.motivos];
    const ambiguous = motivos.length > 0;

    summary.mensajesPropios += message.propios;
    summary.mensajesDeOtros += message.deOtros;
    summary.mensajesAutorDesconocido += message.autorDesconocido;
    summary.mensajesRelacionInconsistente += message.relacionInconsistente;

    if (participant.otherActive) summary.conversacionesConOtroUsuarioActivo += 1;
    if (participant.knownTest && participant.otherActive) summary.conversacionesConParticipanteTestActivo += 1;
    if (participant.knownTest && participant.otherInactive) summary.conversacionesConParticipanteTestDesactivado += 1;
    if (participant.notTest) summary.conversacionesConParticipanteNoTest += 1;
    if (participant.motivos.includes("participante_desconocido")) summary.conversacionesConParticipanteNoResoluble += 1;
    if (property.exists) summary.conversacionesConPropiedadExistente += 1;
    if (participant.knownTest && participant.otherInactive && property.absentConfirmed && !ambiguous) {
      summary.conversacionesSoloUsuariosDesactivados += 1;
    }

    if (participant.motivos.includes("participante_desconocido")) summary.participantesDesconocidos += 1;
    if (property.motivos.includes("propiedad_desconocida")) summary.propiedadesDesconocidas += 1;
    if (ambiguous) {
      summary.conversacionesAmbiguas += 1;
      for (const reason of participant.ambiguityReasons) {
        summary.conversacionesAmbiguasPorMotivo[reason] += 1;
      }
      if (participant.ambiguityReasons.length === 0 && motivos.length > 0) {
        summary.conversacionesAmbiguasPorMotivo.otra_ambiguedad += 1;
      }
    }
    if (ambiguous || participant.notTest || !participant.knownTest || participant.otherActive || property.exists || message.autorDesconocido > 0 || message.relacionInconsistente > 0) {
      summary.bloqueadas += 1;
    } else {
      summary.eliminablesConSeguridad += 1;
    }
    if (!participant.knownTest) summary.todosLosParticipantesSonTest = false;

    for (const motivo of motivos) blockingReasons.add(motivo);
    if (participant.otherActive) blockingReasons.add("otro_usuario_activo");
    if (participant.notTest) blockingReasons.add("participante_no_test");
    if (property.exists) blockingReasons.add("propiedad_existente");
  }

  summary.relacionesInconsistentes = summary.conversacionesAmbiguas + summary.mensajesRelacionInconsistente;
  if (summary.mensajesDeOtros > 0) blockingReasons.add("mensajes_de_otros");
  if (summary.bloqueadas > 0) blockingReasons.add("relaciones_compartidas");
  summary.motivosBloqueo = [...blockingReasons].sort();
  return summary;
}

export function validateCli({ env = process.env, argv = process.argv } = {}) {
  if (!envFlagEnabled("CLEAR_SINGLE_TEST_USER_CHAT", env)) {
    return { ok: false, code: 1, message: "CLEAR_SINGLE_TEST_USER_CHAT debe ser exactamente true." };
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
  const knownTestEmails = parseKnownTestEmails(env.KNOWN_TEST_EMAILS);
  if (!knownTestEmails.ok) {
    return { ok: false, code: 1, message: knownTestEmails.message };
  }
  if (!knownTestEmails.emails.includes(normalizeEmail(env.TARGET_EMAIL))) {
    return { ok: false, code: 1, message: "KNOWN_TEST_EMAILS debe incluir TARGET_EMAIL." };
  }
  if (env.EXPECTED_ACTIVE !== "false") {
    return { ok: false, code: 1, message: "EXPECTED_ACTIVE debe ser exactamente false." };
  }
  if (argv.slice(2).length > 0) {
    return { ok: false, code: 1, message: "Esta auditoría no acepta argumentos ni opciones." };
  }
  if (envFlagEnabled("APPLY_SINGLE_TEST_USER_CHAT", env) && env.CONFIRM_SINGLE_TEST_USER_CHAT !== REQUIRED_CONFIRMATION) {
    return { ok: false, code: 1, message: "CONFIRM_SINGLE_TEST_USER_CHAT no coincide con la confirmación requerida." };
  }
  return { ok: true };
}

export async function auditSingleTestUserChatData({
  env = process.env,
  models = defaultModels(),
  apply = false,
  confirm = ""
} = {}) {
  const shouldApply = apply === true;
  const knownTestEmailsResult = parseKnownTestEmails(env.KNOWN_TEST_EMAILS);
  const knownTestEmails = new Set(knownTestEmailsResult.ok ? knownTestEmailsResult.emails : [normalizeEmail(env.TARGET_EMAIL)].filter(Boolean));
  const targetUser = await findTargetUser(models.Usuario, env);
  const summary = safeEmptySummary();

  if (!targetUser) {
    summary.motivosBloqueo = ["usuario_no_encontrado"];
    return summary;
  }
  if (targetUser.activo !== false) {
    summary.motivosBloqueo = ["usuario_activo"];
    return summary;
  }
  if (shouldApply && confirm !== REQUIRED_CONFIRMATION) {
    summary.motivosBloqueo = ["confirmacion_requerida"];
    return summary;
  }

  const conversaciones = await findConversaciones(models.Conversacion, env.TARGET_USER_ID);
  const [usuariosResult, propiedadesResult, mensajesResult] = await Promise.all([
    safeRelatedRead(() => findUsuarios(models.Usuario, otherParticipantIds(conversaciones, env.TARGET_USER_ID))),
    safeRelatedRead(() => findPropiedades(models.Propiedad, propertyIds(conversaciones))),
    safeRelatedRead(() => findMensajes(models.Mensaje, conversationIds(conversaciones)))
  ]);

  return classify({
    targetUserId: env.TARGET_USER_ID,
    conversaciones,
    mensajes: mensajesResult.data,
    usuariosRelacionados: usuariosResult.data,
    propiedades: propiedadesResult.data,
    knownTestEmails,
    queryStatus: {
      usuarios: usuariosResult.ok,
      propiedades: propiedadesResult.ok,
      mensajes: mensajesResult.ok
    }
  });
}

export async function runCli({
  env = process.env,
  argv = process.argv,
  stdout = console.log,
  stderr = console.error,
  mongooseClient = mongoose,
  models = defaultModels()
} = {}) {
  const validation = validateCli({ env, argv });
  if (!validation.ok) {
    stderr(validation.message);
    return validation.code;
  }

  await mongooseClient.connect(env.MONGODB_URI);
  try {
    const summary = await auditSingleTestUserChatData({
      env,
      models,
      apply: envFlagEnabled("APPLY_SINGLE_TEST_USER_CHAT", env),
      confirm: env.CONFIRM_SINGLE_TEST_USER_CHAT
    });
    stdout(JSON.stringify(summary, null, 2));
    return summary.motivosBloqueo.length > 0 ? 1 : 0;
  } finally {
    await mongooseClient.disconnect();
  }
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  const code = await runCli();
  process.exit(code);
}
