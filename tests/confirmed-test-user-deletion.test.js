import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  AUTHORIZED_TEST_EMAILS,
  CONFIRM_DELETE_CONFIRMED_TEST_USERS,
  PROTECTED_ADMIN_EMAIL,
  deleteConfirmedTestUsers,
  runDeleteConfirmedTestUsersCli,
  validateConfirmedTestUsersConfig
} from "../scripts/delete-confirmed-test-users.js";

const TARGET_IDS = [
  "507f1f77bcf86cd799439001",
  "507f1f77bcf86cd799439002",
  "507f1f77bcf86cd799439003",
  "507f1f77bcf86cd799439004",
  "507f1f77bcf86cd799439005"
];
const ADMIN_ID = "507f1f77bcf86cd799439099";
const REAL_USER_ID = "507f1f77bcf86cd799439088";
const CONV_A = "507f1f77bcf86cd799439101";
const CONV_B = "507f1f77bcf86cd799439102";
const PROPERTY_ID = "507f1f77bcf86cd799439201";

function oid(value) {
  return { toString: () => value };
}

function baseUsers(overrides = {}) {
  return AUTHORIZED_TEST_EMAILS.map((email, index) => ({
    _id: oid(TARGET_IDS[index]),
    email,
    role: "user",
    activo: false,
    stripeCustomerId: undefined,
    stripeSubscriptionId: undefined,
    pendingPlan: undefined,
    pendingPriceId: undefined,
    pendingPlanChangeAt: undefined,
    pendingPlanLabel: undefined,
    nombre: `Persona ${index}`,
    ...overrides[email]
  }));
}

function adminUser(overrides = {}) {
  return {
    _id: oid(ADMIN_ID),
    email: PROTECTED_ADMIN_EMAIL,
    role: "admin",
    activo: true,
    ...overrides
  };
}

function env(overrides = {}) {
  return {
    DELETE_CONFIRMED_TEST_USERS: "true",
    MONGODB_URI: "mongodb://example.invalid/homeclick24",
    TARGET_TEST_EMAILS: AUTHORIZED_TEST_EMAILS.join(","),
    PROTECTED_ADMIN_EMAIL,
    ...overrides
  };
}

function queryResult(value, state, op) {
  return {
    session(session) {
      state.sessions.push({ op, session });
      return this;
    },
    lean() {
      return Promise.resolve(typeof value === "function" ? value() : value);
    },
    then(resolve, reject) {
      return Promise.resolve(typeof value === "function" ? value() : value).then(resolve, reject);
    }
  };
}

function idString(value) {
  return String(value?._id || value || "");
}

function valuesFromIn(filterValue) {
  return Array.isArray(filterValue?.$in) ? filterValue.$in.map(String) : [];
}

