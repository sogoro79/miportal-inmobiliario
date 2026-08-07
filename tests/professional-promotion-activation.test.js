import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  activateProfessionalPromotion,
  calculateProfessionalPromotionEndsAt,
  deterministicPromotionHash,
  expireProfessionalPromotions,
  getProfessionalPromotionStatusForUser,
  getProfessionalPromotionPublicStatus,
  isProfessionalPromotionActive,
  normalizeSpanishIdentityDocument,
  normalizeSpanishMobile,
  PROFESSIONAL_PROMO_CAMPAIGN,
  PROFESSIONAL_PROMO_END_ISO,
  PROFESSIONAL_PROMO_PLAN
} from "../utils/professionalPromotion.js";
import { getKnownPlanIds, getLimiteAnunciosPlan, getLimiteFotosPlan, getPlanConfig } from "../utils/planLimits.js";

process.env.JWT_SECRET = "test-secret-professional-promotion";

function user(overrides = {}) {
  return {
    _id: "507f1f77bcf86cd799439011",
    nombre: "Responsable",
    email: "pro@example.com",
    role: "user",
    activo: true,
    verificado: true,
    plan: "gratis",
    planActivo: false,
    saveCalls: 0,
    async save() {
      this.saveCalls += 1;
      return this;
    },
    ...overrides
  };
}

function input(overrides = {}) {
  return {
    nombreComercial: "Inmobiliaria Test",
    responsableNombre: "Responsable Test",
    tipoProfesional: "inmobiliaria",
    telefonoMovil: "600 123 123",
    documento: "12345678Z",
    aceptaCondiciones: true,
    ...overrides
  };
}

function transactionClient({ failStart = false, withoutWithTransaction = false } = {}) {
  const calls = { startSession: 0, withTransaction: 0, endSession: 0 };
  return {
    calls,
    async startSession() {
      calls.startSession += 1;
      if (failStart) throw new Error("session unavailable");
      if (withoutWithTransaction) {
        return {
          async endSession() {
            calls.endSession += 1;
          }
        };
      }
      return {
        async withTransaction(fn) {
          calls.withTransaction += 1;
          return fn();
        },
        async endSession() {
          calls.endSession += 1;
        }
      };
    }
  };
}

function modelsFor({ usuario = user(), existingRedemption = null, duplicateOnCreate = false } = {}) {
  const calls = { created: [], updateOne: [], findOne: [] };
  const models = {
    Usuario: {
      async findById(id) {
        assert.equal(id, usuario._id);
        return usuario;
      }
    },
    ProfessionalTrialRedemption: {
      async findOne(filter) {
        calls.findOne.push(filter);
        return existingRedemption;
      },
      async create(docs) {
        if (duplicateOnCreate) {
          const err = new Error("E11000 duplicate key error");
          err.code = 11000;
          throw err;
        }
        calls.created.push(docs[0]);
        return [{ _id: "redemption-id", ...docs[0] }];
      },
      async updateOne(filter, update) {
        calls.updateOne.push({ filter, update });
        return { modifiedCount: 1 };
      }
    }
  };
  return { models, calls, usuario };
}

test("campaña profesional respeta fecha límite Madrid y 60 días exactos individuales", () => {
  assert.equal(PROFESSIONAL_PROMO_END_ISO, "2026-10-31T22:59:59.000Z");
  assert.equal(isProfessionalPromotionActive(new Date("2026-10-31T22:59:59.000Z")), true);
  assert.equal(isProfessionalPromotionActive(new Date("2026-10-31T23:00:00.000Z")), false);

  const activatedAt = new Date("2026-10-31T22:00:00.000Z");
  assert.equal(calculateProfessionalPromotionEndsAt(activatedAt).toISOString(), "2026-12-30T22:00:00.000Z");
});

test("DNI NIE y NIF se normalizan y validan con control", () => {
  assert.deepEqual(normalizeSpanishIdentityDocument(" 12-345-678 z "), {
    ok: true,
    type: "dni",
    normalized: "12345678Z"
  });
  assert.equal(normalizeSpanishIdentityDocument("12345678A").ok, false);
  assert.deepEqual(normalizeSpanishIdentityDocument("x 1234567 l"), {
    ok: true,
    type: "nie",
    normalized: "X1234567L"
  });
  assert.equal(normalizeSpanishIdentityDocument("X1234567A").ok, false);
  assert.deepEqual(normalizeSpanishIdentityDocument("A58818501"), {
    ok: true,
    type: "nif",
    normalized: "A58818501"
  });
  assert.equal(normalizeSpanishIdentityDocument("A58818502").ok, false);
});

