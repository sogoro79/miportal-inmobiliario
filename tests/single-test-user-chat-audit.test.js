import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  auditSingleTestUserChatData,
  runCli as runSingleTestUserChatAuditCli,
  validateCli as validateSingleTestUserChatAuditCli
} from "../scripts/clear-single-test-user-chat-data.js";

const TARGET_ID = "507f1f77bcf86cd799439066";
const OTHER_ID = "507f1f77bcf86cd799439077";
const PROPERTY_ID = "507f1f77bcf86cd799439088";
const CONV_ID = "507f1f77bcf86cd799439099";
const TARGET_EMAIL = "sonygr@gmail.com";
const OTHER_TEST_EMAIL = "sogoro0705@gmail.com";
const ADMIN_TEST_EMAIL = "sogoro.portal@gmail.com";
const NON_TEST_EMAIL = "real@example.com";

function chatAuditEnv(overrides = {}) {
  return {
    CLEAR_SINGLE_TEST_USER_CHAT: "true",
    MONGODB_URI: "mongodb://example/test",
    TARGET_USER_ID: TARGET_ID,
    TARGET_EMAIL,
    KNOWN_TEST_EMAILS: `${TARGET_EMAIL},${OTHER_TEST_EMAIL},${ADMIN_TEST_EMAIL}`,
    KNOWN_TEST_ADMIN_EMAIL: ADMIN_TEST_EMAIL,
    EXPECTED_ACTIVE: "false",
    ...overrides
  };
}

function q(value, onRead = () => {}) {
  return {
    async lean() {
      onRead();
      return value;
    }
  };
}

function qError() {
  return {
    async lean() {
      throw new Error("db detail with private data");
    }
  };
}

function chatAuditModels({
  targetUser = { _id: TARGET_ID, email: TARGET_EMAIL, activo: false },
  otherUsers = [{ _id: OTHER_ID, email: OTHER_TEST_EMAIL, role: "user", activo: false }],
  conversaciones = [{ _id: CONV_ID, compradorId: TARGET_ID, anuncianteId: OTHER_ID, propiedadId: PROPERTY_ID }],
  propiedades = [],
  mensajes = [],
  failReads = {}
} = {}) {
  const state = { reads: [], writes: [] };
  const write = op => {
    state.writes.push(op);
    throw new Error(`write not allowed: ${op}`);
  };

  return {
    state,
    models: {
      Usuario: {
        findOne(query, projection) {
          state.reads.push({ op: "Usuario.findOne", query, projection });
          return q(targetUser);
        },
        find(query, projection) {
          state.reads.push({ op: "Usuario.find", query, projection });
          if (failReads.usuarios) return qError();
          return q(otherUsers);
        },
        deleteMany: () => write("Usuario.deleteMany"),
        findOneAndDelete: () => write("Usuario.findOneAndDelete"),
        updateMany: () => write("Usuario.updateMany")
      },
      Propiedad: {
        find(query, projection) {
          state.reads.push({ op: "Propiedad.find", query, projection });
          if (failReads.propiedades) return qError();
          return q(propiedades);
        },
        deleteMany: () => write("Propiedad.deleteMany"),
        findOneAndDelete: () => write("Propiedad.findOneAndDelete"),
        updateMany: () => write("Propiedad.updateMany")
      },
      Conversacion: {
        find(query, projection) {
          state.reads.push({ op: "Conversacion.find", query, projection });
          return q(conversaciones);
        },
        deleteMany: () => write("Conversacion.deleteMany"),
        findOneAndDelete: () => write("Conversacion.findOneAndDelete"),
        updateMany: () => write("Conversacion.updateMany")
      },
      Mensaje: {
        find(query, projection) {
          state.reads.push({ op: "Mensaje.find", query, projection });
          if (failReads.mensajes) return qError();
          return q(mensajes);
        },
        deleteMany: () => write("Mensaje.deleteMany"),
        findOneAndDelete: () => write("Mensaje.findOneAndDelete"),
        updateMany: () => write("Mensaje.updateMany")
      }
    }
  };
}