function mockModels({
  users = baseUsers(),
  admin = adminUser(),
  propiedades = [],
  conversaciones = [
    { _id: oid(CONV_A), compradorId: oid(TARGET_IDS[0]), anuncianteId: oid(TARGET_IDS[1]), propiedadId: oid(PROPERTY_ID) },
    { _id: oid(CONV_B), compradorId: oid(TARGET_IDS[2]), anuncianteId: oid(ADMIN_ID), propiedadId: oid(PROPERTY_ID) }
  ],
  mensajes = [
    { _id: oid("507f1f77bcf86cd799439111"), conversacionId: oid(CONV_A), userId: oid(TARGET_IDS[0]), texto: "secreto" },
    { _id: oid("507f1f77bcf86cd799439112"), conversacionId: oid(CONV_A), userId: oid(TARGET_IDS[1]), texto: "secreto" },
    { _id: oid("507f1f77bcf86cd799439113"), conversacionId: oid(CONV_B), userId: oid(ADMIN_ID), texto: "secreto" }
  ],
  alertas = TARGET_IDS.slice(0, 2).map((id, index) => ({ _id: oid(`507f1f77bcf86cd79943912${index}`), usuarioId: oid(id) })),
  notificaciones = TARGET_IDS.slice(0, 1).map(id => ({ _id: oid("507f1f77bcf86cd799439130"), usuarioId: oid(id) })),
  failDeleteAt = null,
  failPostVerification = false
} = {}) {
  const state = {
    users: [...users],
    admin,
    propiedades: [...propiedades],
    conversaciones: [...conversaciones],
    mensajes: [...mensajes],
    alertas: [...alertas],
    notificaciones: [...notificaciones],
    operations: [],
    sessions: []
  };

  function targetIdsFromFilter(filter) {
    return valuesFromIn(filter?.usuarioId);
  }

  function conversationIdsFromFilter(filter) {
    return valuesFromIn(filter?.conversacionId || filter?._id);
  }

  const models = {
    Usuario: {
      find(filter, projection) {
        state.operations.push({ op: "Usuario.find", filter, projection });
        const emails = valuesFromIn(filter?.email);
        return queryResult(() => state.users.filter(user => emails.includes(user.email)), state, "Usuario.find");
      },
      findOne(filter, projection) {
        state.operations.push({ op: "Usuario.findOne", filter, projection });
        return queryResult(() => filter?.email === PROTECTED_ADMIN_EMAIL ? state.admin : null, state, "Usuario.findOne");
      },
      deleteMany(filter) {
        state.operations.push({ op: "Usuario.deleteMany", filter });
        return queryResult(() => {
          if (failDeleteAt === "Usuario.deleteMany") throw new Error("rollback");
          const allowed = new Set((filter?.$or || []).map(item => `${idString(item._id)}:${item.email}`));
          const before = state.users.length;
          state.users = state.users.filter(user => !allowed.has(`${idString(user)}:${user.email}`));
          return { deletedCount: before - state.users.length };
        }, state, "Usuario.deleteMany");
      }
    },
    Propiedad: {
      countDocuments(filter) {
        state.operations.push({ op: "Propiedad.countDocuments", filter });
        return queryResult(() => {
          const ids = targetIdsFromFilter(filter);
          return state.propiedades.filter(propiedad => ids.includes(idString(propiedad.usuarioId))).length;
        }, state, "Propiedad.countDocuments");
      },
      deleteMany() {
        throw new Error("properties must not be deleted");
      }
    },
    Conversacion: {
      find(filter, projection) {
        state.operations.push({ op: "Conversacion.find", filter, projection });
        const ids = valuesFromIn(filter?.$or?.[0]?.compradorId || filter?.$or?.[1]?.anuncianteId);
        return queryResult(() => state.conversaciones.filter(conversacion =>
          ids.includes(idString(conversacion.compradorId)) || ids.includes(idString(conversacion.anuncianteId))
        ), state, "Conversacion.find");
      },
      countDocuments(filter) {
        state.operations.push({ op: "Conversacion.countDocuments", filter });
        const ids = conversationIdsFromFilter(filter);
        return queryResult(() => state.conversaciones.filter(conversacion => ids.includes(idString(conversacion))).length, state, "Conversacion.countDocuments");
      },
      deleteMany(filter) {
        state.operations.push({ op: "Conversacion.deleteMany", filter });
        const ids = conversationIdsFromFilter(filter);
        return queryResult(() => {
          if (failDeleteAt === "Conversacion.deleteMany") throw new Error("rollback");
          const before = state.conversaciones.length;
          if (!failPostVerification) {
            state.conversaciones = state.conversaciones.filter(conversacion => !ids.includes(idString(conversacion)));
          }
          return { deletedCount: before - state.conversaciones.length };
        }, state, "Conversacion.deleteMany");
      }
    },
    Mensaje: {
      find(filter, projection) {
        state.operations.push({ op: "Mensaje.find", filter, projection });
        const ids = conversationIdsFromFilter(filter);
        return queryResult(() => state.mensajes.filter(mensaje => ids.includes(idString(mensaje.conversacionId))), state, "Mensaje.find");
      },
      countDocuments(filter) {
        state.operations.push({ op: "Mensaje.countDocuments", filter });
        const ids = conversationIdsFromFilter(filter);
        return queryResult(() => state.mensajes.filter(mensaje => ids.includes(idString(mensaje.conversacionId))).length, state, "Mensaje.countDocuments");
      },
      deleteMany(filter) {
        state.operations.push({ op: "Mensaje.deleteMany", filter });
        const ids = conversationIdsFromFilter(filter);
        return queryResult(() => {
          if (failDeleteAt === "Mensaje.deleteMany") throw new Error("rollback");
          const before = state.mensajes.length;
          state.mensajes = state.mensajes.filter(mensaje => !ids.includes(idString(mensaje.conversacionId)));
          return { deletedCount: before - state.mensajes.length };
        }, state, "Mensaje.deleteMany");
      }
    },
    Alerta: {
      countDocuments(filter) {
        state.operations.push({ op: "Alerta.countDocuments", filter });
        const ids = targetIdsFromFilter(filter);
        return queryResult(() => state.alertas.filter(alerta => ids.includes(idString(alerta.usuarioId))).length, state, "Alerta.countDocuments");
      },
      deleteMany(filter) {
        state.operations.push({ op: "Alerta.deleteMany", filter });
        const ids = targetIdsFromFilter(filter);
        return queryResult(() => {
          const before = state.alertas.length;
          state.alertas = state.alertas.filter(alerta => !ids.includes(idString(alerta.usuarioId)));
          return { deletedCount: before - state.alertas.length };
        }, state, "Alerta.deleteMany");
      }
    },
    Notificacion: {
      countDocuments(filter) {
        state.operations.push({ op: "Notificacion.countDocuments", filter });
        const ids = targetIdsFromFilter(filter);
        return queryResult(() => state.notificaciones.filter(notificacion => ids.includes(idString(notificacion.usuarioId))).length, state, "Notificacion.countDocuments");
      },
      deleteMany(filter) {
        state.operations.push({ op: "Notificacion.deleteMany", filter });
        const ids = targetIdsFromFilter(filter);
        return queryResult(() => {
          const before = state.notificaciones.length;
          state.notificaciones = state.notificaciones.filter(notificacion => !ids.includes(idString(notificacion.usuarioId)));
          return { deletedCount: before - state.notificaciones.length };
        }, state, "Notificacion.deleteMany");
      }
    }
  };

  return { models, state };
}

