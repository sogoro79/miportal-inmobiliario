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

test("expiración baja a gratis sin borrar datos y aplica límites gratis una sola vez", async () => {
  const expired = mockUser({
    _id: "expired",
    plan: LAUNCH_PLAN_ID,
    planActivo: true,
    planFechaFin: new Date("2027-01-31T22:59:59.000Z")
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
      assert.deepEqual(query.planFechaFin.$lte, new Date("2027-02-01T00:00:00.000Z"));
      return [expired, untouched];
    }
  };

  const result = await expireLaunchPlans(new Date("2027-02-01T00:00:00.000Z"), {
    UsuarioModel,
    applyLimits: async (userId, options) => applied.push({ userId, options }),
    logger: { info() {}, error() {} }
  });

  assert.deepEqual(result, { revisados: 2, expirados: 1, omitidos: 1 });
  assert.equal(expired.plan, "gratis");
  assert.equal(expired.planActivo, false);
  assert.equal(expired.planFechaFin, null);
  assert.equal(expired.saveCalls, 1);
  assert.deepEqual(applied, [{ userId: "expired", options: { planDestino: "gratis", now: new Date("2027-02-01T00:00:00.000Z") } }]);
  assert.equal(untouched.saveCalls, 0);
});

test("scheduler de expiración arranca una pasada inmediata y queda reutilizable", async () => {
  resetLaunchPlanSchedulerForTests();
  let runs = 0;
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
    logger: { info() {}, error() {} }
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runs, 1);
  assert.equal(scheduled.length, 1);
  assert.deepEqual(handle, { interval: 1000 });
  assert.equal(scheduleLaunchPlanExpiration(), handle);
  resetLaunchPlanSchedulerForTests();
});