test("auditoría chat valida flags y argumentos antes de conectar", () => {
  assert.equal(validateSingleTestUserChatAuditCli({ env: {}, argv: ["node", "script"] }).message, "CLEAR_SINGLE_TEST_USER_CHAT debe ser exactamente true.");
  assert.equal(validateSingleTestUserChatAuditCli({ env: chatAuditEnv({ CLEAR_SINGLE_TEST_USER_CHAT: "TRUE" }), argv: ["node", "script"] }).ok, false);
  assert.equal(validateSingleTestUserChatAuditCli({ env: chatAuditEnv({ MONGODB_URI: "" }), argv: ["node", "script"] }).message, "Falta MONGODB_URI.");
  assert.equal(validateSingleTestUserChatAuditCli({ env: chatAuditEnv({ TARGET_USER_ID: "bad-id" }), argv: ["node", "script"] }).message, "TARGET_USER_ID no es un ObjectId válido.");
  assert.equal(validateSingleTestUserChatAuditCli({ env: chatAuditEnv({ TARGET_EMAIL: "" }), argv: ["node", "script"] }).message, "Falta TARGET_EMAIL.");
  assert.equal(validateSingleTestUserChatAuditCli({ env: chatAuditEnv({ TARGET_EMAIL: "mal" }), argv: ["node", "script"] }).message, "TARGET_EMAIL no tiene un formato válido.");
  assert.equal(validateSingleTestUserChatAuditCli({ env: chatAuditEnv({ KNOWN_TEST_EMAILS: "" }), argv: ["node", "script"] }).message, "Falta KNOWN_TEST_EMAILS.");
  assert.equal(validateSingleTestUserChatAuditCli({ env: chatAuditEnv({ KNOWN_TEST_EMAILS: `${TARGET_EMAIL},mal` }), argv: ["node", "script"] }).message, "KNOWN_TEST_EMAILS contiene un email inválido.");
  assert.equal(validateSingleTestUserChatAuditCli({ env: chatAuditEnv({ KNOWN_TEST_EMAILS: `${TARGET_EMAIL},${TARGET_EMAIL}` }), argv: ["node", "script"] }).message, "KNOWN_TEST_EMAILS no admite duplicados.");
  assert.equal(validateSingleTestUserChatAuditCli({ env: chatAuditEnv({ KNOWN_TEST_EMAILS: OTHER_TEST_EMAIL }), argv: ["node", "script"] }).message, "KNOWN_TEST_EMAILS debe incluir TARGET_EMAIL.");
  assert.equal(validateSingleTestUserChatAuditCli({ env: chatAuditEnv({ KNOWN_TEST_ADMIN_EMAIL: "" }), argv: ["node", "script"] }).message, "Falta KNOWN_TEST_ADMIN_EMAIL.");
  assert.equal(validateSingleTestUserChatAuditCli({ env: chatAuditEnv({ KNOWN_TEST_ADMIN_EMAIL: "mal" }), argv: ["node", "script"] }).message, "KNOWN_TEST_ADMIN_EMAIL no tiene un formato válido.");
  assert.equal(validateSingleTestUserChatAuditCli({ env: chatAuditEnv({ KNOWN_TEST_ADMIN_EMAIL: NON_TEST_EMAIL }), argv: ["node", "script"] }).message, "KNOWN_TEST_ADMIN_EMAIL debe estar incluido en KNOWN_TEST_EMAILS.");
  assert.equal(validateSingleTestUserChatAuditCli({ env: chatAuditEnv({ KNOWN_TEST_ADMIN_EMAIL: TARGET_EMAIL }), argv: ["node", "script"] }).message, "KNOWN_TEST_ADMIN_EMAIL debe ser distinto de TARGET_EMAIL.");
  assert.equal(validateSingleTestUserChatAuditCli({ env: chatAuditEnv({ EXPECTED_ACTIVE: "true" }), argv: ["node", "script"] }).message, "EXPECTED_ACTIVE debe ser exactamente false.");
  assert.equal(validateSingleTestUserChatAuditCli({ env: chatAuditEnv(), argv: ["node", "script", "--apply"] }).message, "Esta auditoría no acepta argumentos ni opciones.");
});