test("móvil español se normaliza con +34 y detecta repetidos equivalentes", () => {
  assert.deepEqual(normalizeSpanishMobile("600 123 123"), { ok: true, normalized: "+34600123123" });
  assert.deepEqual(normalizeSpanishMobile("+34 600-123-123"), { ok: true, normalized: "+34600123123" });
  assert.deepEqual(normalizeSpanishMobile("0034 (700) 123 123"), { ok: true, normalized: "+34700123123" });
  assert.equal(normalizeSpanishMobile("956123123").ok, false);
});

test("professional_trial_60d es interno, no Stripe, ilimitado y no comercial", () => {
  assert.ok(getKnownPlanIds().includes(PROFESSIONAL_PROMO_PLAN));
  assert.equal(getLimiteAnunciosPlan(PROFESSIONAL_PROMO_PLAN), Infinity);
  assert.equal(getLimiteFotosPlan(PROFESSIONAL_PROMO_PLAN), Infinity);
  const config = getPlanConfig(PROFESSIONAL_PROMO_PLAN);
  assert.equal(config.nombre, "Promoción Profesional 60 días");
  assert.equal(config.visiblePublicamente, false);
  assert.equal(config.dependeDeStripe, false);
  assert.equal(config.planDestinoAlExpirar, "gratis");
});

test("estado público no expone PII y distingue email, datos, pago y móvil real no disponible", () => {
  const status = getProfessionalPromotionPublicStatus({
    usuario: user({ verificado: false }),
    input: input({ documento: "12345678Z", telefonoMovil: "600123123" })
  });

  assert.equal(status.emailNoVerificado, true);
  assert.equal(status.movilVerificadoRealDisponible, false);
  assert.equal("normalizedIdentityHash" in status, false);
  assert.equal("telefonoMovil" in status, false);
  assert.equal("numDoc" in status, false);

  const paid = getProfessionalPromotionPublicStatus({
    usuario: user({ plan: "starter", planActivo: true, stripeSubscriptionId: "sub_test", subscriptionStatus: "active" }),
    input: input()
  });
  assert.equal(paid.planPagoIncompatible, true);
});

test("activación crea redención histórica y asigna plan promocional sin Stripe", async () => {
  const { models, calls, usuario } = modelsFor();
  const result = await activateProfessionalPromotion({
    userId: usuario._id,
    input: input(),
    models,
    mongooseClient: transactionClient(),
    now: new Date("2026-08-07T10:00:00.000Z"),
    secret: process.env.JWT_SECRET
  });

  assert.equal(result.activada, true);
  assert.equal(result.plan, PROFESSIONAL_PROMO_PLAN);
  assert.equal(usuario.plan, PROFESSIONAL_PROMO_PLAN);
  assert.equal(usuario.planActivo, true);
  assert.equal(usuario.professionalPromoCampaign, PROFESSIONAL_PROMO_CAMPAIGN);
  assert.equal(usuario.numDoc, "12345678Z");
  assert.equal(usuario.telefonoMovil, "+34600123123");
  assert.equal(calls.created.length, 1);
  assert.equal(calls.created[0].normalizedIdentityHash.length, 64);
  assert.equal(calls.created[0].normalizedPhoneHash.length, 64);
  assert.notEqual(calls.created[0].normalizedIdentityHash, "12345678Z");
  assert.equal(calls.created[0].hmacKeyVersion, "jwt_secret_fallback_v1");
  assert.equal("stripeSubscriptionId" in calls.created[0], false);
});

test("activación aborta si no puede garantizar transacción MongoDB", async () => {
  const usuario = user();

  for (const mongooseClient of [null, transactionClient({ failStart: true }), transactionClient({ withoutWithTransaction: true })]) {
    const { models, calls } = modelsFor({ usuario });
    await assert.rejects(
      () => activateProfessionalPromotion({
        userId: usuario._id,
        input: input(),
        models,
        mongooseClient,
        secret: process.env.JWT_SECRET
      }),
      error => error.code === "transaction_required" &&
        error.message === "No se puede garantizar una activación atómica."
    );
    assert.equal(calls.created.length, 0);
    assert.equal(usuario.saveCalls, 0);
  }
});