function mongooseMock({ rollbackState } = {}) {
  const state = { started: 0, ended: 0, transactions: 0, rolledBack: false };
  return {
    state,
    async connect() {
      state.connected = true;
    },
    async disconnect() {
      state.disconnected = true;
    },
    async startSession() {
      state.started += 1;
      return {
        async withTransaction(fn) {
          state.transactions += 1;
          const snapshot = rollbackState ? rollbackState() : null;
          try {
            return await fn();
          } catch (error) {
            state.rolledBack = true;
            if (snapshot && rollbackState.restore) rollbackState.restore(snapshot);
            throw error;
          }
        },
        async endSession() {
          state.ended += 1;
        }
      };
    }
  };
}

test("eliminación confirmada valida flag, lista exacta, duplicados, admin y argumentos", () => {
  assert.equal(validateConfirmedTestUsersConfig({ env: env({ DELETE_CONFIRMED_TEST_USERS: "TRUE" }), argv: ["node", "script"] }).code, "flag_requerida");
  assert.equal(validateConfirmedTestUsersConfig({ env: env({ MONGODB_URI: "" }), argv: ["node", "script"] }).code, "mongodb_uri_requerida");
  assert.equal(validateConfirmedTestUsersConfig({ env: env(), argv: ["node", "script", "--apply"] }).code, "argumentos_no_permitidos");
  assert.equal(validateConfirmedTestUsersConfig({ env: env({ TARGET_TEST_EMAILS: `${AUTHORIZED_TEST_EMAILS.join(",")},extra@example.com` }), argv: ["node", "script"] }).code, "lista_objetivo_invalida");
  assert.equal(validateConfirmedTestUsersConfig({ env: env({ TARGET_TEST_EMAILS: AUTHORIZED_TEST_EMAILS.slice(0, 4).join(",") }), argv: ["node", "script"] }).code, "lista_objetivo_invalida");
  assert.equal(validateConfirmedTestUsersConfig({ env: env({ TARGET_TEST_EMAILS: [AUTHORIZED_TEST_EMAILS[0], AUTHORIZED_TEST_EMAILS[0], ...AUTHORIZED_TEST_EMAILS.slice(2)].join(",") }), argv: ["node", "script"] }).code, "emails_duplicados");
  assert.equal(validateConfirmedTestUsersConfig({ env: env({ TARGET_TEST_EMAILS: [PROTECTED_ADMIN_EMAIL, ...AUTHORIZED_TEST_EMAILS.slice(1)].join(",") }), argv: ["node", "script"] }).code, "admin_protegido_incluido");
  assert.equal(validateConfirmedTestUsersConfig({ env: env({ TARGET_TEST_EMAILS: ["bad", ...AUTHORIZED_TEST_EMAILS.slice(1)].join(",") }), argv: ["node", "script"] }).code, "email_invalido");
  assert.equal(validateConfirmedTestUsersConfig({ env: env({ PROTECTED_ADMIN_EMAIL: "otra@example.com" }), argv: ["node", "script"] }).code, "admin_protegido_invalido");
  assert.equal(validateConfirmedTestUsersConfig({ env: env(), argv: ["node", "script"] }).ok, true);
});

