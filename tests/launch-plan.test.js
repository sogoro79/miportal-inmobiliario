import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  activateLaunchPlan,
  expireLaunchPlans,
  getLaunchPlanPublicStatus,
  getLaunchPlanEndsAt,
  LAUNCH_PLAN_END_ISO,
  LAUNCH_PLAN_ID,
  LaunchPlanError,
  usuarioTienePlanLanzamientoActivo,
  sendLaunchPlanReminders,
  scheduleLaunchPlanExpiration,
  resetLaunchPlanSchedulerForTests
} from "../utils/launchPlan.js";

function mockUser(overrides = {}) {
  return {
    _id: "user-1",
    plan: "gratis",
    planActivo: false,
    planFechaFin: null,
    role: "user",
    saveCalls: 0,
    async save() {
      this.saveCalls += 1;
      return this;
    },
    ...overrides
  };
}

function userModelFor(user) {
  return {
    async findById(id) {
      return id === user._id ? user : null;
    }
  };
}

test("Plan Lanzamiento tiene fecha fija Madrid, límites propios y no depende de Stripe", () => {
  assert.equal(LAUNCH_PLAN_ID, "lanzamiento_2026");
  assert.equal(LAUNCH_PLAN_END_ISO, "2027-01-31T22:59:59.000Z");
  assert.equal(getLaunchPlanEndsAt().toISOString(), "2027-01-31T22:59:59.000Z");

  const source = fs.readFileSync(new URL("../utils/launchPlan.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from ["']stripe["']|new Stripe|stripe\.subscriptions|checkout\.sessions|paymentIntents/i);
  assert.match(source, /aplicarLimitesPlanTrasTrial/);
});

test("estado público permite activar solo usuarios gratis sin cambios pendientes ni Stripe activo", () => {
  const base = getLaunchPlanPublicStatus(mockUser(), new Date("2026-12-01T12:00:00.000Z"));
  assert.equal(base.campaignActive, true);
  assert.equal(base.eligible, true);
  assert.equal(base.active, false);

  assert.equal(getLaunchPlanPublicStatus(mockUser({ role: "admin" })).eligible, false);
  assert.equal(getLaunchPlanPublicStatus(mockUser({ plan: "basico", planActivo: true })).eligible, false);
  assert.equal(getLaunchPlanPublicStatus(mockUser({ pendingPlan: "basico" })).eligible, false);
  assert.equal(getLaunchPlanPublicStatus(mockUser({ stripeSubscriptionId: "sub_test", subscriptionStatus: "active" })).eligible, false);
  assert.equal(getLaunchPlanPublicStatus(mockUser({ stripeSubscriptionId: "sub_test", subscriptionStatus: "canceled" })).eligible, true);
});

test("activación explícita asigna lanzamiento_2026 sin Stripe ni renovación automática", async () => {
  const user = mockUser();
  const result = await activateLaunchPlan({
    userId: user._id,
    models: { Usuario: userModelFor(user) },
    now: new Date("2026-12-01T12:00:00.000Z")
  });

  assert.equal(result.activated, true);
  assert.equal(result.alreadyActive, false);
  assert.equal(user.plan, LAUNCH_PLAN_ID);
  assert.equal(user.planActivo, true);
  assert.equal(user.planFechaFin.toISOString(), "2027-01-31T22:59:59.000Z");
  assert.equal(user.saveCalls, 1);
});

test("activación rechaza campaña expirada, planes no elegibles y usuario inexistente", async () => {
  await assert.rejects(
    () => activateLaunchPlan({
      userId: "user-1",
      models: { Usuario: userModelFor(mockUser()) },
      now: new Date("2027-02-01T00:00:00.000Z")
    }),
    error => error instanceof LaunchPlanError && error.status === 410
  );

  await assert.rejects(
    () => activateLaunchPlan({
      userId: "user-1",
      models: { Usuario: userModelFor(mockUser({ pendingPriceId: "price_x" })) },
      now: new Date("2026-12-01T12:00:00.000Z")
    }),
    error => error instanceof LaunchPlanError && error.status === 409
  );

  await assert.rejects(
    () => activateLaunchPlan({
      userId: "missing",
      models: { Usuario: userModelFor(mockUser()) },
      now: new Date("2026-12-01T12:00:00.000Z")
    }),
    error => error instanceof LaunchPlanError && error.status === 404
  );
});

