import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  applyPendingPlanChanges,
  resetPendingPlanChangesSchedulerForTests,
  schedulePendingPlanChanges
} from "../utils/planChanges.js";
import {
  evaluarExpiracionPlanManual,
  MANUAL_EXPIRABLE_PLAN_IDS,
  processManualPlanExpirations,
  resetManualPlanExpirationsSchedulerForTests,
  scheduleManualPlanExpirations
} from "../utils/manualPlanExpirations.js";
import { envFlagEnabled } from "../utils/envFlags.js";
import {
  auditPendingPlanChanges,
  validateCli as validatePendingPlanAuditCli
} from "../scripts/audit-pending-plan-changes.js";
import {
  repairSinglePlanSync,
  runCli as runSinglePlanSyncCli,
  validateCli as validateSinglePlanSyncCli
} from "../scripts/repair-single-plan-sync.js";
import {
  clearStaleTestSubscription,
  runCli as runClearStaleTestSubscriptionCli,
  validateCli as validateClearStaleTestSubscriptionCli
} from "../scripts/clear-stale-test-subscription.js";

process.env.STRIPE_PRICE_BASICO = "price_basico";
process.env.STRIPE_PRICE_DESTACADO = "price_destacado";
process.env.STRIPE_PRICE_STARTER = "price_starter";
process.env.STRIPE_PRICE_PRO_AGENTES = "price_pro_agentes";
process.env.STRIPE_PRICE_AGENCIA_BASICA = "price_agencia_basica";

function usuarioMock(data) {
  return {
    _id: { toString: () => data._id || "user_mock" },
    saved: 0,
    ...data,
    async save() {
      this.saved += 1;
      return this;
    }
  };
}

function loggerMock() {
  return {
    infos: [],
    warnings: [],
    errors: [],
    info(...args) { this.infos.push(args); },
    warn(...args) { this.warnings.push(args); },
    error(...args) { this.errors.push(args); }
  };
}

function pendingCandidate(data = {}) {
  return {
    plan: "agencia_basica",
    planActivo: true,
    planFechaFin: new Date("2026-08-05T00:00:00.000Z"),
    pendingPlan: "basico",
    pendingPlanLabel: "Básico",
    pendingPriceId: "price_basico",
    pendingPlanChangeAt: new Date("2026-07-01T00:00:00.000Z"),
    stripeCustomerId: "cus_secret_123",
    stripeSubscriptionId: "sub_secret_123",
    subscriptionStatus: "active",
    cancelAtPeriodEnd: false,
    subscriptionCancelAt: null,
    nombre: "Persona Privada",
    email: "privada@example.com",
    numDoc: "12345678Z",
    telefono: "600000000",
    direccion: "Calle Privada",
    _id: "507f1f77bcf86cd799439011",
    ...data
  };
}

function UsuarioModelForPendingAudit(candidatos, onFind = () => {}) {
  return {
    find(query, projection) {
      onFind(query, projection);
      return {
        async lean() {
          return candidatos;
        }
      };
    }
  };
}

function stripeRetrieveMock(resultOrError) {
  const calls = [];
  return {
    calls,
    subscriptions: {
      async retrieve(subscriptionId) {
        calls.push(subscriptionId);
        if (resultOrError instanceof Error) throw resultOrError;
        return resultOrError;
      }
    }
  };
}

function repairEnv(overrides = {}) {
  return {
    REPAIR_SINGLE_PLAN_SYNC: "true",
    MONGODB_URI: "mongodb://example/test",
    TARGET_USER_ID: "507f1f77bcf86cd799439011",
    EXPECTED_CURRENT_PLAN: "agencia_basica",
    EXPECTED_PENDING_PLAN: "basico",
    TARGET_PLAN: "basico",
    EXPECTED_SUBSCRIPTION_STATUS: "active",
    ...overrides
  };
}

function repairCandidate(data = {}) {
  return {
    plan: "agencia_basica",
    planActivo: true,
    planFechaFin: new Date("2026-09-01T00:00:00.000Z"),
    pendingPlan: "basico",
    pendingPlanLabel: "Básico",
    pendingPriceId: "price_basico",
    pendingPlanChangeAt: new Date("2026-07-01T00:00:00.000Z"),
    stripeCustomerId: "cus_secret_123",
    stripeSubscriptionId: "sub_secret_123",
    subscriptionStatus: "active",
    cancelAtPeriodEnd: false,
    subscriptionCancelAt: null,
    nombre: "Persona Privada",
    email: "privada@example.com",
    numDoc: "12345678Z",
    ...data
  };
}

function SingleRepairModel(initialUsers, { updateMatches = true, onFind = () => {}, onUpdate = () => {} } = {}) {
  const state = { users: [...initialUsers], findCalls: [], updates: [] };
  return {
    state,
    find(query, projection) {
      state.findCalls.push({ query, projection });
      onFind(query, projection);
      return {
        limit(value) {
          state.limit = value;
          return this;
        },
        async lean() {
          return state.users;
        }
      };
    },
    async findOneAndUpdate(query, update, options) {
      state.updates.push({ query, update, options });
      onUpdate(query, update, options);
      if (!updateMatches) return null;
      const user = state.users[0];
      if (!user) return null;
      Object.assign(user, update.$set);
      delete user.pendingPlan;
      delete user.pendingPriceId;
      delete user.pendingPlanChangeAt;
      delete user.pendingPlanLabel;
      return user;
    }
  };
}

function staleCleanupEnv(overrides = {}) {
  return {
    CLEAR_STALE_TEST_SUBSCRIPTION: "true",
    MONGODB_URI: "mongodb://example/test",
    TARGET_USER_ID: "507f1f77bcf86cd799439022",
    TARGET_EMAIL: "test.disabled@example.com",
    EXPECTED_ACTIVE: "false",
    EXPECTED_CURRENT_PLAN: "agencia_basica",
    EXPECTED_PENDING_PLAN: "basico",
    ...overrides
  };
}

function staleCleanupCandidate(data = {}) {
  return {
    _id: "507f1f77bcf86cd799439022",
    nombre: "Usuario de Prueba",
    email: "test.disabled@example.com",
    activo: false,
    plan: "agencia_basica",
    planActivo: false,
    planFechaFin: new Date("2026-07-01T00:00:00.000Z"),
    pendingPlan: "basico",
    pendingPlanLabel: "Básico",
    pendingPriceId: "price_basico",
    pendingPlanChangeAt: new Date("2026-07-15T00:00:00.000Z"),
    stripeCustomerId: "cus_old_test_secret",
    stripeSubscriptionId: "sub_old_test_secret",
    subscriptionStatus: undefined,
    cancelAtPeriodEnd: false,
    subscriptionCancelAt: null,
    favoritos: ["prop_1"],
    trialAccepted: true,
    launchPromoApplied: true,
    ...data
  };
}

function StaleCleanupModel(initialUsers, { updateMatches = true, onFind = () => {}, onUpdate = () => {} } = {}) {
  const state = { users: [...initialUsers], findCalls: [], updates: [] };
  return {
    state,
    find(query, projection) {
      state.findCalls.push({ query, projection });
      onFind(query, projection);
      return {
        limit(value) {
          state.limit = value;
          return this;
        },
        async lean() {
          return state.users;
        }
      };
    },
    async findOneAndUpdate(query, update, options) {
      state.updates.push({ query, update, options });
      onUpdate(query, update, options);
      if (!updateMatches) return null;
      const user = state.users[0];
      if (!user) return null;
      for (const field of Object.keys(update.$unset || {})) {
        delete user[field];
      }
      return user;
    }
  };
}

test("server registra los schedulers de cambios programados y expiraciones manuales tras MongoDB", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

  assert.match(server, /import \{ schedulePendingPlanChanges \} from "\.\/utils\/planChanges\.js"/);
  assert.match(server, /import \{ scheduleManualPlanExpirations \} from "\.\/utils\/manualPlanExpirations\.js"/);
  assert.match(server, /MongoDB conectado[\s\S]*scheduleVipTrialExpiration\(\);/);
  assert.match(server, /envFlagEnabled\("ENABLE_PENDING_PLAN_CHANGES"\)[\s\S]*schedulePendingPlanChanges\(\)/);
  assert.match(server, /envFlagEnabled\("ENABLE_MANUAL_PLAN_EXPIRATIONS"\)[\s\S]*scheduleManualPlanExpirations\(\)/);
  assert.match(server, /Cambios de plan programados desactivados por configuración/);
  assert.match(server, /Expiraciones de planes manuales desactivadas por configuración/);
});