test("auditoría chat aborta validaciones previas sin conectar", async () => {
  const calls = [];
  const code = await runSingleTestUserChatAuditCli({
    env: chatAuditEnv({ TARGET_USER_ID: "bad-id" }),
    argv: ["node", "script"],
    stdout: () => {},
    stderr: () => {},
    mongooseClient: {
      async connect() { calls.push("connect"); },
      async disconnect() { calls.push("disconnect"); }
    },
    models: chatAuditModels().models
  });

  assert.equal(code, 1);
  assert.deepEqual(calls, []);
});

test("auditoría chat en dry-run clasifica sin escrituras", async () => {
  const { models, state } = chatAuditModels({
    conversaciones: [{ _id: CONV_ID, compradorId: TARGET_ID, anuncianteId: OTHER_ID, propiedadId: PROPERTY_ID }],
    mensajes: [
      { conversacionId: CONV_ID, userId: TARGET_ID },
      { conversacionId: CONV_ID, userId: OTHER_ID }
    ]
  });

  const summary = await auditSingleTestUserChatData({
    env: chatAuditEnv(),
    models
  });

  assert.equal(summary.conversacionesTotales, 1);
  assert.equal(summary.mensajesTotales, 2);
  assert.equal(summary.conversacionesSoloUsuariosDesactivados, 1);
  assert.equal(summary.conversacionesConParticipanteTestDesactivado, 1);
  assert.equal(summary.todosLosParticipantesSonTest, true);
  assert.equal(summary.mensajesPropios, 1);
  assert.equal(summary.mensajesDeOtros, 1);
  assert.equal(summary.aplicariaCambios, false);
  assert.deepEqual(state.writes, []);
});

test("auditoría chat bloquea usuario activo", async () => {
  const summary = await auditSingleTestUserChatData({
    env: chatAuditEnv(),
    models: chatAuditModels({ targetUser: { _id: TARGET_ID, email: "sonygr@gmail.com", activo: true } }).models
  });

  assert.deepEqual(summary.motivosBloqueo, ["usuario_activo"]);
  assert.equal(summary.aplicariaCambios, false);
});

test("auditoría chat detecta otro participante activo", async () => {
  const summary = await auditSingleTestUserChatData({
    env: chatAuditEnv(),
    models: chatAuditModels({
      otherUsers: [{ _id: OTHER_ID, email: OTHER_TEST_EMAIL, role: "user", activo: true }],
      mensajes: [{ conversacionId: CONV_ID, userId: OTHER_ID }]
    }).models
  });

  assert.equal(summary.conversacionesConOtroUsuarioActivo, 1);
  assert.equal(summary.conversacionesConParticipanteTestActivo, 1);
  assert.equal(summary.bloqueadas, 1);
  assert.equal(summary.motivosBloqueo.includes("otro_usuario_activo"), true);
  assert.equal(summary.motivosBloqueo.includes("mensajes_de_otros"), true);
});

test("auditoría chat detecta conversaciones entre usuarios desactivados", async () => {
  const summary = await auditSingleTestUserChatData({
    env: chatAuditEnv(),
    models: chatAuditModels({
      otherUsers: [{ _id: OTHER_ID, email: OTHER_TEST_EMAIL, role: "user", activo: false }],
      propiedades: [],
      mensajes: [{ _id: "507f1f77bcf86cd799439111", conversacionId: CONV_ID, userId: TARGET_ID }]
    }).models
  });

  assert.equal(summary.conversacionesSoloUsuariosDesactivados, 1);
  assert.equal(summary.conversacionesConParticipanteTestDesactivado, 1);
  assert.equal(summary.todosLosParticipantesSonTest, true);
  assert.equal(summary.conversacionesTestDesactivadasValidas, 1);
  assert.equal(summary.eliminablesConSeguridad, 0);
  assert.equal(summary.bloqueadas, 0);
  assert.equal(summary.candidataLimpiezaControladaFutura, true);
});