test("eliminación confirmada CLI aborta validaciones previas sin conectar", async () => {
  const calls = [];
  const code = await runDeleteConfirmedTestUsersCli({
    env: env({ DELETE_CONFIRMED_TEST_USERS: "false" }),
    argv: ["node", "script"],
    stdout: () => {},
    stderr: () => {},
    mongooseClient: {
      async connect() { calls.push("connect"); },
      async disconnect() { calls.push("disconnect"); }
    },
    models: mockModels().models
  });

  assert.equal(code, 1);
  assert.deepEqual(calls, []);
});

test("eliminación confirmada dry-run no escribe y devuelve resumen seguro", async () => {
  const { models, state } = mockModels();
  const summary = await deleteConfirmedTestUsers({ models });

  assert.equal(summary.usuariosEsperados, 5);
  assert.equal(summary.usuariosEncontrados, 5);
  assert.equal(summary.usuariosDesactivados, 5);
  assert.equal(summary.usuariosActivos, 0);
  assert.equal(summary.usuariosConRoleUser, 5);
  assert.equal(summary.conversacionesAutorizadas, 2);
  assert.equal(summary.conversacionesConAdminProtegido, 1);
  assert.equal(summary.mensajesAutorizados, 3);
  assert.equal(summary.alertasPropias, 2);
  assert.equal(summary.notificacionesPropias, 1);
  assert.equal(summary.eliminacionPermitida, true);
  assert.equal(summary.aplicariaCambios, false);
  assert.equal(state.operations.some(op => op.op.includes("deleteMany")), false);
});

test("eliminación confirmada permite role admin histórico en cuenta ficticia desactivada", async () => {
  const { models } = mockModels({
    users: baseUsers({ [AUTHORIZED_TEST_EMAILS[2]]: { role: "admin" } })
  });
  const summary = await deleteConfirmedTestUsers({ models });

  assert.equal(summary.usuariosConRoleAdminHistorico, 1);
  assert.equal(summary.eliminacionPermitida, true);
  assert.equal(summary.motivosBloqueo.includes("role_no_permitido"), false);
});