test("feature flags solo aceptan la cadena exacta true", () => {
  assert.equal(envFlagEnabled("MISSING", {}), false);
  assert.equal(envFlagEnabled("FLAG", { FLAG: "" }), false);
  assert.equal(envFlagEnabled("FLAG", { FLAG: "true" }), true);
  assert.equal(envFlagEnabled("FLAG", { FLAG: "TRUE" }), false);
  assert.equal(envFlagEnabled("FLAG", { FLAG: "1" }), false);
  assert.equal(envFlagEnabled("FLAG", { FLAG: "yes" }), false);
});

test("schedulers evitan doble registro accidental", () => {
  resetPendingPlanChangesSchedulerForTests();
  resetManualPlanExpirationsSchedulerForTests();
  let pendingIntervals = 0;
  let manualIntervals = 0;
  const noopProcessor = async () => ({ candidatos: 0, aplicados: 0, omitidos: 0, errores: 0, cambios: [] });

  const pendingA = schedulePendingPlanChanges({
    processor: noopProcessor,
    logger: loggerMock(),
    setIntervalFn: () => {
      pendingIntervals += 1;
      return { id: "pending" };
    }
  });
  const pendingB = schedulePendingPlanChanges({
    processor: noopProcessor,
    logger: loggerMock(),
    setIntervalFn: () => {
      pendingIntervals += 1;
      return { id: "pending-2" };
    }
  });

  const manualA = scheduleManualPlanExpirations({
    processor: noopProcessor,
    logger: loggerMock(),
    setIntervalFn: () => {
      manualIntervals += 1;
      return { id: "manual" };
    }
  });
  const manualB = scheduleManualPlanExpirations({
    processor: noopProcessor,
    logger: loggerMock(),
    setIntervalFn: () => {
      manualIntervals += 1;
      return { id: "manual-2" };
    }
  });

  assert.equal(pendingA, pendingB);
  assert.equal(manualA, manualB);
  assert.equal(pendingIntervals, 1);
  assert.equal(manualIntervals, 1);
  resetPendingPlanChangesSchedulerForTests();
  resetManualPlanExpirationsSchedulerForTests();
});

test("cambio programado se aplica una sola vez y limpia pending fields", async () => {
  const now = new Date("2026-08-05T00:00:00.000Z");
  const usuario = usuarioMock({
    _id: "user_apply",
    plan: "agencia_basica",
    pendingPlan: "basico",
    pendingPriceId: "price_basico",
    pendingPlanChangeAt: new Date("2026-07-04T00:00:00.000Z"),
    stripeSubscriptionId: "sub_123"
  });
  const UsuarioModel = {
    async find() { return [usuario]; },
    async exists() { return true; },
    async findOneAndUpdate(query, update) {
      assert.equal(query.pendingPlan, "basico");
      Object.assign(usuario, update.$set);
      return usuario;
    }
  };
  const stripeClient = {
    subscriptions: {
      async retrieve(id) {
        assert.equal(id, "sub_123");
        return { status: "active", items: { data: [{ id: "si_123" }] } };
      },
      async update(id, params) {
        assert.equal(id, "sub_123");
        assert.equal(params.items[0].price, "price_basico");
        return { current_period_end: 1785888000, items: { data: [] } };
      }
    }
  };

  const resumen = await applyPendingPlanChanges(now, { UsuarioModel, stripeClient, logger: loggerMock() });

  assert.deepEqual({ candidatos: resumen.candidatos, aplicados: resumen.aplicados, omitidos: resumen.omitidos, errores: resumen.errores }, {
    candidatos: 1,
    aplicados: 1,
    omitidos: 0,
    errores: 0
  });
  assert.equal(usuario.plan, "basico");
  assert.equal(usuario.planActivo, true);
  assert.equal(usuario.pendingPlan, null);
  assert.equal(usuario.pendingPriceId, null);
  assert.equal(usuario.pendingPlanChangeAt, null);
});

test("cambio programado ya aplicado por webhook no llama a Stripe y limpia pending", async () => {
  const usuario = usuarioMock({
    plan: "basico",
    pendingPlan: "basico",
    pendingPriceId: "price_basico",
    pendingPlanChangeAt: new Date("2026-07-04T00:00:00.000Z"),
    stripeSubscriptionId: "sub_123"
  });
  const stripeClient = {
    subscriptions: {
      async retrieve() {
        throw new Error("no debe llamar a Stripe");
      }
    }
  };

  const resumen = await applyPendingPlanChanges(new Date("2026-08-05T00:00:00.000Z"), {
    UsuarioModel: { async find() { return [usuario]; } },
    stripeClient,
    logger: loggerMock()
  });

  assert.equal(resumen.omitidos, 1);
  assert.equal(usuario.saved, 1);
  assert.equal(usuario.pendingPlan, null);
});

test("si Stripe falla se conservan los campos pending", async () => {
  const usuario = usuarioMock({
    plan: "agencia_basica",
    pendingPlan: "basico",
    pendingPriceId: "price_basico",
    pendingPlanChangeAt: new Date("2026-07-04T00:00:00.000Z"),
    stripeSubscriptionId: "sub_123"
  });
  const log = loggerMock();
  const resumen = await applyPendingPlanChanges(new Date("2026-08-05T00:00:00.000Z"), {
    UsuarioModel: { async find() { return [usuario]; }, async exists() { return true; } },
    stripeClient: {
      subscriptions: {
        async retrieve() {
          throw new Error("stripe down");
        }
      }
    },
    logger: log
  });

  assert.equal(resumen.errores, 1);
  assert.equal(usuario.pendingPlan, "basico");
  assert.equal(usuario.pendingPriceId, "price_basico");
  assert.equal(usuario.saved, 0);
  assert.equal(log.errors.length, 1);
  assert.doesNotMatch(JSON.stringify(log.errors), /user_mock|user_|sub_123|price_basico/);
});

test("planChanges revalida estado local antes de llamar a Stripe", async () => {
  const usuario = usuarioMock({
    plan: "agencia_basica",
    pendingPlan: "basico",
    pendingPriceId: "price_basico",
    pendingPlanChangeAt: new Date("2026-07-04T00:00:00.000Z"),
    stripeSubscriptionId: "sub_123"
  });
  const resumen = await applyPendingPlanChanges(new Date("2026-08-05T00:00:00.000Z"), {
    UsuarioModel: { async find() { return [usuario]; }, async exists() { return false; } },
    stripeClient: {
      subscriptions: {
        async retrieve() {
          throw new Error("no debe llamar a Stripe");
        }
      }
    },
    logger: loggerMock()
  });

  assert.equal(resumen.omitidos, 1);
  assert.equal(resumen.aplicados, 0);
});

test("planChanges omite estados Stripe incompatibles y múltiples items", async () => {
  const base = {
    plan: "agencia_basica",
    pendingPlan: "basico",
    pendingPriceId: "price_basico",
    pendingPlanChangeAt: new Date("2026-07-04T00:00:00.000Z"),
    stripeSubscriptionId: "sub_123"
  };
  const incompatible = await applyPendingPlanChanges(new Date("2026-08-05T00:00:00.000Z"), {
    UsuarioModel: { async find() { return [usuarioMock(base)]; }, async exists() { return true; } },
    stripeClient: { subscriptions: { async retrieve() { return { status: "paused", items: { data: [{ id: "si_1" }] } }; } } },
    logger: loggerMock()
  });
  const multipleItems = await applyPendingPlanChanges(new Date("2026-08-05T00:00:00.000Z"), {
    UsuarioModel: { async find() { return [usuarioMock(base)]; }, async exists() { return true; } },
    stripeClient: { subscriptions: { async retrieve() { return { status: "active", items: { data: [{ id: "si_1" }, { id: "si_2" }] } }; } } },
    logger: loggerMock()
  });

  assert.equal(incompatible.omitidos, 1);
  assert.equal(multipleItems.omitidos, 1);
});

