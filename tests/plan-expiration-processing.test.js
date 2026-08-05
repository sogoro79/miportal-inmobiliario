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