test("eliminación confirmada bloquea cuenta activa, cuenta ausente y admin protegido invalido", async () => {
  const active = await deleteConfirmedTestUsers({
    models: mockModels({ users: baseUsers({ [AUTHORIZED_TEST_EMAILS[0]]: { activo: true } }) }).models
  });
  assert.equal(active.eliminacionPermitida, false);
  assert.equal(active.motivosBloqueo.includes("usuarios_activos"), true);

  const missing = await deleteConfirmedTestUsers({
    models: mockModels({ users: baseUsers().slice(0, 4) }).models
  });
  assert.equal(missing.eliminacionPermitida, false);
  assert.equal(missing.motivosBloqueo.includes("cuentas_no_encontradas"), true);

  const invalidAdmin = await deleteConfirmedTestUsers({
    models: mockModels({ admin: adminUser({ activo: false }) }).models
  });
  assert.equal(invalidAdmin.eliminacionPermitida, false);
  assert.equal(invalidAdmin.motivosBloqueo.includes("admin_protegido_invalido"), true);
});

test("eliminación confirmada bloquea propiedades, Stripe local y cambios pendientes", async () => {
  const cases = [
    [mockModels({ propiedades: [{ usuarioId: oid(TARGET_IDS[0]) }] }).models, "propiedades_presentes"],
    [mockModels({ users: baseUsers({ [AUTHORIZED_TEST_EMAILS[0]]: { stripeSubscriptionId: "sub_secret" } }) }).models, "stripe_local_presente"],
    [mockModels({ users: baseUsers({ [AUTHORIZED_TEST_EMAILS[0]]: { stripeCustomerId: "cus_secret" } }) }).models, "stripe_local_presente"],
    [mockModels({ users: baseUsers({ [AUTHORIZED_TEST_EMAILS[0]]: { pendingPlan: "basico" } }) }).models, "cambios_pendientes"],
    [mockModels({ users: baseUsers({ [AUTHORIZED_TEST_EMAILS[0]]: { pendingPlanLabel: "Basico" } }) }).models, "cambios_pendientes"]
  ];

  for (const [models, reason] of cases) {
    const summary = await deleteConfirmedTestUsers({ models });
    assert.equal(summary.eliminacionPermitida, false, reason);
    assert.equal(summary.motivosBloqueo.includes(reason), true, reason);
  }
});

test("eliminación confirmada clasifica conversaciones con ficticias, admin protegido y usuario real", async () => {
  const summary = await deleteConfirmedTestUsers({
    models: mockModels({
      conversaciones: [
        { _id: oid(CONV_A), compradorId: oid(TARGET_IDS[0]), anuncianteId: oid(TARGET_IDS[1]), propiedadId: oid(PROPERTY_ID) },
        { _id: oid(CONV_B), compradorId: oid(TARGET_IDS[2]), anuncianteId: oid(ADMIN_ID), propiedadId: oid(PROPERTY_ID) },
        { _id: oid("507f1f77bcf86cd799439103"), compradorId: oid(TARGET_IDS[3]), anuncianteId: oid(REAL_USER_ID), propiedadId: oid(PROPERTY_ID) }
      ]
    }).models
  });

  assert.equal(summary.conversacionesAutorizadas, 2);
  assert.equal(summary.conversacionesConAdminProtegido, 1);
  assert.equal(summary.conversacionesConUsuariosExternos, 1);
  assert.equal(summary.eliminacionPermitida, false);
  assert.equal(summary.motivosBloqueo.includes("conversaciones_con_usuarios_externos"), true);
});