test("vip manual vencido pasa a gratis y aplica límites sin borrar anuncios", async () => {
  const usuario = usuarioMock({
    plan: "vip",
    planActivo: true,
    planFechaFin: new Date("2026-05-10T00:00:00.000Z")
  });
  let limitesAplicados = 0;
  const resumen = await processManualPlanExpirations(new Date("2026-08-05T00:00:00.000Z"), {
    usuarios: [usuario],
    UsuarioModel: {},
    apply: true,
    applyFreePlanLimits: async () => { limitesAplicados += 1; },
    logger: loggerMock()
  });

  assert.equal(resumen.aplicados, 1);
  assert.equal(limitesAplicados, 1);
  assert.equal(usuario.plan, "gratis");
  assert.equal(usuario.planActivo, false);
  assert.equal(usuario.planFechaFin, null);
  assert.deepEqual(resumen.cambios[0].before.plan, "vip");
});

test("vip manual futuro no cambia", async () => {
  const usuario = usuarioMock({
    plan: "vip",
    planActivo: true,
    planFechaFin: new Date("2026-09-10T00:00:00.000Z")
  });
  const resumen = await processManualPlanExpirations(new Date("2026-08-05T00:00:00.000Z"), {
    usuarios: [usuario],
    logger: loggerMock()
  });

  assert.equal(resumen.aplicados, 0);
  assert.equal(resumen.omitidos, 1);
  assert.equal(usuario.plan, "vip");
});

test("plan manual con Stripe se omite", async () => {
  const usuario = usuarioMock({
    plan: "vip",
    planActivo: true,
    planFechaFin: new Date("2026-05-10T00:00:00.000Z"),
    stripeSubscriptionId: "sub_123"
  });
  const evaluacion = evaluarExpiracionPlanManual(usuario, new Date("2026-08-05T00:00:00.000Z"));

  assert.equal(evaluacion.accion, "omitir");
  assert.equal(evaluacion.reason, "stripe_subscription");
});

test("vip_trial se excluye del procesador manual", async () => {
  const usuario = usuarioMock({
    plan: "vip_trial",
    planActivo: true,
    planFechaFin: new Date("2026-05-10T00:00:00.000Z")
  });
  const evaluacion = evaluarExpiracionPlanManual(usuario, new Date("2026-08-05T00:00:00.000Z"));

  assert.equal(evaluacion.accion, "omitir");
  assert.equal(evaluacion.reason, "vip_trial");
});

test("plan desconocido genera alerta sin cambios", async () => {
  const usuario = usuarioMock({
    plan: "inventado",
    planActivo: true,
    planFechaFin: new Date("2026-05-10T00:00:00.000Z")
  });
  const log = loggerMock();
  const resumen = await processManualPlanExpirations(new Date("2026-08-05T00:00:00.000Z"), {
    usuarios: [usuario],
    logger: log
  });

  assert.equal(resumen.alertas, 1);
  assert.equal(resumen.aplicados, 0);
  assert.equal(usuario.plan, "inventado");
  assert.equal(log.warnings.length, 1);
});

test("detector manual no escribe y apply por defecto es false", async () => {
  const usuario = usuarioMock({
    plan: "vip",
    planActivo: true,
    planFechaFin: new Date("2026-05-10T00:00:00.000Z")
  });
  const resumen = await processManualPlanExpirations(new Date("2026-08-05T00:00:00.000Z"), {
    usuarios: [usuario],
    logger: loggerMock()
  });

  assert.equal(resumen.aplicados, 0);
  assert.equal(resumen.omitidos, 1);
  assert.equal(usuario.saved, 0);
  assert.equal(usuario.plan, "vip");
});

test("solo vip y agencia_pro son planes manuales procesables", () => {
  assert.deepEqual([...MANUAL_EXPIRABLE_PLAN_IDS], ["vip", "agencia_pro"]);
  for (const plan of ["basico", "destacado", "starter", "pro_agentes", "agencia_basica"]) {
    const evaluacion = evaluarExpiracionPlanManual({
      plan,
      planActivo: true,
      planFechaFin: new Date("2026-05-10T00:00:00.000Z")
    }, new Date("2026-08-05T00:00:00.000Z"));
    assert.equal(evaluacion.accion, "omitir", plan);
    assert.equal(evaluacion.reason, "manual_plan_not_enabled", plan);
  }
});

test("/usuarios/me no escribe con read repair apagado y devuelve señales calculadas", () => {
  const usuariosRoute = fs.readFileSync(new URL("../routes/usuarios.js", import.meta.url), "utf8");
  const perfil = fs.readFileSync(new URL("../public/perfil.html", import.meta.url), "utf8");

  assert.match(usuariosRoute, /envFlagEnabled\("ENABLE_PLAN_READ_REPAIR"\)/);
  assert.match(usuariosRoute, /processManualPlanExpirations/);
  assert.match(usuariosRoute, /planDateExpired/);
  assert.match(usuariosRoute, /pendingPlanChangeOverdue/);
  assert.match(usuariosRoute, /stripePlanSyncPending/);
  assert.match(usuariosRoute, /apply: true/);
  assert.match(perfil, /La fecha registrada de este plan ya ha vencido/);
  assert.match(perfil, /Hay un cambio de plan pendiente de actualización/);
  assert.match(perfil, /La suscripción está pendiente de sincronización/);
});