test("activación bloquea admin, email no verificado, datos incompletos, pago y duplicados no enumerables", async () => {
  for (const [usuario, expectedCode] of [
    [user({ role: "admin" }), "admin_not_eligible"],
    [user({ verificado: false }), "email_not_verified"],
    [user({ plan: "starter", planActivo: true, stripeSubscriptionId: "sub", subscriptionStatus: "active" }), "paid_plan"]
  ]) {
    const { models } = modelsFor({ usuario });
    await assert.rejects(
      () => activateProfessionalPromotion({
        userId: usuario._id,
        input: input(),
        models,
        mongooseClient: transactionClient(),
        secret: process.env.JWT_SECRET
      }),
      error => error.code === expectedCode
    );
  }

  const incomplete = user();
  await assert.rejects(
    () => activateProfessionalPromotion({
      userId: incomplete._id,
      input: input({ aceptaCondiciones: false }),
      models: modelsFor({ usuario: incomplete }).models,
      mongooseClient: transactionClient(),
      secret: process.env.JWT_SECRET
    }),
    /Completa tus datos profesionales/
  );

  const duplicated = user();
  await assert.rejects(
    () => activateProfessionalPromotion({
      userId: duplicated._id,
      input: input(),
      models: modelsFor({ usuario: duplicated, duplicateOnCreate: true }).models,
      mongooseClient: transactionClient(),
      secret: process.env.JWT_SECRET
    }),
    error => error.code === "duplicate_redemption" &&
      error.message === "No es posible activar esta promoción con los datos facilitados."
  );
});

test("activación dentro de transacción no deja redención o usuario a medias si falla el guardado", async () => {
  const committedUser = user();
  const committedRedemptions = [];
  let stagedUser;
  let stagedRedemptions;

  const mongooseClient = {
    async startSession() {
      return {
        async withTransaction(fn) {
          stagedUser = {
            ...committedUser,
            saveCalls: 0,
            async save() {
              this.saveCalls += 1;
              throw new Error("save failed after redemption");
            }
          };
          stagedRedemptions = [...committedRedemptions];
          await fn({});
          Object.assign(committedUser, stagedUser);
          committedRedemptions.splice(0, committedRedemptions.length, ...stagedRedemptions);
        },
        async endSession() {}
      };
    }
  };
  const models = {
    Usuario: {
      async findById(id) {
        assert.equal(id, committedUser._id);
        return stagedUser;
      }
    },
    ProfessionalTrialRedemption: {
      async findOne() {
        return null;
      },
      async create(docs) {
        stagedRedemptions.push({ _id: "redemption-id", ...docs[0] });
        return [{ _id: "redemption-id", ...docs[0] }];
      }
    }
  };

  await assert.rejects(
    () => activateProfessionalPromotion({
      userId: committedUser._id,
      input: input(),
      models,
      mongooseClient,
      secret: process.env.JWT_SECRET
    }),
    /save failed after redemption/
  );

  assert.equal(committedUser.plan, "gratis");
  assert.equal(committedUser.professionalPromoStatus, undefined);
  assert.equal(committedRedemptions.length, 0);
});

test("activación dentro de transacción revierte si falla después de actualizar usuario", async () => {
  const committedUser = user();
  const committedRedemptions = [];
  let stagedUser;
  let stagedRedemptions;

  const mongooseClient = {
    async startSession() {
      return {
        async withTransaction(fn) {
          stagedUser = {
            ...committedUser,
            saveCalls: 0,
            async save() {
              this.saveCalls += 1;
              return this;
            }
          };
          stagedRedemptions = [...committedRedemptions];
          await fn({});
          throw new Error("commit failed after user update");
        },
        async endSession() {}
      };
    }
  };
  const models = {
    Usuario: {
      async findById() {
        return stagedUser;
      }
    },
    ProfessionalTrialRedemption: {
      async findOne() {
        return null;
      },
      async create(docs) {
        stagedRedemptions.push({ _id: "redemption-id", ...docs[0] });
        return [{ _id: "redemption-id", ...docs[0] }];
      }
    }
  };

  await assert.rejects(
    () => activateProfessionalPromotion({
      userId: committedUser._id,
      input: input(),
      models,
      mongooseClient,
      secret: process.env.JWT_SECRET
    }),
    /commit failed after user update/
  );

  assert.equal(stagedUser.plan, PROFESSIONAL_PROMO_PLAN);
  assert.equal(committedUser.plan, "gratis");
  assert.equal(committedUser.professionalPromoStatus, undefined);
  assert.equal(committedRedemptions.length, 0);
});