test("auditoría chat bloquea propiedad existente", async () => {
  const summary = await auditSingleTestUserChatData({
    env: chatAuditEnv(),
    models: chatAuditModels({
      propiedades: [{ _id: PROPERTY_ID, visiblePublicamente: false }]
    }).models
  });

  assert.equal(summary.conversacionesConPropiedadExistente, 1);
  assert.equal(summary.bloqueadas, 1);
  assert.equal(summary.motivosBloqueo.includes("propiedad_existente"), true);
});

test("auditoría chat bloquea participantes ausentes, inválidos o inconsistentes", async () => {
  const cases = [
    [{ _id: CONV_ID, anuncianteId: OTHER_ID, propiedadId: PROPERTY_ID }, "falta_comprador"],
    [{ _id: CONV_ID, compradorId: TARGET_ID, propiedadId: PROPERTY_ID }, "falta_anunciante"],
    [{ _id: CONV_ID, compradorId: "no-id", anuncianteId: OTHER_ID, propiedadId: PROPERTY_ID }, "identificador_invalido"],
    [{ _id: CONV_ID, compradorId: TARGET_ID, anuncianteId: TARGET_ID, propiedadId: PROPERTY_ID }, "ambos_participantes_iguales"],
    [{ _id: CONV_ID, compradorId: OTHER_ID, anuncianteId: "507f1f77bcf86cd799439088", propiedadId: PROPERTY_ID }, "usuario_objetivo_no_participa"],
    [{ compradorId: TARGET_ID, anuncianteId: OTHER_ID, propiedadId: PROPERTY_ID }, "estructura_inconsistente"]
  ];

  for (const [conversacion, motivo] of cases) {
    const summary = await auditSingleTestUserChatData({
      env: chatAuditEnv(),
      models: chatAuditModels({ conversaciones: [conversacion] }).models
    });

    assert.equal(summary.bloqueadas, 1, motivo);
    assert.equal(summary.eliminablesConSeguridad, 0, motivo);
    assert.equal(summary.conversacionesAmbiguas, 1, motivo);
    assert.equal(summary.conversacionesAmbiguasPorMotivo[motivo], 1, motivo);
  }
});

test("auditoría chat bloquea participante desconocido y estado no booleano", async () => {
  const desconocido = await auditSingleTestUserChatData({
    env: chatAuditEnv(),
    models: chatAuditModels({ otherUsers: [] }).models
  });
  const estadoDesconocido = await auditSingleTestUserChatData({
    env: chatAuditEnv(),
    models: chatAuditModels({ otherUsers: [{ _id: OTHER_ID }] }).models
  });

  assert.equal(desconocido.bloqueadas, 1);
  assert.equal(desconocido.participantesDesconocidos, 1);
  assert.equal(desconocido.conversacionesConParticipanteNoResoluble, 1);
  assert.equal(desconocido.conversacionesAmbiguasPorMotivo.participante_no_encontrado, 1);
  assert.equal(desconocido.motivosBloqueo.includes("participante_desconocido"), true);
  assert.equal(estadoDesconocido.bloqueadas, 1);
  assert.equal(estadoDesconocido.conversacionesAmbiguasPorMotivo.combinacion_no_clasificada, 1);
  assert.equal(estadoDesconocido.motivosBloqueo.includes("estado_participante_desconocido"), true);
});

