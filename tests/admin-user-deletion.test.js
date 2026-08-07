import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.JWT_SECRET = "test-secret";
process.env.RESEND_API_KEY = "re_test";
process.env.STRIPE_SECRET_KEY = "sk_test_123";

const {
  CONFIRMACION_ELIMINAR_USUARIO_DESACTIVADO,
  construirResumenEliminacionUsuario,
  eliminarUsuarioDesactivadoSeguro
} = await import("../routes/admin.js");

const TARGET_ID = "507f1f77bcf86cd799439055";
const ADMIN_ID = "507f1f77bcf86cd799439099";
const CLOUDINARY_URL_A = "https://res.cloudinary.com/demo/image/upload/v1/miportal_inmobiliario/admin-user-a.jpg";
const CLOUDINARY_URL_B = "https://res.cloudinary.com/demo/image/upload/v1/miportal_inmobiliario/admin-user-b.jpg";
const CLOUDINARY_URL_COMPARTIDA = "https://res.cloudinary.com/demo/image/upload/v1/miportal_inmobiliario/admin-user-shared.jpg";

function usuarioEliminable(overrides = {}) {
  return {
    _id: { toString: () => TARGET_ID },
    email: "persona@example.com",
    role: "user",
    activo: false,
    favoritos: ["507f1f77bcf86cd799439077"],
    stripeCustomerId: undefined,
    stripeSubscriptionId: undefined,
    pendingPlan: undefined,
    pendingPriceId: undefined,
    pendingPlanChangeAt: undefined,
    pendingPlanLabel: undefined,
    ...overrides
  };
}

function sessionable(value, onSession = () => {}) {
  const resolveValue = () => (typeof value === "function" ? value() : value);
  return {
    session(session) {
      onSession(session);
      return Promise.resolve().then(resolveValue);
    },
    then(resolve, reject) {
      return Promise.resolve().then(resolveValue).then(resolve, reject);
    }
  };
}

function deletionModels({
  usuario = usuarioEliminable(),
  counts = {},
  propiedades = [],
  conversaciones = [],
  remainingMessagesByConversation = {},
  deletedOwnMessagesByConversation = {},
  updateMatches = true,
  failAt = null
} = {}) {
  const state = { operations: [], sessions: [], filters: [] };
  const count = key => Number(counts[key] || 0);
  const q = (value, op, filter) => sessionable(value, session => {
    state.sessions.push({ op, session });
    if (filter) state.filters.push({ op, filter });
  });

  return {
    state,
    models: {
      Usuario: {
        findById(id, projection) {
          state.operations.push({ op: "findById", id, projection });
          return q(usuario, "findById", { _id: id });
        },
        findOneAndDelete(filter) {
          state.operations.push({ op: "findOneAndDelete", filter });
          return q(() => {
            if (failAt === "userDelete") throw new Error("delete failed");
            return updateMatches ? usuario : null;
          }, "findOneAndDelete", filter);
        }
      },
      Propiedad: {
        countDocuments(filter) {
          state.operations.push({ op: "propiedadesCount", filter });
          return q(count("propiedades") || propiedades.filter(propiedad => String(propiedad.usuarioId) === String(filter?.usuarioId)).length, "propiedadesCount", filter);
        },
        find(filter, projection) {
          state.operations.push({ op: "propiedadesFind", filter, projection });
          const matches = propiedades.filter(propiedad => {
            if (filter?.usuarioId && typeof filter.usuarioId === "object" && "$ne" in filter.usuarioId) {
              return String(propiedad.usuarioId) !== String(filter.usuarioId.$ne);
            }
            return String(propiedad.usuarioId) === String(filter?.usuarioId);
          });
          return q(matches, "propiedadesFind", filter);
        },
        deleteMany(filter) {
          state.operations.push({ op: "propiedadesDeleteMany", filter });
          const deletedCount = propiedades.filter(propiedad => String(propiedad.usuarioId) === String(filter?.usuarioId)).length;
          return q({ deletedCount }, "propiedadesDeleteMany", filter);
        }
      },
      Conversacion: {
        countDocuments(filter) {
          state.operations.push({ op: "chatsCount", filter });
          return q(count("chats"), "chatsCount", filter);
        },
        find(filter) {
          state.operations.push({ op: "chatsFind", filter });
          return q(conversaciones, "chatsFind", filter);
        },
        updateOne(filter, update) {
          state.operations.push({ op: "chatsUpdateOne", filter, update });
          return q({ matchedCount: 1, modifiedCount: 1 }, "chatsUpdateOne", filter);
        },
        deleteOne(filter) {
          state.operations.push({ op: "chatsDeleteOne", filter });
          return q({ deletedCount: 1 }, "chatsDeleteOne", filter);
        }
      },
      Mensaje: {
        countDocuments(filter) {
          state.operations.push({ op: "mensajesCount", filter });
          const conversacionId = filter?.conversacionId ? String(filter.conversacionId) : null;
          return q(conversacionId ? Number(remainingMessagesByConversation[conversacionId] || 0) : count("mensajes"), "mensajesCount", filter);
        },
        deleteMany(filter) {
          state.operations.push({ op: "mensajesDeleteMany", filter });
          const conversacionId = filter?.conversacionId ? String(filter.conversacionId) : null;
          return q({ deletedCount: Number(deletedOwnMessagesByConversation[conversacionId] || 0) }, "mensajesDeleteMany", filter);
        }
      },
      Alerta: {
        countDocuments(filter) {
          state.operations.push({ op: "alertasCount", filter });
          return q(count("alertas"), "alertasCount", filter);
        },
        deleteMany(filter) {
          state.operations.push({ op: "alertasDeleteMany", filter });
          return q({ deletedCount: count("alertas") }, "alertasDeleteMany", filter);
        }
      },
      Notificacion: {
        countDocuments(filter) {
          state.operations.push({ op: "notificacionesCount", filter });
          return q(count("notificaciones"), "notificacionesCount", filter);
        },
        deleteMany(filter) {
          state.operations.push({ op: "notificacionesDeleteMany", filter });
          return q({ deletedCount: count("notificaciones") }, "notificacionesDeleteMany", filter);
        }
      }
    }
  };
}