test("eliminación confirmada bloquea mensajes con autor externo", async () => {
  const summary = await deleteConfirmedTestUsers({
    models: mockModels({
      mensajes: [
        { _id: oid("507f1f77bcf86cd799439111"), conversacionId: oid(CONV_A), userId: oid(TARGET_IDS[0]) },
        { _id: oid("507f1f77bcf86cd799439112"), conversacionId: oid(CONV_A), userId: oid(REAL_USER_ID) }
      ]
    }).models
  });

  assert.equal(summary.mensajesAutorizados, 1);
  assert.equal(summary.eliminacionPermitida, false);
  assert.equal(summary.motivosBloqueo.includes("mensajes_con_autor_externo"), true);
});

test("eliminación confirmada protege función importada ante apply sin confirmación exacta", async () => {
  const { models, state } = mockModels();
  await assert.rejects(
    () => deleteConfirmedTestUsers({ models, apply: true }),
    { code: "confirmacion_requerida" }
  );
  await assert.rejects(
    () => deleteConfirmedTestUsers({ models, apply: true, confirm: "MAL" }),
    { code: "confirmacion_requerida" }
  );
  assert.equal(state.operations.some(op => op.op.includes("deleteMany")), false);
});

test("eliminación confirmada aplica una transacción y respeta el orden de eliminación", async () => {
  const { models, state } = mockModels();
  const mongooseClient = mongooseMock();
  const summary = await deleteConfirmedTestUsers({
    models,
    mongooseClient,
    apply: true,
    confirm: CONFIRM_DELETE_CONFIRMED_TEST_USERS
  });

  assert.equal(mongooseClient.state.started, 1);
  assert.equal(mongooseClient.state.transactions, 1);
  assert.equal(mongooseClient.state.ended, 1);
  assert.equal(summary.aplicoCambios, true);
  assert.equal(summary.verificacionCorrecta, true);
  assert.deepEqual(
    state.operations.filter(op => op.op.includes("deleteMany")).map(op => op.op),
    [
      "Mensaje.deleteMany",
      "Conversacion.deleteMany",
      "Alerta.deleteMany",
      "Notificacion.deleteMany",
      "Usuario.deleteMany"
    ]
  );
  assert.equal(state.users.length, 0);
  assert.equal(state.admin.email, PROTECTED_ADMIN_EMAIL);
  assert.equal(state.admin.activo, true);
  assert.equal(state.admin.role, "admin");
});

test("eliminación confirmada usa filtros condicionales estrictos para usuarios y no propiedades", async () => {
  const { models, state } = mockModels();
  await deleteConfirmedTestUsers({
    models,
    mongooseClient: mongooseMock(),
    apply: true,
    confirm: CONFIRM_DELETE_CONFIRMED_TEST_USERS
  });
  const userDelete = state.operations.find(op => op.op === "Usuario.deleteMany");

  assert.equal(userDelete.filter.activo, false);
  assert.deepEqual(userDelete.filter.stripeCustomerId, { $in: [null, ""] });
  assert.deepEqual(userDelete.filter.stripeSubscriptionId, { $in: [null, ""] });
  assert.deepEqual(userDelete.filter.pendingPlan, { $in: [null, ""] });
  assert.deepEqual(userDelete.filter.pendingPriceId, { $in: [null, ""] });
  assert.deepEqual(userDelete.filter.pendingPlanChangeAt, { $in: [null, ""] });
  assert.equal(userDelete.filter.$or.length, 5);
  assert.equal(state.operations.some(op => op.op === "Propiedad.deleteMany"), false);
});