test("auditoría chat clasifica participante test activo, desactivado y no test", async () => {
  const testActivo = await auditSingleTestUserChatData({
    env: chatAuditEnv(),
    models: chatAuditModels({
      otherUsers: [{ _id: OTHER_ID, email: OTHER_TEST_EMAIL, role: "user", activo: true }],
      mensajes: [{ _id: "507f1f77bcf86cd799439111", conversacionId: CONV_ID, userId: TARGET_ID }]
    }).models
  });
  const testDesactivado = await auditSingleTestUserChatData({
    env: chatAuditEnv(),
    models: chatAuditModels({
      otherUsers: [{ _id: OTHER_ID, email: OTHER_TEST_EMAIL, role: "user", activo: false }],
      mensajes: [{ _id: "507f1f77bcf86cd799439112", conversacionId: CONV_ID, userId: TARGET_ID }]
    }).models
  });
  const noTest = await auditSingleTestUserChatData({
    env: chatAuditEnv(),
    models: chatAuditModels({
      otherUsers: [{ _id: OTHER_ID, email: NON_TEST_EMAIL, role: "user", activo: false }],
      mensajes: [{ _id: "507f1f77bcf86cd799439113", conversacionId: CONV_ID, userId: TARGET_ID }]
    }).models
  });

  assert.equal(testActivo.conversacionesConParticipanteTestActivo, 1);
  assert.equal(testActivo.conversacionesConOtroTestActivoNoAdmin, 1);
  assert.equal(testActivo.bloqueadas, 1);
  assert.equal(testDesactivado.conversacionesConParticipanteTestDesactivado, 1);
  assert.equal(testDesactivado.conversacionesConOtroTestDesactivado, 1);
  assert.equal(testDesactivado.eliminablesConSeguridad, 0);
  assert.equal(noTest.conversacionesConParticipanteNoTest, 1);
  assert.equal(noTest.todosLosParticipantesSonTest, false);
  assert.equal(noTest.existeRelacionConUsuarioReal, true);
  assert.equal(noTest.bloqueadas, 1);
  assert.equal(noTest.motivosBloqueo.includes("participante_no_test"), true);
});

test("auditoría chat distingue administrador de prueba activo y roles incoherentes", async () => {
  const adminActivo = await auditSingleTestUserChatData({
    env: chatAuditEnv(),
    models: chatAuditModels({
      otherUsers: [{ _id: OTHER_ID, email: ADMIN_TEST_EMAIL, role: "admin", activo: true }],
      mensajes: [{ _id: "507f1f77bcf86cd799439121", conversacionId: CONV_ID, userId: OTHER_ID }]
    }).models
  });
  const adminSinRole = await auditSingleTestUserChatData({
    env: chatAuditEnv(),
    models: chatAuditModels({
      otherUsers: [{ _id: OTHER_ID, email: ADMIN_TEST_EMAIL, activo: true }],
      mensajes: [{ _id: "507f1f77bcf86cd799439122", conversacionId: CONV_ID, userId: OTHER_ID }]
    }).models
  });
  const adminInesperado = await auditSingleTestUserChatData({
    env: chatAuditEnv(),
    models: chatAuditModels({
      otherUsers: [{ _id: OTHER_ID, email: OTHER_TEST_EMAIL, role: "admin", activo: false }],
      mensajes: [{ _id: "507f1f77bcf86cd799439123", conversacionId: CONV_ID, userId: OTHER_ID }]
    }).models
  });

  assert.equal(adminActivo.conversacionesConAdminTestActivo, 1);
  assert.equal(adminActivo.conversacionesAdminTestValidas, 1);
  assert.equal(adminActivo.conversacionesConOtroTestActivoNoAdmin, 0);
  assert.equal(adminActivo.candidataLimpiezaControladaFutura, true);
  assert.equal(adminSinRole.conversacionesAmbiguasPorMotivo.combinacion_no_clasificada, 1);
  assert.equal(adminSinRole.motivosBloqueo.includes("admin_test_role_incoherente"), true);
  assert.equal(adminInesperado.conversacionesAmbiguasPorMotivo.combinacion_no_clasificada, 1);
  assert.equal(adminInesperado.motivosBloqueo.includes("role_admin_inesperado"), true);
});