function mongooseMock(state = { sessions: 0, ended: 0 }) {
  return {
    async startSession() {
      state.sessions += 1;
      return {
        async withTransaction(fn) {
          return fn();
        },
        async endSession() {
          state.ended += 1;
        }
      };
    }
  };
}

function loggerMock() {
  return {
    infos: [],
    info(...args) {
      this.infos.push(args);
    }
  };
}

test("resumen de eliminación es solo lectura y devuelve conteos seguros", async () => {
  const { models, state } = deletionModels({
    counts: { alertas: 2, notificaciones: 3 }
  });

  const resumen = await construirResumenEliminacionUsuario({
    targetUserId: TARGET_ID,
    adminUserId: ADMIN_ID,
    models
  });

  assert.equal(resumen.seguro.usuarioDesactivado, true);
  assert.equal(resumen.seguro.tieneStripe, false);
  assert.equal(resumen.seguro.tieneCambiosPendientes, false);
  assert.equal(resumen.seguro.favoritos, 1);
  assert.equal(resumen.seguro.alertas, 2);
  assert.equal(resumen.seguro.notificaciones, 3);
  assert.equal(resumen.seguro.puedeEliminar, true);
  assert.equal(state.operations.some(op => /Delete|delete|findOneAndDelete/.test(op.op)), false);
  assert.doesNotMatch(JSON.stringify(resumen.seguro), /persona@example\.com|507f1f77bcf86cd799439055|sk_test|sub_/);
});

test("resumen permite usuario activo normal y bloquea admin, propio admin, Stripe y pending fields", async () => {
  const { models: activeModels } = deletionModels({ usuario: usuarioEliminable({ activo: true }) });
  const activeResumen = await construirResumenEliminacionUsuario({ targetUserId: TARGET_ID, adminUserId: ADMIN_ID, models: activeModels });
  assert.equal(activeResumen.seguro.usuarioDesactivado, false);
  assert.equal(activeResumen.seguro.puedeEliminar, true);
  assert.equal(activeResumen.seguro.motivosBloqueo.includes("usuario_activo"), false);

  const cases = [
    [usuarioEliminable({ role: "admin" }), "usuario_admin", ADMIN_ID],
    [usuarioEliminable(), "usuario_autenticado", TARGET_ID],
    [usuarioEliminable({ stripeSubscriptionId: "sub_secret", subscriptionStatus: "active" }), "stripe_presente", ADMIN_ID],
    [usuarioEliminable({ pendingPlan: "basico" }), "cambios_pendientes", ADMIN_ID],
    [usuarioEliminable({ pendingPriceId: "price_secret" }), "cambios_pendientes", ADMIN_ID],
    [usuarioEliminable({ pendingPlanChangeAt: new Date() }), "cambios_pendientes", ADMIN_ID],
    [usuarioEliminable({ pendingPlanLabel: "Plan básico" }), "cambios_pendientes", ADMIN_ID]
  ];

  for (const [usuario, motivo, adminUserId] of cases) {
    const { models } = deletionModels({ usuario });
    const resumen = await construirResumenEliminacionUsuario({ targetUserId: TARGET_ID, adminUserId, models });
    assert.equal(resumen.seguro.puedeEliminar, false);
    assert.equal(resumen.seguro.motivosBloqueo.includes(motivo), true, motivo);
  }
});