test("expiración baja a gratis y aplica límites sin borrar propiedades ni fotos", async () => {
  const expired = mockUser({
    _id: "expired",
    plan: LAUNCH_PLAN_ID,
    planActivo: true,
    planFechaFin: new Date("2027-01-31T22:59:59.000Z"),
    propiedades: [
      { _id: "prop-1", visiblePublicamente: true, imagenes: ["foto-1", "foto-2"] },
      { _id: "prop-2", visiblePublicamente: true, imagenes: ["foto-3"] },
      { _id: "prop-3", visiblePublicamente: true, imagenes: ["foto-4"] }
    ]
  });
  const untouched = mockUser({
    _id: "untouched",
    plan: "gratis",
    planActivo: false,
    planFechaFin: null
  });
  const applied = [];
  const UsuarioModel = {
    async find(query) {
      assert.equal(query.plan, LAUNCH_PLAN_ID);
      assert.equal(query.planActivo, true);
      assert.deepEqual(query.planFechaFin.$lt, new Date("2027-02-01T00:00:00.000Z"));
      return [expired, untouched];
    }
  };

  const result = await expireLaunchPlans(new Date("2027-02-01T00:00:00.000Z"), {
    UsuarioModel,
    applyLimits: async (userId, options) => {
      applied.push({ userId, options });
      expired.propiedades[2].visiblePublicamente = false;
      return { propiedadesVisibles: 2, propiedadesOcultadas: 1 };
    },
    logger: { info() {}, error() {} }
  });

  assert.deepEqual(result, { revisados: 2, expirados: 1, omitidos: 1 });
  assert.equal(expired.plan, "gratis");
  assert.equal(expired.planActivo, false);
  assert.equal(expired.planFechaFin, null);
  assert.equal(expired.saveCalls, 1);
  assert.deepEqual(expired.propiedades.map(propiedad => propiedad.visiblePublicamente), [true, true, false]);
  assert.deepEqual(expired.propiedades.flatMap(propiedad => propiedad.imagenes), ["foto-1", "foto-2", "foto-3", "foto-4"]);
  assert.deepEqual(applied, [{ userId: "expired", options: { planDestino: "gratis", now: new Date("2027-02-01T00:00:00.000Z") } }]);
  assert.equal(untouched.saveCalls, 0);
});

test("expiración de Plan Lanzamiento es idempotente y no repite recortes en segunda pasada", async () => {
  const expired = mockUser({
    _id: "expired",
    plan: LAUNCH_PLAN_ID,
    planActivo: true,
    planFechaFin: new Date("2027-01-31T22:59:59.000Z")
  });
  let firstQuery = true;
  const UsuarioModel = {
    async find() {
      if (firstQuery) {
        firstQuery = false;
        return [expired];
      }
      return [];
    }
  };
  const applied = [];

  const options = {
    UsuarioModel,
    applyLimits: async (userId) => applied.push(userId),
    logger: { info() {}, error() {} }
  };
  const first = await expireLaunchPlans(new Date("2027-02-01T00:00:00.000Z"), options);
  const second = await expireLaunchPlans(new Date("2027-02-01T00:00:00.000Z"), options);

  assert.deepEqual(first, { revisados: 1, expirados: 1, omitidos: 0 });
  assert.deepEqual(second, { revisados: 0, expirados: 0, omitidos: 0 });
  assert.equal(expired.plan, "gratis");
  assert.equal(expired.saveCalls, 1);
  assert.deepEqual(applied, ["expired"]);
});

test("Plan Lanzamiento sigue activo hasta el último segundo y expira justo después", async () => {
  const user = mockUser({
    plan: LAUNCH_PLAN_ID,
    planActivo: true,
    planFechaFin: new Date("2027-01-31T22:59:59.000Z")
  });
  const UsuarioModel = {
    async find() {
      throw new Error("no debe consultar antes del final inclusivo");
    }
  };

  assert.equal(usuarioTienePlanLanzamientoActivo(user, new Date("2027-01-31T22:59:59.000Z")), true);
  assert.equal(getLaunchPlanPublicStatus(user, new Date("2027-01-31T22:59:59.000Z")).active, true);
  assert.deepEqual(
    await expireLaunchPlans(new Date("2027-01-31T22:59:59.000Z"), {
      UsuarioModel,
      logger: { info() {}, error() {} }
    }),
    { revisados: 0, expirados: 0, omitidos: 0 }
  );

  const afterEnd = mockUser({
    plan: LAUNCH_PLAN_ID,
    planActivo: true,
    planFechaFin: new Date("2027-01-31T22:59:59.000Z")
  });
  const afterEndModel = {
    async find(query) {
      assert.deepEqual(query.planFechaFin.$lt, new Date("2027-01-31T22:59:59.001Z"));
      return [afterEnd];
    }
  };

  assert.equal(usuarioTienePlanLanzamientoActivo(afterEnd, new Date("2027-01-31T22:59:59.001Z")), false);
  const result = await expireLaunchPlans(new Date("2027-01-31T22:59:59.001Z"), {
    UsuarioModel: afterEndModel,
    applyLimits: async () => ({}),
    logger: { info() {}, error() {} }
  });
  assert.deepEqual(result, { revisados: 1, expirados: 1, omitidos: 0 });
  assert.equal(afterEnd.plan, "gratis");
});