test("auditoría chat candidata futura exige solo cuentas test, sin propiedades reales ni relaciones inconsistentes", async () => {
  const valida = await auditSingleTestUserChatData({
    env: chatAuditEnv(),
    models: chatAuditModels({
      otherUsers: [{ _id: OTHER_ID, email: ADMIN_TEST_EMAIL, role: "admin", activo: true }],
      mensajes: [{ _id: "507f1f77bcf86cd799439124", conversacionId: CONV_ID, userId: TARGET_ID }]
    }).models
  });
  const usuarioReal = await auditSingleTestUserChatData({
    env: chatAuditEnv(),
    models: chatAuditModels({
      otherUsers: [{ _id: OTHER_ID, email: NON_TEST_EMAIL, role: "user", activo: false }],
      mensajes: [{ _id: "507f1f77bcf86cd799439125", conversacionId: CONV_ID, userId: TARGET_ID }]
    }).models
  });
  const propiedadReal = await auditSingleTestUserChatData({
    env: chatAuditEnv(),
    models: chatAuditModels({
      otherUsers: [{ _id: OTHER_ID, email: ADMIN_TEST_EMAIL, role: "admin", activo: true }],
      propiedades: [{ _id: PROPERTY_ID, visiblePublicamente: false }],
      mensajes: [{ _id: "507f1f77bcf86cd799439126", conversacionId: CONV_ID, userId: TARGET_ID }]
    }).models
  });

  assert.equal(valida.todosLosChatsPertenecenSoloACuentasTest, true);
  assert.equal(valida.existeRelacionConUsuarioReal, false);
  assert.equal(valida.existeRelacionConPropiedadReal, false);
  assert.equal(valida.candidataLimpiezaControladaFutura, true);
  assert.equal(usuarioReal.todosLosChatsPertenecenSoloACuentasTest, false);
  assert.equal(usuarioReal.existeRelacionConUsuarioReal, true);
  assert.equal(usuarioReal.conversacionesConRelacionesExternas, 1);
  assert.equal(usuarioReal.candidataLimpiezaControladaFutura, false);
  assert.equal(propiedadReal.existeRelacionConPropiedadReal, true);
  assert.equal(propiedadReal.conversacionesConRelacionesExternas, 1);
  assert.equal(propiedadReal.candidataLimpiezaControladaFutura, false);
});

test("auditoría chat bloquea propiedad ausente, inválida o desconocida", async () => {
  const cases = [
    [{ conversaciones: [{ _id: CONV_ID, compradorId: TARGET_ID, anuncianteId: OTHER_ID }] }, "propiedad_faltante"],
    [{ conversaciones: [{ _id: CONV_ID, compradorId: TARGET_ID, anuncianteId: OTHER_ID, propiedadId: "bad" }] }, "propiedad_invalida"],
    [{ failReads: { propiedades: true } }, "propiedad_desconocida"]
  ];

  for (const [config, motivo] of cases) {
    const summary = await auditSingleTestUserChatData({
      env: chatAuditEnv(),
      models: chatAuditModels(config).models
    });

    assert.equal(summary.bloqueadas, 1, motivo);
    assert.equal(summary.eliminablesConSeguridad, 0, motivo);
    assert.equal(summary.motivosBloqueo.includes(motivo), true, motivo);
    assert.equal(summary.conversacionesAmbiguasPorMotivo.propiedad_no_resoluble, 1, motivo);
  }
});

test("auditoría chat diagnostica nuevos motivos genéricos de ambigüedad", async () => {
  const outsideConversationId = "507f1f77bcf86cd799439127";
  const cases = [
    [
      { mensajes: [] },
      "conversacion_sin_mensajes"
    ],
    [
      { mensajes: [{ _id: "507f1f77bcf86cd799439128", conversacionId: outsideConversationId, userId: TARGET_ID }] },
      "mensaje_fuera_de_conversacion"
    ],
    [
      { mensajes: [{ _id: "507f1f77bcf86cd799439129", conversacionId: CONV_ID, userId: "507f1f77bcf86cd799439130" }] },
      "autor_no_es_participante"
    ],
    [
      {
        conversaciones: [
          { _id: CONV_ID, compradorId: TARGET_ID, anuncianteId: OTHER_ID, propiedadId: PROPERTY_ID },
          { _id: CONV_ID, compradorId: TARGET_ID, anuncianteId: "507f1f77bcf86cd799439131", propiedadId: PROPERTY_ID }
        ],
        mensajes: [{ _id: "507f1f77bcf86cd799439132", conversacionId: CONV_ID, userId: TARGET_ID }]
      },
      "duplicado_inconsistente"
    ],
    [
      {
        conversaciones: [{
          _id: CONV_ID,
          compradorId: TARGET_ID,
          anuncianteId: OTHER_ID,
          propiedadId: PROPERTY_ID,
          participantes: [TARGET_ID, OTHER_ID]
        }],
        mensajes: [{ _id: "507f1f77bcf86cd799439133", conversacionId: CONV_ID, userId: TARGET_ID }]
      },
      "campos_extra_incompatibles"
    ],
    [
      {
        failReads: { usuarios: true },
        mensajes: [{ _id: "507f1f77bcf86cd799439134", conversacionId: CONV_ID, userId: TARGET_ID }]
      },
      "resultado_consultas_incompleto"
    ],
    [
      {
        otherUsers: [{ _id: OTHER_ID, email: ADMIN_TEST_EMAIL, activo: true }],
        mensajes: [{ _id: "507f1f77bcf86cd799439135", conversacionId: CONV_ID, userId: TARGET_ID }]
      },
      "combinacion_no_clasificada"
    ]
  ];

  for (const [config, motivo] of cases) {
    const summary = await auditSingleTestUserChatData({
      env: chatAuditEnv(),
      models: chatAuditModels(config).models
    });

    assert.equal(summary.conversacionesAmbiguasPorMotivo[motivo] > 0, true, motivo);
    assert.equal(summary.candidataLimpiezaControladaFutura, false, motivo);
  }
});