test("auditoría real es solo lectura y requiere flag explícito", () => {
  const audit = fs.readFileSync(new URL("../scripts/audit-plan-expirations.js", import.meta.url), "utf8");
  const dryRun = fs.readFileSync(new URL("../scripts/plan-expirations-dry-run.js", import.meta.url), "utf8");

  assert.match(audit, /AUDIT_PLAN_EXPIRATIONS !== "true"/);
  assert.match(audit, /MONGODB_URI/);
  assert.doesNotMatch(audit, /from "stripe"|from 'stripe'/);
  assert.doesNotMatch(audit, /\.save\(|\.update\(|delete|bulkWrite|findOneAndUpdate/);
  assert.match(audit, /soloLectura: true/);
  assert.match(dryRun, /tipo: "simulacion_local"/);
  assert.match(dryRun, /auditoriaProduccion: false/);
});

test("auditoría de cambios pendientes valida flag exacta, MongoDB URI y argumentos", () => {
  assert.deepEqual(
    validatePendingPlanAuditCli({ env: {}, argv: ["node", "script"] }),
    { ok: false, code: 1, message: "AUDIT_PENDING_PLAN_CHANGES debe ser exactamente true." }
  );
  assert.deepEqual(
    validatePendingPlanAuditCli({ env: { AUDIT_PENDING_PLAN_CHANGES: "TRUE", MONGODB_URI: "mongodb://example/test" }, argv: ["node", "script"] }),
    { ok: false, code: 1, message: "AUDIT_PENDING_PLAN_CHANGES debe ser exactamente true." }
  );
  assert.deepEqual(
    validatePendingPlanAuditCli({ env: { AUDIT_PENDING_PLAN_CHANGES: "true" }, argv: ["node", "script"] }),
    { ok: false, code: 1, message: "Falta MONGODB_URI." }
  );
  assert.deepEqual(
    validatePendingPlanAuditCli({ env: { AUDIT_PENDING_PLAN_CHANGES: "true", MONGODB_URI: "mongodb://example/test" }, argv: ["node", "script", "--apply"] }),
    { ok: false, code: 1, message: "Esta auditoría no acepta argumentos ni opciones." }
  );
  assert.deepEqual(
    validatePendingPlanAuditCli({ env: { AUDIT_PENDING_PLAN_CHANGES: "true", MONGODB_URI: "mongodb://example/test" }, argv: ["node", "script"] }),
    { ok: true }
  );
});

test("auditoría de cambios pendientes consulta solo candidatos vencidos y proyecta campos mínimos", async () => {
  let queryReceived = null;
  let projectionReceived = null;
  await auditPendingPlanChanges({
    now: new Date("2026-08-05T00:00:00.000Z"),
    stripeSecretKey: "",
    UsuarioModel: UsuarioModelForPendingAudit([], (query, projection) => {
      queryReceived = query;
      projectionReceived = projection;
    })
  });

  assert.deepEqual(queryReceived.pendingPlan, { $exists: true, $nin: [null, ""] });
  assert.deepEqual(queryReceived.pendingPriceId, { $exists: true, $nin: [null, ""] });
  assert.deepEqual(queryReceived.stripeSubscriptionId, { $exists: true, $nin: [null, ""] });
  assert.deepEqual(queryReceived.pendingPlanChangeAt, { $lte: new Date("2026-08-05T00:00:00.000Z") });
  for (const field of [
    "plan",
    "planActivo",
    "planFechaFin",
    "pendingPlan",
    "pendingPlanLabel",
    "pendingPriceId",
    "pendingPlanChangeAt",
    "stripeCustomerId",
    "stripeSubscriptionId",
    "subscriptionStatus",
    "cancelAtPeriodEnd",
    "subscriptionCancelAt"
  ]) {
    assert.equal(projectionReceived[field], 1, field);
  }
});

test("auditoría de cambios pendientes funciona sin Stripe y no intenta consultar", async () => {
  const summary = await auditPendingPlanChanges({
    now: new Date("2026-08-05T00:00:00.000Z"),
    stripeSecretKey: "",
    UsuarioModel: UsuarioModelForPendingAudit([pendingCandidate()])
  });

  assert.equal(summary.stripeDisponible, false);
  assert.equal(summary.totalCandidatos, 1);
  assert.equal(summary.stripeConsultadas, 0);
  assert.equal(summary.comprobacionStripePendiente, 1);
  assert.equal(summary.candidatosBloqueados, 1);
  assert.equal(summary.casos[0].caso, 1);
  assert.equal(summary.casos[0].clasificacion, "bloqueado");
});

test("auditoría clasifica candidato coherente active con un item como aplicable", async () => {
  const stripe = stripeRetrieveMock({
    status: "active",
    cancel_at_period_end: false,
    items: { data: [{ price: { id: "price_agencia_basica" } }] }
  });

  const summary = await auditPendingPlanChanges({
    now: new Date("2026-08-05T00:00:00.000Z"),
    UsuarioModel: UsuarioModelForPendingAudit([pendingCandidate()]),
    stripeClient: stripe
  });

  assert.equal(stripe.calls.length, 1);
  assert.equal(summary.stripeEstadoActive, 1);
  assert.equal(summary.stripeConUnItem, 1);
  assert.equal(summary.stripePriceActualCoincideConPlanActual, 1);
  assert.equal(summary.candidatosAplicables, 1);
  assert.equal(summary.casos[0].clasificacion, "aplicable");
  assert.equal(summary.casos[0].priceActualRepresentaPlanActual, true);
});

test("auditoría acepta Stripe trialing con un item como aplicable", async () => {
  const stripe = stripeRetrieveMock({
    status: "trialing",
    items: { data: [{ price: { id: "price_agencia_basica" } }] }
  });

  const summary = await auditPendingPlanChanges({
    now: new Date("2026-08-05T00:00:00.000Z"),
    UsuarioModel: UsuarioModelForPendingAudit([pendingCandidate()]),
    stripeClient: stripe
  });

  assert.equal(summary.stripeEstadoTrialing, 1);
  assert.equal(summary.candidatosAplicables, 1);
});

test("auditoría marca incoherente pendingPlan inválido o price no correspondiente", async () => {
  const stripe = stripeRetrieveMock({
    status: "active",
    items: { data: [{ price: { id: "price_agencia_basica" } }] }
  });
  const summary = await auditPendingPlanChanges({
    now: new Date("2026-08-05T00:00:00.000Z"),
    UsuarioModel: UsuarioModelForPendingAudit([
      pendingCandidate({ pendingPlan: "inventado", pendingPriceId: "price_inventado" }),
      pendingCandidate({ pendingPlan: "basico", pendingPriceId: "price_destacado" })
    ]),
    stripeClient: stripe
  });

  assert.equal(summary.pendingPlanInvalido, 1);
  assert.equal(summary.pendingPriceNoConfigurado, 2);
  assert.equal(summary.inconsistenciasMongoStripe, 2);
  assert.equal(summary.casos[0].pendienteCoherente, false);
  assert.equal(summary.casos[1].pendienteCoherente, false);
});

test("auditoría bloquea suscripción no encontrada, canceled, past_due y múltiples items", async () => {
  const missing = new Error("missing");
  missing.code = "resource_missing";
  const scenarios = [
    stripeRetrieveMock(missing),
    stripeRetrieveMock({ status: "canceled", items: { data: [{ price: { id: "price_agencia_basica" } }] } }),
    stripeRetrieveMock({ status: "past_due", items: { data: [{ price: { id: "price_agencia_basica" } }] } }),
    stripeRetrieveMock({ status: "active", items: { data: [{ price: { id: "price_agencia_basica" } }, { price: { id: "price_basico" } }] } })
  ];

  const results = [];
  for (const stripe of scenarios) {
    results.push(await auditPendingPlanChanges({
      now: new Date("2026-08-05T00:00:00.000Z"),
      UsuarioModel: UsuarioModelForPendingAudit([pendingCandidate()]),
      stripeClient: stripe
    }));
  }

  assert.equal(results[0].stripeNoEncontradas, 1);
  assert.equal(results[1].stripeEstadoIncompatible, 1);
  assert.equal(results[2].stripeEstadoIncompatible, 1);
  assert.equal(results[3].stripeConMultiplesItems, 1);
  for (const summary of results) {
    assert.equal(summary.candidatosBloqueados, 1);
    assert.equal(summary.casos[0].clasificacion, "bloqueado");
  }
});

test("auditoría detecta Stripe ya aplicado al price pendiente", async () => {
  const summary = await auditPendingPlanChanges({
    now: new Date("2026-08-05T00:00:00.000Z"),
    UsuarioModel: UsuarioModelForPendingAudit([pendingCandidate()]),
    stripeClient: stripeRetrieveMock({
      status: "active",
      items: { data: [{ price: { id: "price_basico" } }] }
    })
  });

  assert.equal(summary.stripePriceActualYaCoincideConPlanPendiente, 1);
  assert.equal(summary.candidatosYaAplicadosEnStripe, 1);
  assert.equal(summary.casos[0].clasificacion, "ya_aplicado_en_stripe");
});

test("auditoría detecta price actual desconocido como inconsistente", async () => {
  const summary = await auditPendingPlanChanges({
    now: new Date("2026-08-05T00:00:00.000Z"),
    UsuarioModel: UsuarioModelForPendingAudit([pendingCandidate()]),
    stripeClient: stripeRetrieveMock({
      status: "active",
      items: { data: [{ price: { id: "price_unknown" } }] }
    })
  });

  assert.equal(summary.stripePriceActualNoReconocido, 1);
  assert.equal(summary.inconsistenciasMongoStripe, 1);
  assert.equal(summary.casos[0].clasificacion, "inconsistente");
});

test("auditoría de cambios pendientes no expone IDs ni datos personales", async () => {
  const summary = await auditPendingPlanChanges({
    now: new Date("2026-08-05T00:00:00.000Z"),
    UsuarioModel: UsuarioModelForPendingAudit([pendingCandidate()]),
    stripeClient: stripeRetrieveMock({
      status: "active",
      items: { data: [{ price: { id: "price_agencia_basica" } }] },
      metadata: { userId: "507f1f77bcf86cd799439011" }
    })
  });
  const output = JSON.stringify(summary);

  assert.doesNotMatch(output, /Persona Privada|privada@example\.com|12345678Z|600000000|Calle Privada/);
  assert.doesNotMatch(output, /507f1f77bcf86cd799439011|cus_secret_123|sub_secret_123/);
  assert.doesNotMatch(output, /price_basico|price_agencia_basica|price_unknown/);
  assert.doesNotMatch(output, /metadata/);
});

test("script de auditoría de cambios pendientes no contiene escrituras ni efectos prohibidos", () => {
  const audit = fs.readFileSync(new URL("../scripts/audit-pending-plan-changes.js", import.meta.url), "utf8");

  assert.match(audit, /AUDIT_PENDING_PLAN_CHANGES !== "true"/);
  assert.match(audit, /MONGODB_URI/);
  assert.match(audit, /subscriptions\.retrieve/);
  assert.match(audit, /mongoose\.disconnect/);
  assert.doesNotMatch(audit, /from "\.\.\/routes|from '\.\.\/routes/);
  assert.doesNotMatch(audit, /schedulePendingPlanChanges|scheduleManualPlanExpirations|scheduleVipTrialExpiration/);
  assert.doesNotMatch(audit, /\.save\(|\.update\(|\.updateOne\(|\.updateMany\(|\.findOneAndUpdate\(|\.bulkWrite\(|\.delete\(|\.deleteOne\(|\.deleteMany\(|\.insert\(|\.create\(/);
  assert.doesNotMatch(audit, /subscriptions\.update|subscriptions\.cancel|subscriptionItems\.update/);
  assert.doesNotMatch(audit, /enviarCorreo|nodemailer|sendMail/);
});

test("reparación individual valida barreras principales y argumentos", () => {
  assert.equal(validateSinglePlanSyncCli({ env: {}, argv: ["node", "script"] }).message, "REPAIR_SINGLE_PLAN_SYNC debe ser exactamente true.");
  assert.equal(validateSinglePlanSyncCli({ env: repairEnv({ REPAIR_SINGLE_PLAN_SYNC: "TRUE" }), argv: ["node", "script"] }).ok, false);
  assert.equal(validateSinglePlanSyncCli({ env: repairEnv({ MONGODB_URI: "" }), argv: ["node", "script"] }).message, "Falta MONGODB_URI.");
  assert.equal(validateSinglePlanSyncCli({ env: repairEnv({ TARGET_USER_ID: "" }), argv: ["node", "script"] }).message, "Falta TARGET_USER_ID.");
  assert.equal(validateSinglePlanSyncCli({ env: repairEnv({ TARGET_USER_ID: "no-es-objectid" }), argv: ["node", "script"] }).message, "TARGET_USER_ID no es un ObjectId válido.");
  assert.equal(validateSinglePlanSyncCli({ env: repairEnv({ EXPECTED_CURRENT_PLAN: "" }), argv: ["node", "script"] }).message, "Falta EXPECTED_CURRENT_PLAN.");
  assert.equal(validateSinglePlanSyncCli({ env: repairEnv({ EXPECTED_PENDING_PLAN: "" }), argv: ["node", "script"] }).message, "Falta EXPECTED_PENDING_PLAN.");
  assert.equal(validateSinglePlanSyncCli({ env: repairEnv({ TARGET_PLAN: "" }), argv: ["node", "script"] }).message, "Falta TARGET_PLAN.");
  assert.equal(validateSinglePlanSyncCli({ env: repairEnv({ TARGET_PLAN: "destacado" }), argv: ["node", "script"] }).message, "TARGET_PLAN debe ser basico.");
  assert.equal(validateSinglePlanSyncCli({ env: repairEnv({ EXPECTED_SUBSCRIPTION_STATUS: "" }), argv: ["node", "script"] }).message, "Falta EXPECTED_SUBSCRIPTION_STATUS.");
  assert.equal(validateSinglePlanSyncCli({ env: repairEnv({ EXPECTED_SUBSCRIPTION_STATUS: "past_due" }), argv: ["node", "script"] }).message, "EXPECTED_SUBSCRIPTION_STATUS debe ser active.");
  assert.equal(validateSinglePlanSyncCli({ env: repairEnv(), argv: ["node", "script", "--apply"] }).message, "Esta reparación no acepta argumentos ni opciones.");
});

test("reparación individual aborta validaciones previas sin conectar", async () => {
  for (const env of [
    repairEnv({ TARGET_USER_ID: "no-es-objectid" }),
    repairEnv({ TARGET_PLAN: "destacado" }),
    repairEnv({ EXPECTED_SUBSCRIPTION_STATUS: "canceled" })
  ]) {
    const calls = [];
    const code = await runSinglePlanSyncCli({
      env,
      argv: ["node", "script"],
      stdout: () => {},
      stderr: () => {},
      mongooseClient: {
        async connect() { calls.push("connect"); },
        async disconnect() { calls.push("disconnect"); }
      },
      UsuarioModel: SingleRepairModel([repairCandidate()])
    });

    assert.equal(code, 1);
    assert.deepEqual(calls, []);
  }
});

test("reparación individual exige confirmación explícita para aplicar", () => {
  assert.equal(validateSinglePlanSyncCli({
    env: repairEnv({ APPLY_PLAN_SYNC: "true" }),
    argv: ["node", "script"]
  }).message, "CONFIRM_PLAN_SYNC no coincide con la confirmación requerida.");
  assert.equal(validateSinglePlanSyncCli({
    env: repairEnv({ APPLY_PLAN_SYNC: "true", CONFIRM_PLAN_SYNC: "MAL" }),
    argv: ["node", "script"]
  }).ok, false);
  assert.deepEqual(validateSinglePlanSyncCli({
    env: repairEnv({ APPLY_PLAN_SYNC: "true", CONFIRM_PLAN_SYNC: "SYNC_ONE_TEST_USER" }),
    argv: ["node", "script"]
  }), { ok: true });
});

test("reparación individual en dry-run no escribe y devuelve resumen seguro", async () => {
  const model = SingleRepairModel([repairCandidate()]);
  const report = await repairSinglePlanSync({
    now: new Date("2026-08-05T00:00:00.000Z"),
    env: repairEnv(),
    UsuarioModel: model
  });

  assert.equal(report.dryRun, true);
  assert.equal(report.encontrado, true);
  assert.equal(report.planActual, "agencia_basica");
  assert.equal(report.planPendiente, "basico");
  assert.equal(report.planObjetivo, "basico");
  assert.equal(report.cambioVencido, true);
  assert.equal(report.subscriptionStatusCoincide, true);
  assert.equal(report.tieneStripeSubscription, true);
  assert.equal(report.aplicariaCambios, false);
  assert.equal(report.accionPropuesta, "sincronizar_mongo_con_stripe_test");
  assert.equal(model.state.updates.length, 0);
});

test("reparación individual aborta si el usuario no existe o la selección no es única", async () => {
  const env = repairEnv();
  const notFound = await repairSinglePlanSync({
    now: new Date("2026-08-05T00:00:00.000Z"),
    env,
    UsuarioModel: SingleRepairModel([])
  });
  const duplicated = await repairSinglePlanSync({
    now: new Date("2026-08-05T00:00:00.000Z"),
    env,
    UsuarioModel: SingleRepairModel([repairCandidate(), repairCandidate()])
  });

  assert.equal(notFound.abortReason, "usuario_no_encontrado");
  assert.equal(duplicated.abortReason, "seleccion_no_unica");
});

test("reparación individual aborta ante estado esperado no coincidente", async () => {
  const now = new Date("2026-08-05T00:00:00.000Z");
  const cases = [
    [repairCandidate({ plan: "destacado" }), "plan_actual_no_coincide", repairEnv()],
    [repairCandidate({ pendingPlan: "destacado" }), "pending_plan_no_coincide", repairEnv()],
    [repairCandidate({ pendingPlanChangeAt: new Date("2026-09-01T00:00:00.000Z") }), "cambio_no_vencido", repairEnv()],
    [repairCandidate({ stripeSubscriptionId: "" }), "sin_stripe_subscription", repairEnv()],
    [repairCandidate({ pendingPriceId: "" }), "sin_pending_price", repairEnv()],
    [repairCandidate({ subscriptionStatus: "past_due" }), "subscription_status_no_coincide", repairEnv()]
  ];

  for (const [candidate, reason, env] of cases) {
    const report = await repairSinglePlanSync({ now, env, UsuarioModel: SingleRepairModel([candidate]) });
    assert.equal(report.abortReason, reason);
    assert.equal(report.aplicado, false);
  }
});

test("reparación individual acepta pendingPlanChangeAt exactamente igual a now", async () => {
  const now = new Date("2026-08-05T00:00:00.000Z");
  const report = await repairSinglePlanSync({
    now,
    env: repairEnv(),
    UsuarioModel: SingleRepairModel([repairCandidate({ pendingPlanChangeAt: now })])
  });

  assert.equal(report.abortReason, null);
  assert.equal(report.cambioVencido, true);
  assert.equal(report.accionPropuesta, "sincronizar_mongo_con_stripe_test");
});

test("reparación individual aplica una actualización condicional a un único usuario", async () => {
  const model = SingleRepairModel([repairCandidate()]);
  const report = await repairSinglePlanSync({
    now: new Date("2026-08-05T00:00:00.000Z"),
    env: repairEnv({ APPLY_PLAN_SYNC: "true", CONFIRM_PLAN_SYNC: "SYNC_ONE_TEST_USER" }),
    UsuarioModel: model
  });

  assert.equal(report.aplicado, true);
  assert.equal(report.modifiedCount, 1);
  assert.equal(model.state.updates.length, 1);
  assert.deepEqual(model.state.updates[0].query, {
    _id: "507f1f77bcf86cd799439011",
    plan: "agencia_basica",
    pendingPlan: "basico",
    pendingPriceId: "price_basico",
    pendingPlanChangeAt: new Date("2026-07-01T00:00:00.000Z"),
    stripeSubscriptionId: "sub_secret_123",
    subscriptionStatus: "active"
  });
  assert.deepEqual(model.state.updates[0].update.$set, {
    plan: "basico",
    planActivo: true,
    subscriptionStatus: "active"
  });
  assert.deepEqual(Object.keys(model.state.updates[0].update.$unset).sort(), [
    "pendingPlan",
    "pendingPlanChangeAt",
    "pendingPlanLabel",
    "pendingPriceId"
  ].sort());
  assert.deepEqual(model.state.updates[0].options, { new: true, projection: {
    plan: 1,
    planActivo: 1,
    planFechaFin: 1,
    pendingPlan: 1,
    pendingPlanLabel: 1,
    pendingPriceId: 1,
    pendingPlanChangeAt: 1,
    stripeCustomerId: 1,
    stripeSubscriptionId: 1,
    subscriptionStatus: 1,
    cancelAtPeriodEnd: 1,
    subscriptionCancelAt: 1
  } });
  assert.equal("upsert" in model.state.updates[0].options, false);
});

test("reparación individual aborta si subscriptionStatus cambia concurrentemente", async () => {
  const model = SingleRepairModel([repairCandidate()], {
    onUpdate(query) {
      assert.equal(query.subscriptionStatus, "active");
    },
    updateMatches: false
  });
  const report = await repairSinglePlanSync({
    now: new Date("2026-08-05T00:00:00.000Z"),
    env: repairEnv({ APPLY_PLAN_SYNC: "true", CONFIRM_PLAN_SYNC: "SYNC_ONE_TEST_USER" }),
    UsuarioModel: model
  });

  assert.equal(report.abortReason, "actualizacion_condicional_sin_coincidencias");
  assert.equal(model.state.updates.length, 1);
});

test("reparación individual aborta si la actualización condicional afecta 0 documentos", async () => {
  const model = SingleRepairModel([repairCandidate()], { updateMatches: false });
  const report = await repairSinglePlanSync({
    now: new Date("2026-08-05T00:00:00.000Z"),
    env: repairEnv({ APPLY_PLAN_SYNC: "true", CONFIRM_PLAN_SYNC: "SYNC_ONE_TEST_USER" }),
    UsuarioModel: model
  });

  assert.equal(report.abortReason, "actualizacion_condicional_sin_coincidencias");
  assert.equal(report.aplicado, false);
  assert.equal(model.state.updates.length, 1);
});

test("reparación individual limpia pending fields y preserva IDs Stripe", async () => {
  const user = repairCandidate();
  const report = await repairSinglePlanSync({
    now: new Date("2026-08-05T00:00:00.000Z"),
    env: repairEnv({ APPLY_PLAN_SYNC: "true", CONFIRM_PLAN_SYNC: "SYNC_ONE_TEST_USER" }),
    UsuarioModel: SingleRepairModel([user])
  });

  assert.equal(user.plan, "basico");
  assert.equal(user.planActivo, true);
  assert.equal(user.subscriptionStatus, "active");
  assert.equal(user.pendingPlan, undefined);
  assert.equal(user.pendingPriceId, undefined);
  assert.equal(user.pendingPlanChangeAt, undefined);
  assert.equal(user.pendingPlanLabel, undefined);
  assert.equal(user.stripeSubscriptionId, "sub_secret_123");
  assert.equal(user.stripeCustomerId, "cus_secret_123");
  assert.equal(report.afterVerificado.stripeSubscriptionPreservada, true);
});

test("reparación individual no modifica propiedades ni datos ajenos", async () => {
  const user = repairCandidate({
    nombre: "Nombre Original",
    email: "original@example.com",
    favoritos: ["prop_1"],
    trialAccepted: true,
    launchPromoApplied: true
  });
  await repairSinglePlanSync({
    now: new Date("2026-08-05T00:00:00.000Z"),
    env: repairEnv({ APPLY_PLAN_SYNC: "true", CONFIRM_PLAN_SYNC: "SYNC_ONE_TEST_USER" }),
    UsuarioModel: SingleRepairModel([user])
  });

  assert.equal(user.nombre, "Nombre Original");
  assert.equal(user.email, "original@example.com");
  assert.deepEqual(user.favoritos, ["prop_1"]);
  assert.equal(user.trialAccepted, true);
  assert.equal(user.launchPromoApplied, true);
});

test("reparación individual no expone nombres, emails ni IDs Stripe", async () => {
  const report = await repairSinglePlanSync({
    now: new Date("2026-08-05T00:00:00.000Z"),
    env: repairEnv(),
    UsuarioModel: SingleRepairModel([repairCandidate()])
  });
  const output = JSON.stringify(report);

  assert.doesNotMatch(output, /Persona Privada|privada@example\.com|12345678Z/);
  assert.doesNotMatch(output, /sub_secret_123|cus_secret_123|507f1f77bcf86cd799439011/);
});

test("reparación individual cierra conexión en finally", async () => {
  const calls = [];
  const code = await runSinglePlanSyncCli({
    env: repairEnv(),
    argv: ["node", "script"],
    stdout: () => {},
    stderr: () => {},
    mongooseClient: {
      async connect() { calls.push("connect"); },
      async disconnect() { calls.push("disconnect"); }
    },
    UsuarioModel: SingleRepairModel([repairCandidate()])
  });

  assert.equal(code, 0);
  assert.deepEqual(calls, ["connect", "disconnect"]);
});

test("reparación individual es idempotente: segunda ejecución no vuelve a aplicar", async () => {
  const user = repairCandidate();
  const model = SingleRepairModel([user]);
  const env = repairEnv({ APPLY_PLAN_SYNC: "true", CONFIRM_PLAN_SYNC: "SYNC_ONE_TEST_USER" });
  const first = await repairSinglePlanSync({ now: new Date("2026-08-05T00:00:00.000Z"), env, UsuarioModel: model });
  const second = await repairSinglePlanSync({ now: new Date("2026-08-05T00:00:00.000Z"), env, UsuarioModel: model });

  assert.equal(first.aplicado, true);
  assert.equal(second.aplicado, false);
  assert.equal(second.abortReason, "plan_actual_no_coincide");
  assert.equal(model.state.updates.length, 1);
});

test("script de reparación individual no importa Stripe ni contiene escrituras ajenas", () => {
  const repair = fs.readFileSync(new URL("../scripts/repair-single-plan-sync.js", import.meta.url), "utf8");

  assert.doesNotMatch(repair, /from "stripe"|from 'stripe'|import\("stripe"\)|import\('stripe'\)/);
  assert.doesNotMatch(repair, /from "\.\.\/routes|from '\.\.\/routes|server\.js/);
  assert.doesNotMatch(repair, /schedulePendingPlanChanges|scheduleManualPlanExpirations|scheduleVipTrialExpiration/);
  assert.doesNotMatch(repair, /aplicarLimitesPlanTrasTrial|Propiedad|enviarCorreo|nodemailer|sendMail/);
  assert.doesNotMatch(repair, /\.save\(|\.update\(|\.updateOne\(|\.updateMany\(|\.bulkWrite\(|\.delete\(|\.deleteOne\(|\.deleteMany\(|\.insert\(|\.create\(/);
  assert.equal((repair.match(/findOneAndUpdate/g) || []).length, 1);
  assert.match(repair, /mongooseClient\.disconnect/);
});

test("limpieza Stripe obsoleta valida flags, datos obligatorios y argumentos", () => {
  assert.equal(validateClearStaleTestSubscriptionCli({ env: {}, argv: ["node", "script"] }).message, "CLEAR_STALE_TEST_SUBSCRIPTION debe ser exactamente true.");
  assert.equal(validateClearStaleTestSubscriptionCli({ env: staleCleanupEnv({ CLEAR_STALE_TEST_SUBSCRIPTION: "TRUE" }), argv: ["node", "script"] }).ok, false);
  assert.equal(validateClearStaleTestSubscriptionCli({ env: staleCleanupEnv({ CLEAR_STALE_TEST_SUBSCRIPTION: "1" }), argv: ["node", "script"] }).ok, false);
  assert.equal(validateClearStaleTestSubscriptionCli({ env: staleCleanupEnv({ MONGODB_URI: "" }), argv: ["node", "script"] }).message, "Falta MONGODB_URI.");
  assert.equal(validateClearStaleTestSubscriptionCli({ env: staleCleanupEnv({ TARGET_USER_ID: "" }), argv: ["node", "script"] }).message, "Falta TARGET_USER_ID.");
  assert.equal(validateClearStaleTestSubscriptionCli({ env: staleCleanupEnv({ TARGET_USER_ID: "no-es-objectid" }), argv: ["node", "script"] }).message, "TARGET_USER_ID no es un ObjectId válido.");
  assert.equal(validateClearStaleTestSubscriptionCli({ env: staleCleanupEnv({ TARGET_EMAIL: "" }), argv: ["node", "script"] }).message, "Falta TARGET_EMAIL.");
  assert.equal(validateClearStaleTestSubscriptionCli({ env: staleCleanupEnv({ TARGET_EMAIL: "email-invalido" }), argv: ["node", "script"] }).message, "TARGET_EMAIL no tiene un formato válido.");
  assert.equal(validateClearStaleTestSubscriptionCli({ env: staleCleanupEnv({ EXPECTED_ACTIVE: "true" }), argv: ["node", "script"] }).message, "EXPECTED_ACTIVE debe ser exactamente false.");
  assert.equal(validateClearStaleTestSubscriptionCli({ env: staleCleanupEnv({ EXPECTED_CURRENT_PLAN: "" }), argv: ["node", "script"] }).message, "Falta EXPECTED_CURRENT_PLAN.");
  assert.equal(validateClearStaleTestSubscriptionCli({ env: staleCleanupEnv({ EXPECTED_PENDING_PLAN: "" }), argv: ["node", "script"] }).message, "Falta EXPECTED_PENDING_PLAN.");
  assert.equal(validateClearStaleTestSubscriptionCli({ env: staleCleanupEnv(), argv: ["node", "script", "--apply"] }).message, "Esta limpieza no acepta argumentos ni opciones.");
});

test("limpieza Stripe obsoleta aborta validaciones previas sin conectar", async () => {
  for (const env of [
    staleCleanupEnv({ TARGET_USER_ID: "no-es-objectid" }),
    staleCleanupEnv({ TARGET_EMAIL: "mal" }),
    staleCleanupEnv({ EXPECTED_ACTIVE: "false " })
  ]) {
    const calls = [];
    const code = await runClearStaleTestSubscriptionCli({
      env,
      argv: ["node", "script"],
      stdout: () => {},
      stderr: () => {},
      mongooseClient: {
        async connect() { calls.push("connect"); },
        async disconnect() { calls.push("disconnect"); }
      },
      UsuarioModel: StaleCleanupModel([staleCleanupCandidate()])
    });

    assert.equal(code, 1);
    assert.deepEqual(calls, []);
  }
});

test("limpieza Stripe obsoleta exige confirmación explícita para aplicar", () => {
  assert.equal(validateClearStaleTestSubscriptionCli({
    env: staleCleanupEnv({ APPLY_STALE_TEST_CLEANUP: "TRUE", CONFIRM_STALE_TEST_CLEANUP: "CLEAR_ONE_DISABLED_TEST_USER" }),
    argv: ["node", "script"]
  }).ok, true);
  assert.equal(validateClearStaleTestSubscriptionCli({
    env: staleCleanupEnv({ APPLY_STALE_TEST_CLEANUP: "true" }),
    argv: ["node", "script"]
  }).message, "CONFIRM_STALE_TEST_CLEANUP no coincide con la confirmación requerida.");
  assert.deepEqual(validateClearStaleTestSubscriptionCli({
    env: staleCleanupEnv({ APPLY_STALE_TEST_CLEANUP: "true", CONFIRM_STALE_TEST_CLEANUP: "CLEAR_ONE_DISABLED_TEST_USER" }),
    argv: ["node", "script"]
  }), { ok: true });
});

test("limpieza Stripe obsoleta en dry-run no escribe y devuelve solo resumen seguro", async () => {
  const model = StaleCleanupModel([staleCleanupCandidate()]);
  const report = await clearStaleTestSubscription({
    env: staleCleanupEnv(),
    UsuarioModel: model
  });

  assert.deepEqual(Object.keys(report), [
    "encontrado",
    "usuarioDesactivado",
    "planCoincide",
    "pendingPlanCoincide",
    "tieneStripeCustomer",
    "tieneStripeSubscription",
    "tienePendingChange",
    "accionPropuesta",
    "aplicariaCambios"
  ]);
  assert.equal(report.encontrado, true);
  assert.equal(report.usuarioDesactivado, true);
  assert.equal(report.planCoincide, true);
  assert.equal(report.pendingPlanCoincide, true);
  assert.equal(report.tieneStripeCustomer, true);
  assert.equal(report.tieneStripeSubscription, true);
  assert.equal(report.tienePendingChange, true);
  assert.equal(report.accionPropuesta, "limpiar_stripe_obsoleto_usuario_test_desactivado");
  assert.equal(report.aplicariaCambios, false);
  assert.equal(model.state.updates.length, 0);
});

test("limpieza Stripe obsoleta protege aplicación desde la función core exportada", async () => {
  const scenarios = [
    [{}, false, undefined],
    [{ apply: false }, false, undefined],
    [{ apply: true }, true, "confirmacion_requerida"],
    [{ apply: true, confirm: "MAL" }, true, "confirmacion_requerida"]
  ];

  for (const [params, hasApplyFields, abortReason] of scenarios) {
    const model = StaleCleanupModel([staleCleanupCandidate()]);
    const report = await clearStaleTestSubscription({
      env: staleCleanupEnv(),
      UsuarioModel: model,
      ...params
    });

    assert.equal(model.state.updates.length, 0);
    assert.equal(report.aplicariaCambios, false);
    if (hasApplyFields) {
      assert.equal(report.abortReason, abortReason);
    } else {
      assert.equal("abortReason" in report, false);
    }
  }
});

test("limpieza Stripe obsoleta solo permite escribir con confirmación core exacta", async () => {
  const model = StaleCleanupModel([staleCleanupCandidate()]);
  const report = await clearStaleTestSubscription({
    env: staleCleanupEnv(),
    UsuarioModel: model,
    apply: true,
    confirm: "CLEAR_ONE_DISABLED_TEST_USER"
  });

  assert.equal(report.aplicado, true);
  assert.equal(report.modifiedCount, 1);
  assert.equal(model.state.updates.length, 1);
});

test("limpieza Stripe obsoleta aborta si la selección estricta no coincide", async () => {
  const cases = [
    [staleCleanupCandidate({ activo: true }), "usuario_no_desactivado"],
    [staleCleanupCandidate({ email: "otra@example.com" }), "email_no_coincide"],
    [staleCleanupCandidate({ plan: "destacado" }), "plan_actual_no_coincide"],
    [staleCleanupCandidate({ pendingPlan: "destacado" }), "pending_plan_no_coincide"],
    [staleCleanupCandidate({ stripeSubscriptionId: "" }), "sin_stripe_subscription"]
  ];

  for (const [candidate, reason] of cases) {
    const model = StaleCleanupModel([candidate]);
    const report = await clearStaleTestSubscription({
      env: staleCleanupEnv({ APPLY_STALE_TEST_CLEANUP: "true", CONFIRM_STALE_TEST_CLEANUP: "CLEAR_ONE_DISABLED_TEST_USER" }),
      UsuarioModel: model,
      apply: true,
      confirm: "CLEAR_ONE_DISABLED_TEST_USER"
    });

    assert.equal(report.abortReason, reason);
    assert.equal(report.aplicado, false);
    assert.equal(model.state.updates.length, 0);
  }
});

test("limpieza Stripe obsoleta aplica una única actualización condicional sin upsert", async () => {
  const model = StaleCleanupModel([staleCleanupCandidate()]);
  const report = await clearStaleTestSubscription({
    env: staleCleanupEnv({ APPLY_STALE_TEST_CLEANUP: "true", CONFIRM_STALE_TEST_CLEANUP: "CLEAR_ONE_DISABLED_TEST_USER" }),
    UsuarioModel: model,
    apply: true,
    confirm: "CLEAR_ONE_DISABLED_TEST_USER"
  });

  assert.equal(report.aplicado, true);
  assert.equal(report.modifiedCount, 1);
  assert.equal(model.state.updates.length, 1);
  assert.deepEqual(model.state.updates[0].query, {
    _id: "507f1f77bcf86cd799439022",
    email: "test.disabled@example.com",
    activo: false,
    plan: "agencia_basica",
    pendingPlan: "basico",
    stripeSubscriptionId: "sub_old_test_secret",
    pendingPlanChangeAt: new Date("2026-07-15T00:00:00.000Z"),
    pendingPriceId: "price_basico"
  });
  assert.deepEqual(Object.keys(model.state.updates[0].update.$unset).sort(), [
    "cancelAtPeriodEnd",
    "pendingPlan",
    "pendingPlanChangeAt",
    "pendingPlanLabel",
    "pendingPriceId",
    "stripeCustomerId",
    "stripeSubscriptionId",
    "subscriptionCancelAt",
    "subscriptionStatus"
  ].sort());
  assert.equal("$set" in model.state.updates[0].update, false);
  assert.deepEqual(model.state.updates[0].options, { new: true, projection: {
    email: 1,
    activo: 1,
    plan: 1,
    planActivo: 1,
    planFechaFin: 1,
    pendingPlan: 1,
    pendingPlanLabel: 1,
    pendingPriceId: 1,
    pendingPlanChangeAt: 1,
    stripeCustomerId: 1,
    stripeSubscriptionId: 1,
    subscriptionStatus: 1,
    cancelAtPeriodEnd: 1,
    subscriptionCancelAt: 1
  } });
  assert.equal("upsert" in model.state.updates[0].options, false);
});

test("limpieza Stripe obsoleta aborta con 0 coincidencias sin reintento", async () => {
  const model = StaleCleanupModel([staleCleanupCandidate()], { updateMatches: false });
  const report = await clearStaleTestSubscription({
    env: staleCleanupEnv({ APPLY_STALE_TEST_CLEANUP: "true", CONFIRM_STALE_TEST_CLEANUP: "CLEAR_ONE_DISABLED_TEST_USER" }),
    UsuarioModel: model,
    apply: true,
    confirm: "CLEAR_ONE_DISABLED_TEST_USER"
  });

  assert.equal(report.abortReason, "actualizacion_condicional_sin_coincidencias");
  assert.equal(report.aplicado, false);
  assert.equal(model.state.updates.length, 1);
});

test("limpieza Stripe obsoleta limpia solo campos permitidos y preserva plan y activo", async () => {
  const user = staleCleanupCandidate();
  const report = await clearStaleTestSubscription({
    env: staleCleanupEnv({ APPLY_STALE_TEST_CLEANUP: "true", CONFIRM_STALE_TEST_CLEANUP: "CLEAR_ONE_DISABLED_TEST_USER" }),
    UsuarioModel: StaleCleanupModel([user]),
    apply: true,
    confirm: "CLEAR_ONE_DISABLED_TEST_USER"
  });

  assert.equal(user.plan, "agencia_basica");
  assert.equal(user.planActivo, false);
  assert.equal(user.planFechaFin.toISOString(), "2026-07-01T00:00:00.000Z");
  assert.equal(user.activo, false);
  assert.equal(user.nombre, "Usuario de Prueba");
  assert.equal(user.email, "test.disabled@example.com");
  assert.deepEqual(user.favoritos, ["prop_1"]);
  assert.equal(user.trialAccepted, true);
  assert.equal(user.launchPromoApplied, true);
  assert.equal(user.stripeCustomerId, undefined);
  assert.equal(user.stripeSubscriptionId, undefined);
  assert.equal(user.subscriptionStatus, undefined);
  assert.equal(user.pendingPlan, undefined);
  assert.equal(user.pendingPriceId, undefined);
  assert.equal(user.pendingPlanChangeAt, undefined);
  assert.equal(user.pendingPlanLabel, undefined);
  assert.deepEqual(report.verificacionPosterior, {
    sigueDesactivado: true,
    planPreservado: true,
    stripeFieldsVacios: true,
    pendingFieldsVacios: true
  });
});

test("limpieza Stripe obsoleta no expone datos personales ni IDs", async () => {
  const report = await clearStaleTestSubscription({
    env: staleCleanupEnv(),
    UsuarioModel: StaleCleanupModel([staleCleanupCandidate()])
  });
  const output = JSON.stringify(report);

  assert.doesNotMatch(output, /Usuario de Prueba|test\.disabled@example\.com/);
  assert.doesNotMatch(output, /507f1f77bcf86cd799439022|sub_old_test_secret|cus_old_test_secret|price_basico/);
});

test("limpieza Stripe obsoleta cierra conexión en finally", async () => {
  const calls = [];
  const code = await runClearStaleTestSubscriptionCli({
    env: staleCleanupEnv(),
    argv: ["node", "script"],
    stdout: () => {},
    stderr: () => {},
    mongooseClient: {
      async connect() { calls.push("connect"); },
      async disconnect() { calls.push("disconnect"); }
    },
    UsuarioModel: StaleCleanupModel([staleCleanupCandidate()])
  });

  assert.equal(code, 0);
  assert.deepEqual(calls, ["connect", "disconnect"]);
});

test("limpieza Stripe obsoleta CLI pasa apply y confirm a la función core", async () => {
  const calls = [];
  const model = StaleCleanupModel([staleCleanupCandidate()]);
  const code = await runClearStaleTestSubscriptionCli({
    env: staleCleanupEnv({ APPLY_STALE_TEST_CLEANUP: "true", CONFIRM_STALE_TEST_CLEANUP: "CLEAR_ONE_DISABLED_TEST_USER" }),
    argv: ["node", "script"],
    stdout: () => {},
    stderr: () => {},
    mongooseClient: {
      async connect() { calls.push("connect"); },
      async disconnect() { calls.push("disconnect"); }
    },
    UsuarioModel: model
  });

  assert.equal(code, 0);
  assert.deepEqual(calls, ["connect", "disconnect"]);
  assert.equal(model.state.updates.length, 1);
});

test("limpieza Stripe obsoleta es idempotente: segunda ejecución no vuelve a aplicar", async () => {
  const user = staleCleanupCandidate();
  const model = StaleCleanupModel([user]);
  const env = staleCleanupEnv({ APPLY_STALE_TEST_CLEANUP: "true", CONFIRM_STALE_TEST_CLEANUP: "CLEAR_ONE_DISABLED_TEST_USER" });
  const first = await clearStaleTestSubscription({ env, UsuarioModel: model, apply: true, confirm: "CLEAR_ONE_DISABLED_TEST_USER" });
  const second = await clearStaleTestSubscription({ env, UsuarioModel: model, apply: true, confirm: "CLEAR_ONE_DISABLED_TEST_USER" });

  assert.equal(first.aplicado, true);
  assert.equal(second.aplicado, false);
  assert.equal(second.abortReason, "pending_plan_no_coincide");
  assert.equal(model.state.updates.length, 1);
});

test("script de limpieza Stripe obsoleta no importa Stripe, Propiedad ni efectos prohibidos", () => {
  const cleanup = fs.readFileSync(new URL("../scripts/clear-stale-test-subscription.js", import.meta.url), "utf8");

  assert.doesNotMatch(cleanup, /from "stripe"|from 'stripe'|import\("stripe"\)|import\('stripe'\)/);
  assert.doesNotMatch(cleanup, /Propiedad|from "\.\.\/routes|from '\.\.\/routes|server\.js/);
  assert.doesNotMatch(cleanup, /schedulePendingPlanChanges|scheduleManualPlanExpirations|scheduleVipTrialExpiration/);
  assert.doesNotMatch(cleanup, /aplicarLimitesPlanTrasTrial|enviarCorreo|nodemailer|sendMail/);
  assert.doesNotMatch(cleanup, /\.save\(|\.update\(|\.updateOne\(|\.updateMany\(|\.bulkWrite\(|\.delete\(|\.deleteOne\(|\.deleteMany\(|\.insert\(|\.create\(/);
  assert.equal((cleanup.match(/findOneAndUpdate/g) || []).length, 1);
  assert.match(cleanup, /mongooseClient\.disconnect/);
});
