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

process.env.STRIPE_PRICE_BASICO = "price_basico";

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