test("auditoría chat deduplica conversaciones y mensajes", async () => {
  const summary = await auditSingleTestUserChatData({
    env: chatAuditEnv(),
    models: chatAuditModels({
      conversaciones: [
        { _id: CONV_ID, compradorId: TARGET_ID, anuncianteId: OTHER_ID, propiedadId: PROPERTY_ID },
        { _id: CONV_ID, compradorId: TARGET_ID, anuncianteId: OTHER_ID, propiedadId: PROPERTY_ID }
      ],
      mensajes: [
        { _id: "507f1f77bcf86cd799439111", conversacionId: CONV_ID, userId: TARGET_ID },
        { _id: "507f1f77bcf86cd799439111", conversacionId: CONV_ID, userId: TARGET_ID }
      ]
    }).models
  });

  assert.equal(summary.conversacionesTotales, 1);
  assert.equal(summary.mensajesTotales, 1);
  assert.equal(summary.mensajesPropios, 1);
  assert.equal(summary.eliminablesConSeguridad, 0);
  assert.equal(summary.candidataLimpiezaControladaFutura, true);
});

test("auditoría chat bloquea mensajes con autor ausente, inválido o no resoluble", async () => {
  const unknownAuthor = "507f1f77bcf86cd799439123";
  const cases = [
    [{ mensajes: [{ _id: "507f1f77bcf86cd799439111", conversacionId: CONV_ID }] }, "autor_mensaje_desconocido"],
    [{ mensajes: [{ _id: "507f1f77bcf86cd799439112", conversacionId: CONV_ID, userId: "bad" }] }, "autor_mensaje_desconocido"],
    [{ mensajes: [{ _id: "507f1f77bcf86cd799439113", conversacionId: CONV_ID, userId: unknownAuthor }] }, "autor_no_es_participante"]
  ];

  for (const [config, motivo] of cases) {
    const summary = await auditSingleTestUserChatData({
      env: chatAuditEnv(),
      models: chatAuditModels(config).models
    });

    assert.equal(summary.bloqueadas, 1, motivo);
    assert.equal(summary.eliminablesConSeguridad, 0, motivo);
    assert.equal(summary.motivosBloqueo.includes(motivo), true, motivo);
  }
});

test("auditoría chat bloquea ante fallos parciales sin exponer errores crudos", async () => {
  const summary = await auditSingleTestUserChatData({
    env: chatAuditEnv(),
    models: chatAuditModels({
      failReads: { usuarios: true, mensajes: true }
    }).models
  });
  const output = JSON.stringify(summary);

  assert.equal(summary.bloqueadas, 1);
  assert.equal(summary.motivosBloqueo.includes("participante_desconocido"), true);
  assert.equal(summary.motivosBloqueo.includes("mensajes_desconocidos"), true);
  assert.equal(summary.todosLosParticipantesSonTest, false);
  assert.doesNotMatch(output, /db detail|private data|507f1f77bcf86cd799439077/);
});