test("resumen permite propiedades, imágenes y historial de chat como contenido eliminable", async () => {
  const { models: propsModels } = deletionModels({
    propiedades: [
      { _id: "prop-1", usuarioId: TARGET_ID, imagenes: [CLOUDINARY_URL_A, "https://example.com/local.jpg"] }
    ]
  });
  const propsResumen = await construirResumenEliminacionUsuario({ targetUserId: TARGET_ID, adminUserId: ADMIN_ID, models: propsModels });
  assert.equal(propsResumen.seguro.propiedades, 1);
  assert.equal(propsResumen.seguro.imagenes, 2);
  assert.equal(propsResumen.seguro.imagenesCloudinary, 1);
  assert.equal(propsResumen.seguro.puedeEliminar, true);
  assert.equal(propsResumen.seguro.motivosBloqueo.includes("propiedades_presentes"), false);

  const { models } = deletionModels({ counts: { chats: 1, mensajes: 2 } });
  const resumen = await construirResumenEliminacionUsuario({ targetUserId: TARGET_ID, adminUserId: ADMIN_ID, models });
  assert.equal(resumen.seguro.chats, 1);
  assert.equal(resumen.seguro.mensajes, 2);
  assert.equal(resumen.seguro.puedeEliminar, true);
  assert.equal(resumen.seguro.motivosBloqueo.includes("chats_presentes"), false);
  assert.equal(resumen.seguro.motivosBloqueo.includes("mensajes_presentes"), false);
});

test("eliminación exige confirmación, usuario existente y transacción", async () => {
  const { models } = deletionModels();
  await assert.rejects(
    () => eliminarUsuarioDesactivadoSeguro({ targetUserId: TARGET_ID, adminUserId: ADMIN_ID, models, mongooseClient: mongooseMock() }),
    { code: "confirmacion_requerida" }
  );
  await assert.rejects(
    () => eliminarUsuarioDesactivadoSeguro({ targetUserId: TARGET_ID, adminUserId: ADMIN_ID, confirmacion: "MAL", models, mongooseClient: mongooseMock() }),
    { code: "confirmacion_requerida" }
  );
  await assert.rejects(
    () => eliminarUsuarioDesactivadoSeguro({ targetUserId: TARGET_ID, adminUserId: ADMIN_ID, confirmacion: CONFIRMACION_ELIMINAR_USUARIO_DESACTIVADO, models, mongooseClient: {} }),
    { code: "transaccion_no_disponible" }
  );
  await assert.rejects(
    () => eliminarUsuarioDesactivadoSeguro({
      targetUserId: TARGET_ID,
      adminUserId: ADMIN_ID,
      confirmacion: CONFIRMACION_ELIMINAR_USUARIO_DESACTIVADO,
      models: deletionModels({ usuario: null }).models,
      mongooseClient: mongooseMock()
    }),
    { code: "usuario_no_encontrado" }
  );
});

test("eliminación bloqueada no escribe y no reintenta", async () => {
  const { models, state } = deletionModels({
    usuario: usuarioEliminable({ pendingPlan: "basico" }),
    counts: { alertas: 2, notificaciones: 2 }
  });

  await assert.rejects(
    () => eliminarUsuarioDesactivadoSeguro({
      targetUserId: TARGET_ID,
      adminUserId: ADMIN_ID,
      confirmacion: CONFIRMACION_ELIMINAR_USUARIO_DESACTIVADO,
      models,
      mongooseClient: mongooseMock()
    }),
    { code: "eliminacion_bloqueada" }
  );

  assert.equal(state.operations.some(op => op.op === "alertasDeleteMany"), false);
  assert.equal(state.operations.some(op => op.op === "notificacionesDeleteMany"), false);
  assert.equal(state.operations.some(op => op.op === "findOneAndDelete"), false);
});