test("hash HMAC determinista permite recordar identidad y móvil tras borrar Usuario sin guardar PII en redención", () => {
  const identity = normalizeSpanishIdentityDocument("12 345 678-Z").normalized;
  const phone = normalizeSpanishMobile("+34 600 123 123").normalized;
  const identityHashA = deterministicPromotionHash(identity, { secret: process.env.JWT_SECRET, purpose: "identity" });
  const identityHashB = deterministicPromotionHash("12345678Z", { secret: process.env.JWT_SECRET, purpose: "identity" });
  const phoneHash = deterministicPromotionHash(phone, { secret: process.env.JWT_SECRET, purpose: "mobile" });

  assert.equal(identityHashA, identityHashB);
  assert.equal(identityHashA.length, 64);
  assert.equal(phoneHash.length, 64);
  assert.equal(identityHashA.includes(identity), false);
  assert.equal(phoneHash.includes(phone), false);
});

test("redención persiste versión HMAC e índices únicos por campaña sin PII normalizada", () => {
  const model = fs.readFileSync(new URL("../models/ProfessionalTrialRedemption.js", import.meta.url), "utf8");

  assert.match(model, /normalizedIdentityHash:[\s\S]*required: true/);
  assert.match(model, /normalizedPhoneHash:[\s\S]*required: true/);
  assert.match(model, /hmacKeyVersion:[\s\S]*required: true/);
  assert.match(model, /campaign: 1, normalizedIdentityHash: 1[\s\S]*unique: true/);
  assert.match(model, /campaign: 1, normalizedPhoneHash: 1[\s\S]*unique: true/);
  assert.doesNotMatch(model, /normalizedIdentityDocument|normalizedPhone(?!Hash)|documento|telefonoMovil/);
});

test("búsqueda de estado puede reconocer hashes legacy sin exponer NIF ni móvil", async () => {
  const previousLegacy = process.env.PROFESSIONAL_PROMO_HMAC_LEGACY_SECRETS;
  process.env.PROFESSIONAL_PROMO_HMAC_LEGACY_SECRETS = "old-secret-professional";
  const usuario = user();
  const calls = [];
  const models = {
    Usuario: { async findById() { return usuario; } },
    ProfessionalTrialRedemption: {
      async findOne(filter) {
        calls.push(filter);
        return null;
      }
    }
  };

  try {
    await getProfessionalPromotionStatusForUser({
      userId: usuario._id,
      input: input(),
      models
    });
  } finally {
    if (previousLegacy === undefined) {
      delete process.env.PROFESSIONAL_PROMO_HMAC_LEGACY_SECRETS;
    } else {
      process.env.PROFESSIONAL_PROMO_HMAC_LEGACY_SECRETS = previousLegacy;
    }
  }

  assert.equal(calls[0].normalizedIdentityHash.$in.length, 2);
  assert.equal(calls[1].normalizedPhoneHash.$in.length, 2);
  assert.doesNotMatch(JSON.stringify(calls), /12345678Z|\+34600123123/);
});

test("redenciones sobreviven al borrado de Usuario y bloquean reutilizar NIF o móvil", async () => {
  const existingIdentityHash = deterministicPromotionHash("12345678Z", {
    secret: process.env.JWT_SECRET,
    purpose: "identity"
  });
  const existingPhoneHash = deterministicPromotionHash("+34600123123", {
    secret: process.env.JWT_SECRET,
    purpose: "mobile"
  });
  const usuarioB = user({ _id: "507f1f77bcf86cd799439022", email: "second@example.com" });
  const models = {
    Usuario: { async findById() { return usuarioB; } },
    ProfessionalTrialRedemption: {
      async findOne(filter) {
        if (filter.normalizedIdentityHash?.$in?.includes(existingIdentityHash)) return { _id: "deleted-user-redemption" };
        if (filter.normalizedPhoneHash?.$in?.includes(existingPhoneHash)) return { _id: "deleted-user-redemption" };
        return null;
      }
    }
  };

  const status = await getProfessionalPromotionStatusForUser({
    userId: usuarioB._id,
    input: input(),
    models,
    secret: process.env.JWT_SECRET
  });

  assert.equal(status.documentoYaUsado, true);
  assert.equal(status.movilYaUsado, true);
  assert.equal(status.eligible, false);
  assert.equal("email" in status, false);
});