test("recordatorio Plan Lanzamiento se envía una sola vez dentro de la ventana de 7 días", async () => {
  const user = mockUser({
    _id: "launch-user",
    email: "persona@example.com",
    plan: LAUNCH_PLAN_ID,
    planActivo: true,
    planFechaFin: new Date("2027-01-31T22:59:59.000Z"),
    launchPlanReminderSent: false
  });
  const sent = [];
  const UsuarioModel = {
    async find(query) {
      assert.equal(query.plan, LAUNCH_PLAN_ID);
      assert.equal(query.planActivo, true);
      assert.deepEqual(query.launchPlanReminderSent, { $ne: true });
      assert.ok(query.planFechaFin.$gte instanceof Date);
      return user.launchPlanReminderSent ? [] : [user];
    }
  };

  const mailer = async (to, subject, html) => {
    sent.push({ to, subject, html });
    return true;
  };

  assert.equal(await sendLaunchPlanReminders(new Date("2027-01-24T22:59:58.999Z"), { UsuarioModel, mailer }), 0);
  assert.equal(await sendLaunchPlanReminders(new Date("2027-01-24T22:59:59.000Z"), { UsuarioModel, mailer }), 1);
  assert.equal(await sendLaunchPlanReminders(new Date("2027-01-25T10:00:00.000Z"), { UsuarioModel, mailer }), 0);
  assert.equal(await sendLaunchPlanReminders(new Date("2027-01-31T23:00:00.000Z"), { UsuarioModel, mailer }), 0);

  assert.equal(user.launchPlanReminderSent, true);
  assert.equal(user.saveCalls, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "persona@example.com");
  assert.match(sent[0].subject, /Plan Lanzamiento/);
  assert.match(sent[0].html, /Tu Plan Lanzamiento finaliza el 31 de enero de 2027/);
  assert.match(sent[0].html, /pasarás automáticamente al Plan Gratis/);
  assert.match(sent[0].html, /no se eliminarán/);
  assert.match(sent[0].html, /https:\/\/www\.homeclick24\.com\/planes\.html/);
});

test("recordatorio Plan Lanzamiento no se envía si falla el email o faltan datos", async () => {
  const withoutEmail = mockUser({
    plan: LAUNCH_PLAN_ID,
    planActivo: true,
    planFechaFin: new Date("2027-01-31T22:59:59.000Z"),
    launchPlanReminderSent: false
  });
  const mailFailed = mockUser({
    _id: "mail-failed",
    email: "persona@example.com",
    plan: LAUNCH_PLAN_ID,
    planActivo: true,
    planFechaFin: new Date("2027-01-31T22:59:59.000Z"),
    launchPlanReminderSent: false
  });
  const UsuarioModel = {
    async find() {
      return [withoutEmail, mailFailed];
    }
  };

  const enviados = await sendLaunchPlanReminders(new Date("2027-01-25T12:00:00.000Z"), {
    UsuarioModel,
    mailer: async () => false
  });

  assert.equal(enviados, 0);
  assert.equal(withoutEmail.launchPlanReminderSent, false);
  assert.equal(mailFailed.launchPlanReminderSent, false);
  assert.equal(withoutEmail.saveCalls, 0);
  assert.equal(mailFailed.saveCalls, 0);
});

test("scheduler de expiración arranca una pasada inmediata y queda reutilizable", async () => {
  resetLaunchPlanSchedulerForTests();
  let runs = 0;
  let reminderRuns = 0;
  const scheduled = [];
  const handle = scheduleLaunchPlanExpiration({
    intervalMs: 1000,
    setIntervalFn: (fn, interval) => {
      scheduled.push({ fn, interval });
      return { interval };
    },
    processor: async () => {
      runs += 1;
      return { ok: true };
    },
    reminderProcessor: async () => {
      reminderRuns += 1;
      return 0;
    },
    logger: { info() {}, error() {} }
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runs, 1);
  assert.equal(reminderRuns, 1);
  assert.equal(scheduled.length, 1);
  assert.deepEqual(handle, { interval: 1000 });
  assert.equal(scheduleLaunchPlanExpiration(), handle);
  resetLaunchPlanSchedulerForTests();
});