test("usuario normal limpio se elimina con filtro condicional y sin upsert aunque esté activo", async () => {
  const { models, state } = deletionModels({
    usuario: usuarioEliminable({ activo: true }),
    counts: { alertas: 2, notificaciones: 1 }
  });
  const sessionState = { sessions: 0, ended: 0 };
  const log = loggerMock();

  const resultado = await eliminarUsuarioDesactivadoSeguro({
    targetUserId: TARGET_ID,
    adminUserId: ADMIN_ID,
    confirmacion: CONFIRMACION_ELIMINAR_USUARIO_DESACTIVADO,
    models,
    mongooseClient: mongooseMock(sessionState),
    logger: log
  });

  assert.equal(resultado.ok, true);
  assert.equal(resultado.usuarioEliminado, true);
  assert.deepEqual(resultado.eliminados, {
    alertas: 2,
    notificaciones: 1,
    propiedades: 0,
    mensajesPropios: 0,
    conversacionesMarcadas: 0,
    conversacionesEliminadas: 0,
    favoritosPropios: 1,
    imagenesCloudinaryPreparadas: 0,
    imagenesCompartidasPreservadas: 0,
    imagenesCloudinaryEliminadas: 0,
    imagenesCloudinaryOmitidas: 0
  });
  assert.equal(sessionState.sessions, 1);
  assert.equal(sessionState.ended, 1);
  assert.deepEqual(state.operations.map(op => op.op).filter(op => /Delete|findOneAndDelete/.test(op)), [
    "alertasDeleteMany",
    "notificacionesDeleteMany",
    "propiedadesDeleteMany",
    "findOneAndDelete"
  ]);

  const userDelete = state.operations.find(op => op.op === "findOneAndDelete");
  assert.deepEqual(userDelete.filter, {
    _id: TARGET_ID,
    role: { $ne: "admin" },
    subscriptionStatus: { $nin: ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"] },
    cancelAtPeriodEnd: { $ne: true },
    $or: [
      { subscriptionCancelAt: { $in: [null, ""] } },
      { subscriptionStatus: "canceled" }
    ],
    pendingPlan: { $in: [null, ""] },
    pendingPriceId: { $in: [null, ""] },
    pendingPlanChangeAt: { $in: [null, ""] },
    pendingPlanLabel: { $in: [null, ""] }
  });
  assert.equal("upsert" in userDelete.filter, false);
  assert.doesNotMatch(JSON.stringify(log.infos), /persona@example\.com|507f1f77bcf86cd799439055|sub_|cus_|price_/);
});

test("eliminación borra solo propiedades propias y prepara imágenes Cloudinary no compartidas", async () => {
  const destroyCalls = [];
  const { models, state } = deletionModels({
    propiedades: [
      { _id: "propia-1", usuarioId: TARGET_ID, imagenes: [CLOUDINARY_URL_A, CLOUDINARY_URL_COMPARTIDA, CLOUDINARY_URL_A] },
      { _id: "propia-2", usuarioId: TARGET_ID, imagenes: [CLOUDINARY_URL_B] },
      { _id: "ajena-1", usuarioId: ADMIN_ID, imagenes: [CLOUDINARY_URL_COMPARTIDA] }
    ]
  });

  const resultado = await eliminarUsuarioDesactivadoSeguro({
    targetUserId: TARGET_ID,
    adminUserId: ADMIN_ID,
    confirmacion: CONFIRMACION_ELIMINAR_USUARIO_DESACTIVADO,
    models,
    mongooseClient: mongooseMock(),
    logger: loggerMock(),
    destroyImages: async urls => {
      destroyCalls.push(urls);
      return { failed: 0, deleted: urls.length, skipped: 0 };
    }
  });

  assert.deepEqual(state.operations.find(op => op.op === "propiedadesDeleteMany").filter, { usuarioId: TARGET_ID });
  assert.deepEqual(destroyCalls, [[CLOUDINARY_URL_A, CLOUDINARY_URL_B]]);
  assert.equal(resultado.eliminados.propiedades, 2);
  assert.equal(resultado.eliminados.imagenesCloudinaryPreparadas, 2);
  assert.equal(resultado.eliminados.imagenesCompartidasPreservadas, 1);
});

test("Stripe local obsoleto no bloquea pero pending y estados peligrosos sí bloquean", async () => {
  const { models } = deletionModels({
    usuario: usuarioEliminable({
      stripeCustomerId: "cus_secret",
      stripeSubscriptionId: "sub_secret",
      subscriptionStatus: "canceled"
    })
  });
  const resumen = await construirResumenEliminacionUsuario({ targetUserId: TARGET_ID, adminUserId: ADMIN_ID, models });
  assert.equal(resumen.seguro.tieneStripe, true);
  assert.equal(resumen.seguro.stripeLocalObsoleto, true);
  assert.equal(resumen.seguro.stripeBloqueante, false);
  assert.equal(resumen.seguro.puedeEliminar, true);

  for (const usuario of [
    usuarioEliminable({ stripeSubscriptionId: "sub_secret", subscriptionStatus: "active" }),
    usuarioEliminable({ stripeSubscriptionId: "sub_secret", cancelAtPeriodEnd: true }),
    usuarioEliminable({ pendingPlanLabel: "Plan Básico" })
  ]) {
    const { models: blockedModels } = deletionModels({ usuario });
    const blocked = await construirResumenEliminacionUsuario({ targetUserId: TARGET_ID, adminUserId: ADMIN_ID, models: blockedModels });
    assert.equal(blocked.seguro.puedeEliminar, false);
  }
});

test("fallo Cloudinary se informa sin ocultarlo tras la transacción", async () => {
  const { models, state } = deletionModels({
    propiedades: [
      { _id: "propia-1", usuarioId: TARGET_ID, imagenes: [CLOUDINARY_URL_A] }
    ]
  });

  await assert.rejects(
    () => eliminarUsuarioDesactivadoSeguro({
      targetUserId: TARGET_ID,
      adminUserId: ADMIN_ID,
      confirmacion: CONFIRMACION_ELIMINAR_USUARIO_DESACTIVADO,
      models,
      mongooseClient: mongooseMock(),
      destroyImages: async () => ({ failed: 1, deleted: 0, skipped: 0 })
    }),
    { code: "cloudinary_limpieza_incompleta" }
  );

  assert.equal(state.operations.some(op => op.op === "findOneAndDelete"), true);
});

test("eliminación conserva historial de otros participantes y marca usuario eliminado", async () => {
  const convId = "507f1f77bcf86cd799439066";
  const { models, state } = deletionModels({
    counts: { chats: 1, mensajes: 1 },
    conversaciones: [{ _id: convId, compradorId: TARGET_ID, anuncianteId: "507f1f77bcf86cd799439088" }],
    deletedOwnMessagesByConversation: { [convId]: 1 },
    remainingMessagesByConversation: { [convId]: 2 }
  });

  const resultado = await eliminarUsuarioDesactivadoSeguro({
    targetUserId: TARGET_ID,
    adminUserId: ADMIN_ID,
    confirmacion: CONFIRMACION_ELIMINAR_USUARIO_DESACTIVADO,
    models,
    mongooseClient: mongooseMock(),
    logger: loggerMock()
  });

  assert.equal(resultado.eliminados.mensajesPropios, 1);
  assert.equal(resultado.eliminados.conversacionesMarcadas, 1);
  assert.equal(resultado.eliminados.conversacionesEliminadas, 0);
  assert.deepEqual(state.operations.find(op => op.op === "mensajesDeleteMany").filter, {
    conversacionId: convId,
    userId: TARGET_ID
  });
  assert.deepEqual(state.operations.find(op => op.op === "chatsUpdateOne").update, {
    $addToSet: { deletedParticipants: TARGET_ID, hiddenFor: TARGET_ID }
  });
  assert.equal(state.operations.some(op => op.op === "chatsDeleteOne"), false);
});

test("eliminación borra físicamente conversación solo cuando no quedan mensajes", async () => {
  const convId = "507f1f77bcf86cd799439066";
  const { models, state } = deletionModels({
    counts: { chats: 1, mensajes: 1 },
    conversaciones: [{ _id: convId, compradorId: TARGET_ID, anuncianteId: "507f1f77bcf86cd799439088" }],
    deletedOwnMessagesByConversation: { [convId]: 1 },
    remainingMessagesByConversation: { [convId]: 0 }
  });

  const resultado = await eliminarUsuarioDesactivadoSeguro({
    targetUserId: TARGET_ID,
    adminUserId: ADMIN_ID,
    confirmacion: CONFIRMACION_ELIMINAR_USUARIO_DESACTIVADO,
    models,
    mongooseClient: mongooseMock(),
    logger: loggerMock()
  });

  assert.equal(resultado.eliminados.conversacionesMarcadas, 0);
  assert.equal(resultado.eliminados.conversacionesEliminadas, 1);
  assert.deepEqual(state.operations.find(op => op.op === "chatsDeleteOne").filter, {
    _id: convId,
    $or: [{ compradorId: TARGET_ID }, { anuncianteId: TARGET_ID }]
  });
  assert.equal(state.operations.some(op => op.op === "chatsUpdateOne"), false);
});

test("cambio concurrente provoca aborto sin segunda eliminación de usuario", async () => {
  const { models, state } = deletionModels({ updateMatches: false });

  await assert.rejects(
    () => eliminarUsuarioDesactivadoSeguro({
      targetUserId: TARGET_ID,
      adminUserId: ADMIN_ID,
      confirmacion: CONFIRMACION_ELIMINAR_USUARIO_DESACTIVADO,
      models,
      mongooseClient: mongooseMock()
    }),
    { code: "eliminacion_condicional_sin_coincidencias" }
  );

  assert.equal(state.operations.filter(op => op.op === "findOneAndDelete").length, 1);
});

test("fallo parcial aborta dentro de transacción antes de borrar usuario", async () => {
  const { models, state } = deletionModels({
    counts: { alertas: 1 },
    failAt: "userDelete"
  });

  await assert.rejects(
    () => eliminarUsuarioDesactivadoSeguro({
      targetUserId: TARGET_ID,
      adminUserId: ADMIN_ID,
      confirmacion: CONFIRMACION_ELIMINAR_USUARIO_DESACTIVADO,
      models,
      mongooseClient: mongooseMock()
    }),
    /delete failed/
  );

  assert.equal(state.operations.filter(op => op.op === "findOneAndDelete").length, 1);
});

test("rutas administrativas de eliminación validan ID y confirmación", () => {
  const adminSource = fs.readFileSync(new URL("../routes/admin.js", import.meta.url), "utf8");

  assert.match(adminSource, /router\.get\('\/usuarios\/:id\/eliminacion-resumen', requireAdmin/);
  assert.match(adminSource, /router\.delete\('\/usuarios\/:id', requireAdmin/);
  assert.match(adminSource, /if \(!esObjectId\(req\.params\.id\)\)/);
  assert.match(adminSource, /req\.body\?\.confirmacion !== CONFIRMACION_ELIMINAR_USUARIO_DESACTIVADO/);
  assert.match(adminSource, /confirmacion: req\.body\?\.confirmacion/);
  assert.match(adminSource, /eliminarUsuarioDesactivadoSeguro/);
});

test("eliminación admin no usa Stripe, email ni borrados inseguros de propiedades", () => {
  const adminSource = fs.readFileSync(new URL("../routes/admin.js", import.meta.url), "utf8");
  const deleteBlock = adminSource.match(/export async function eliminarUsuarioDesactivadoSeguro[\s\S]*?\nfunction limpiarTexto/)?.[0] || "";

  assert.doesNotMatch(deleteBlock, /stripe\.|subscriptions\.|new Stripe/);
  assert.match(deleteBlock, /destroyImages\(imagenesCloudinaryPendientes, \{ client: cloudinaryClient \}\)/);
  assert.doesNotMatch(deleteBlock, /resend|emails\.send|sendMail|enviar/);
  assert.match(deleteBlock, /models\.Propiedad\.deleteMany\(\{ usuarioId: targetUserId \}\)/);
  assert.doesNotMatch(deleteBlock, /findByIdAndDelete/);
  assert.doesNotMatch(deleteBlock, /updateMany|bulkWrite|insert|create|upsert/);
});

test("frontend permite abrir eliminación de usuarios normales activos y confirma antes de borrar", () => {
  const adminHtml = fs.readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");

  assert.doesNotMatch(adminHtml, /Primero desactiva el usuario/);
  assert.match(adminHtml, /const esAdministrador = u\.role === 'admin'/);
  assert.match(adminHtml, /No se pueden eliminar usuarios administradores/);
  assert.match(adminHtml, /eliminarUsuarioDesactivado\('\$\{u\._id\}'\)/);
  assert.match(adminHtml, /\/admin\/usuarios\/\$\{usuarioId\}\/eliminacion-resumen/);
  assert.match(adminHtml, /Este usuario está actualmente activo/);
  assert.match(adminHtml, /Eliminar definitivamente/);
  assert.match(adminHtml, /Los mensajes de otros usuarios se conservarán/);
  assert.match(adminHtml, /method: 'DELETE'/);
  assert.match(adminHtml, /confirmacion: 'ELIMINAR_USUARIO_DESACTIVADO'/);
  assert.match(adminHtml, /await cargarUsuarios\(\);[\s\S]*await cargarStats\(\);/);
  assert.doesNotMatch(adminHtml, /console\.log\(.*eliminarUsuarioDesactivado/);
});