test("expiración es idempotente, vuelve a Gratis y aplica límites sin borrar propiedades", async () => {
  const usuario = user({
    plan: PROFESSIONAL_PROMO_PLAN,
    planActivo: true,
    professionalPromoStatus: "active",
    professionalPromoEndsAt: new Date("2026-08-01T00:00:00.000Z")
  });
  const calls = { limits: 0, updateOne: 0 };
  const models = {
    Usuario: {
      async find(filter) {
        assert.equal(filter.plan, PROFESSIONAL_PROMO_PLAN);
        return [usuario];
      }
    },
    ProfessionalTrialRedemption: {
      async updateOne(filter, update) {
        calls.updateOne += 1;
        assert.equal(filter.userId, usuario._id);
        assert.equal(update.$set.status, "expired");
      }
    }
  };

  const result = await expireProfessionalPromotions(new Date("2026-08-07T00:00:00.000Z"), {
    models,
    applyLimits: async (userId, options) => {
      calls.limits += 1;
      assert.equal(userId, usuario._id);
      assert.equal(options.planDestino, "gratis");
      return { ok: true };
    },
    logger: { info() {} }
  });

  assert.equal(result.expiradas, 1);
  assert.equal(usuario.plan, "gratis");
  assert.equal(usuario.planActivo, false);
  assert.equal(usuario.professionalPromoStatus, "expired");
  assert.equal(calls.limits, 1);
  assert.equal(calls.updateOne, 1);
});

test("expiración no sobrescribe un estado de pago posterior", async () => {
  const usuario = user({
    plan: PROFESSIONAL_PROMO_PLAN,
    planActivo: true,
    stripeSubscriptionId: "sub_real",
    subscriptionStatus: "active",
    professionalPromoStatus: "active",
    professionalPromoEndsAt: new Date("2026-08-01T00:00:00.000Z")
  });

  const result = await expireProfessionalPromotions(new Date("2026-08-07T00:00:00.000Z"), {
    models: {
      Usuario: { async find() { return [usuario]; } },
      ProfessionalTrialRedemption: { async updateOne() { throw new Error("should not update redemption"); } }
    },
    applyLimits: async () => { throw new Error("should not apply free limits"); },
    logger: { info() {} }
  });

  assert.equal(result.omitidasPorPago, 1);
  assert.equal(usuario.plan, PROFESSIONAL_PROMO_PLAN);
  assert.equal(usuario.professionalPromoStatus, "converted");
});

test("scheduler de expiración no selecciona usuarios que ya pasaron a plan de pago", async () => {
  const usuarioPagadoPosterior = user({
    plan: "starter",
    planActivo: true,
    stripeSubscriptionId: "sub_real",
    subscriptionStatus: "active",
    professionalPromoStatus: "active",
    professionalPromoEndsAt: new Date("2026-08-01T00:00:00.000Z")
  });
  let query;

  const result = await expireProfessionalPromotions(new Date("2026-08-07T00:00:00.000Z"), {
    models: {
      Usuario: {
        async find(filter) {
          query = filter;
          return [];
        }
      },
      ProfessionalTrialRedemption: { async updateOne() { throw new Error("should not update redemption"); } }
    },
    applyLimits: async () => { throw new Error("should not apply free limits"); },
    logger: { info() {} }
  });

  assert.equal(query.plan, PROFESSIONAL_PROMO_PLAN);
  assert.equal(result.revisadas, 0);
  assert.equal(usuarioPagadoPosterior.plan, "starter");
  assert.equal(usuarioPagadoPosterior.professionalPromoStatus, "active");
});

test("rutas, frontend y admin de promoción no contienen Stripe Cloudinary SMS ni PII en salidas", () => {
  const route = fs.readFileSync(new URL("../routes/professionalPromotion.js", import.meta.url), "utf8");
  const util = fs.readFileSync(new URL("../utils/professionalPromotion.js", import.meta.url), "utf8");
  const page = fs.readFileSync(new URL("../public/profesionales.html", import.meta.url), "utf8");
  const flow = fs.readFileSync(new URL("../public/js/professional-promotion-flow.js", import.meta.url), "utf8");
  const admin = fs.readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

  assert.match(server, /app\.use\("\/api\/promocion-profesional", professionalPromotionRoutes\)/);
  assert.match(server, /scheduleProfessionalPromotionExpiration\(\)/);
  assert.match(route, /securityRateLimits\.professionalPromotionActivation/);
  assert.doesNotMatch(route + flow, /Stripe|cloudinary|twilio|sms|sendSms|Cloudinary/i);
  assert.doesNotMatch(util, /new Stripe|stripe\.|cloudinary|twilio|sendSms|enviarSms/i);
  assert.match(page, /Activa tu Promoción Profesional 60 días/);
  assert.match(flow, /Activar mis 60 días gratis|STATUS_URL|ACTIVATE_URL/);
  assert.match(admin, /Promoción Profesional 60 días/);
  assert.match(admin, /No se muestran documentos, teléfonos, hashes ni IP/);
  assert.doesNotMatch(flow, /normalizedIdentityHash|normalizedPhoneHash/);
});