test("eliminación confirmada hace rollback si falla un paso o la verificación posterior", async () => {
  const failing = mockModels({ failDeleteAt: "Conversacion.deleteMany" });
  const rollbackClient = mongooseMock({
    rollbackState: Object.assign(
      () => ({
        users: [...failing.state.users],
        conversaciones: [...failing.state.conversaciones],
        mensajes: [...failing.state.mensajes]
      }),
      {
        restore(snapshot) {
          failing.state.users = snapshot.users;
          failing.state.conversaciones = snapshot.conversaciones;
          failing.state.mensajes = snapshot.mensajes;
        }
      }
    )
  });

  await assert.rejects(
    () => deleteConfirmedTestUsers({
      models: failing.models,
      mongooseClient: rollbackClient,
      apply: true,
      confirm: CONFIRM_DELETE_CONFIRMED_TEST_USERS
    }),
    { message: "rollback" }
  );
  assert.equal(rollbackClient.state.rolledBack, true);
  assert.equal(failing.state.users.length, 5);

  const badPost = mockModels({ failPostVerification: true });
  await assert.rejects(
    () => deleteConfirmedTestUsers({
      models: badPost.models,
      mongooseClient: mongooseMock(),
      apply: true,
      confirm: CONFIRM_DELETE_CONFIRMED_TEST_USERS
    }),
    { code: "eliminacion_incompleta" }
  );
});

test("eliminación confirmada es idempotente si las cinco cuentas ya no existen", async () => {
  const { models, state } = mockModels({ users: [], conversaciones: [], mensajes: [], alertas: [], notificaciones: [] });
  const summary = await deleteConfirmedTestUsers({
    models,
    mongooseClient: mongooseMock(),
    apply: true,
    confirm: CONFIRM_DELETE_CONFIRMED_TEST_USERS
  });

  assert.equal(summary.aplicoCambios, false);
  assert.equal(summary.verificacionCorrecta, true);
  assert.equal(summary.motivosBloqueo.includes("cuentas_ya_eliminadas"), true);
  assert.equal(state.operations.some(op => op.op.includes("deleteMany")), false);
});

test("eliminación confirmada CLI pasa apply y confirm, conecta y desconecta con mocks", async () => {
  const { models } = mockModels();
  const mongooseClient = mongooseMock();
  const outputs = [];
  const code = await runDeleteConfirmedTestUsersCli({
    env: env({
      APPLY_CONFIRMED_TEST_USER_DELETION: "true",
      CONFIRM_CONFIRMED_TEST_USER_DELETION: CONFIRM_DELETE_CONFIRMED_TEST_USERS
    }),
    argv: ["node", "script"],
    stdout: value => outputs.push(JSON.parse(value)),
    stderr: () => {},
    mongooseClient,
    models
  });

  assert.equal(code, 0);
  assert.equal(mongooseClient.state.connected, true);
  assert.equal(mongooseClient.state.disconnected, true);
  assert.equal(outputs[0].aplicoCambios, true);
});

test("eliminación confirmada no expone emails, nombres, IDs, mensajes, Stripe ni URLs", async () => {
  const summary = await deleteConfirmedTestUsers({
    models: mockModels({
      users: baseUsers({ [AUTHORIZED_TEST_EMAILS[0]]: { nombre: "Nombre secreto" } }),
      mensajes: [{ _id: oid("507f1f77bcf86cd799439111"), conversacionId: oid(CONV_A), userId: oid(TARGET_IDS[0]), texto: "mensaje privado" }]
    }).models
  });
  const output = JSON.stringify(summary);

  assert.doesNotMatch(output, new RegExp(AUTHORIZED_TEST_EMAILS.join("|").replaceAll(".", "\\.")));
  assert.doesNotMatch(output, /Nombre secreto|mensaje privado|507f1f77bcf86cd799439001|sub_|cus_|https:\/\/|miportal_inmobiliario/);
});

test("script de eliminación confirmada no importa Stripe, Cloudinary, server ni añade efectos remotos", () => {
  const source = fs.readFileSync(new URL("../scripts/delete-confirmed-test-users.js", import.meta.url), "utf8");

  assert.doesNotMatch(source, /from "stripe"|from 'stripe'|new Stripe|stripe\./);
  assert.doesNotMatch(source, /cloudinary|destroyImagesByUrls|upload_stream|\.destroy\(/i);
  assert.doesNotMatch(source, /from "\.\.\/server\.js"|from '\.\.\/server\.js'|sendMail|emails\.send/);
});
