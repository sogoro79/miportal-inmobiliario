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
          return q(count("propiedades"), "propiedadesCount", filter);
        }
      },
      Conversacion: {
        countDocuments(filter) {
          state.operations.push({ op: "chatsCount", filter });
          return q(count("chats"), "chatsCount", filter);
        }
      },
      Mensaje: {
        countDocuments(filter) {
          state.operations.push({ op: "mensajesCount", filter });
          return q(count("mensajes"), "mensajesCount", filter);
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

test("resumen bloquea usuario activo, admin, propio admin, Stripe y pending fields", async () => {
  const cases = [
    [usuarioEliminable({ activo: true }), "usuario_activo", ADMIN_ID],
    [usuarioEliminable({ role: "admin" }), "usuario_admin", ADMIN_ID],
    [usuarioEliminable(), "usuario_autenticado", TARGET_ID],
    [usuarioEliminable({ stripeCustomerId: "cus_secret" }), "stripe_presente", ADMIN_ID],
    [usuarioEliminable({ stripeSubscriptionId: "sub_secret" }), "stripe_presente", ADMIN_ID],
    [usuarioEliminable({ pendingPlan: "basico" }), "cambios_pendientes", ADMIN_ID],
    [usuarioEliminable({ pendingPriceId: "price_secret" }), "cambios_pendientes", ADMIN_ID],
    [usuarioEliminable({ pendingPlanChangeAt: new Date() }), "cambios_pendientes", ADMIN_ID]
  ];

  for (const [usuario, motivo, adminUserId] of cases) {
    const { models } = deletionModels({ usuario });
    const resumen = await construirResumenEliminacionUsuario({ targetUserId: TARGET_ID, adminUserId, models });
    assert.equal(resumen.seguro.puedeEliminar, false);
    assert.equal(resumen.seguro.motivosBloqueo.includes(motivo), true, motivo);
  }
});

test("resumen bloquea propiedades y relaciones compartidas", async () => {
  const cases = [
    [{ propiedades: 1 }, "propiedades_presentes"],
    [{ chats: 1 }, "chats_presentes"],
    [{ mensajes: 1 }, "mensajes_presentes"]
  ];

  for (const [counts, motivo] of cases) {
    const { models } = deletionModels({ counts });
    const resumen = await construirResumenEliminacionUsuario({ targetUserId: TARGET_ID, adminUserId: ADMIN_ID, models });
    assert.equal(resumen.seguro.puedeEliminar, false);
    assert.equal(resumen.seguro.motivosBloqueo.includes(motivo), true, motivo);
  }
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
    usuario: usuarioEliminable({ activo: true }),
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

test("usuario desactivado y limpio se elimina con filtro condicional y sin upsert", async () => {
  const { models, state } = deletionModels({
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
  assert.deepEqual(resultado.eliminados, { alertas: 2, notificaciones: 1, favoritosPropios: 1 });
  assert.equal(sessionState.sessions, 1);
  assert.equal(sessionState.ended, 1);
  assert.deepEqual(state.operations.map(op => op.op).filter(op => /Delete|findOneAndDelete/.test(op)), [
    "alertasDeleteMany",
    "notificacionesDeleteMany",
    "findOneAndDelete"
  ]);

  const userDelete = state.operations.find(op => op.op === "findOneAndDelete");
  assert.deepEqual(userDelete.filter, {
    _id: TARGET_ID,
    role: { $ne: "admin" },
    activo: false,
    stripeCustomerId: { $in: [null, ""] },
    stripeSubscriptionId: { $in: [null, ""] },
    pendingPlan: { $in: [null, ""] },
    pendingPriceId: { $in: [null, ""] },
    pendingPlanChangeAt: { $in: [null, ""] }
  });
  assert.equal("upsert" in userDelete.filter, false);
  assert.doesNotMatch(JSON.stringify(log.infos), /persona@example\.com|507f1f77bcf86cd799439055|sub_|cus_|price_/);
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
  assert.match(adminSource, /eliminarUsuarioDesactivadoSeguro/);
});

test("eliminación admin no usa Stripe, Cloudinary, email ni borrado de propiedades", () => {
  const adminSource = fs.readFileSync(new URL("../routes/admin.js", import.meta.url), "utf8");
  const deleteBlock = adminSource.match(/export async function eliminarUsuarioDesactivadoSeguro[\s\S]*?^}/m)?.[0] || "";

  assert.doesNotMatch(deleteBlock, /stripe\.|subscriptions\.|new Stripe/);
  assert.doesNotMatch(deleteBlock, /cloudinary|destroyImagesByUrls/);
  assert.doesNotMatch(deleteBlock, /resend|emails\.send|sendMail|enviar/);
  assert.doesNotMatch(deleteBlock, /Propiedad\.delete|models\.Propiedad\.delete|findByIdAndDelete/);
  assert.doesNotMatch(deleteBlock, /updateMany|bulkWrite|insert|create|upsert/);
});

test("frontend habilita eliminar solo para usuarios desactivados y confirma antes de borrar", () => {
  const adminHtml = fs.readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");

  assert.match(adminHtml, /Primero desactiva el usuario/);
  assert.match(adminHtml, /eliminarUsuarioDesactivado\('\$\{u\._id\}'\)/);
  assert.match(adminHtml, /\/admin\/usuarios\/\$\{usuarioId\}\/eliminacion-resumen/);
  assert.match(adminHtml, /confirm\('Esta acción eliminará definitivamente un usuario desactivado/);
  assert.match(adminHtml, /method: 'DELETE'/);
  assert.match(adminHtml, /confirmacion: 'ELIMINAR_USUARIO_DESACTIVADO'/);
  assert.match(adminHtml, /await cargarUsuarios\(\);[\s\S]*await cargarStats\(\);/);
  assert.doesNotMatch(adminHtml, /console\.log\(.*eliminarUsuarioDesactivado/);
});