test("auditoría chat solo declara eliminable con todos los datos válidos", async () => {
  const summary = await auditSingleTestUserChatData({
    env: chatAuditEnv(),
    models: chatAuditModels({
      otherUsers: [{ _id: OTHER_ID, email: OTHER_TEST_EMAIL, activo: false }],
      propiedades: [],
      mensajes: [
        { _id: "507f1f77bcf86cd799439111", conversacionId: CONV_ID, userId: TARGET_ID },
        { _id: "507f1f77bcf86cd799439112", conversacionId: CONV_ID, userId: OTHER_ID }
      ]
    }).models
  });

  assert.equal(summary.eliminablesConSeguridad, 0);
  assert.equal(summary.bloqueadas, 0);
  assert.equal(summary.todosLosParticipantesSonTest, true);
  assert.equal(summary.candidataLimpiezaControladaFutura, true);
  assert.equal(summary.conversacionesAmbiguas, 0);
  assert.equal(summary.mensajesPropios, 1);
  assert.equal(summary.mensajesDeOtros, 1);
});

test("auditoría chat protege función core ante apply directo", async () => {
  for (const params of [
    { apply: true },
    { apply: true, confirm: "MAL" },
    { apply: true, confirm: "CLEAR_ONE_DISABLED_TEST_USER_CHAT" }
  ]) {
    const { models, state } = chatAuditModels();
    const summary = await auditSingleTestUserChatData({
      env: chatAuditEnv(),
      models,
      ...params
    });

    assert.equal(summary.aplicariaCambios, false);
    assert.deepEqual(state.writes, []);
  }
});

test("auditoría chat cierra conexión en finally con dependencias mock", async () => {
  const calls = [];
  const code = await runSingleTestUserChatAuditCli({
    env: chatAuditEnv(),
    argv: ["node", "script"],
    stdout: () => {},
    stderr: () => {},
    mongooseClient: {
      async connect() { calls.push("connect"); },
      async disconnect() { calls.push("disconnect"); }
    },
    models: chatAuditModels({ conversaciones: [] }).models
  });

  assert.equal(code, 0);
  assert.deepEqual(calls, ["connect", "disconnect"]);
});

test("auditoría chat no expone datos personales, IDs ni textos", async () => {
  const summary = await auditSingleTestUserChatData({
    env: chatAuditEnv(),
    models: chatAuditModels({
      targetUser: { _id: TARGET_ID, email: TARGET_EMAIL, activo: false, nombre: "Sonia" },
      otherUsers: [{ _id: OTHER_ID, email: OTHER_TEST_EMAIL, activo: false, nombre: "Otra" }],
      mensajes: [{ conversacionId: CONV_ID, userId: TARGET_ID, texto: "mensaje privado" }]
    }).models
  });
  const output = JSON.stringify(summary);

  assert.doesNotMatch(output, /sonygr@gmail\.com|sogoro0705@gmail\.com|Sonia|Otra|mensaje privado/);
  assert.doesNotMatch(output, new RegExp(`${TARGET_ID}|${OTHER_ID}|${PROPERTY_ID}|${CONV_ID}`));
});

test("script de auditoría chat no contiene escrituras, Stripe ni Cloudinary", () => {
  const source = fs.readFileSync(new URL("../scripts/clear-single-test-user-chat-data.js", import.meta.url), "utf8");

  assert.doesNotMatch(source, /from "stripe"|from 'stripe'|new Stripe|stripe\./);
  assert.doesNotMatch(source, /cloudinary|destroyImagesByUrls/);
  assert.doesNotMatch(source, /Resend|sendMail|emails\.send/);
  assert.doesNotMatch(source, /\.save\(|\.update\(|\.updateOne\(|\.updateMany\(|\.bulkWrite\(|\.delete\(|\.deleteOne\(|\.deleteMany\(|findOneAndDelete|findByIdAndDelete|\.insert\(|\.create\(/);
});
