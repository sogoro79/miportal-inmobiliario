import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const indexHtml = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const planesHtml = fs.readFileSync(new URL("../public/planes.html", import.meta.url), "utf8");
const registroHtml = fs.readFileSync(new URL("../public/registro.html", import.meta.url), "utf8");
const loginHtml = fs.readFileSync(new URL("../public/login.html", import.meta.url), "utf8");
const setPasswordHtml = fs.readFileSync(new URL("../public/set-password.html", import.meta.url), "utf8");
const promoJs = fs.readFileSync(new URL("../public/js/professional-promo.js", import.meta.url), "utf8");
const launchPlanJs = fs.readFileSync(new URL("../public/js/launch-plan.js", import.meta.url), "utf8");
const authJs = fs.readFileSync(new URL("../public/js/auth.js", import.meta.url), "utf8");

function createPromoContext(initialStorage = {}, { search = "" } = {}) {
  const storage = new Map(Object.entries(initialStorage));
  const listeners = {};
  const document = {
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
    querySelectorAll() {
      return [];
    }
  };
  const context = {
    window: {},
    document,
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      }
    },
    Date,
    URL,
    URLSearchParams,
    location: { search, href: "" }
  };
  context.window = context;
  vm.runInNewContext(promoJs, context);
  return { context, storage, listeners };
}

function createLaunchContext(initialStorage = {}, { search = "" } = {}) {
  const storage = new Map(Object.entries(initialStorage));
  const listeners = {};
  const document = {
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
    querySelectorAll() {
      return [];
    }
  };
  const context = {
    window: {},
    document,
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      }
    },
    Date,
    URL,
    URLSearchParams,
    location: { search, href: "" }
  };
  context.window = context;
  vm.runInNewContext(launchPlanJs, context);
  return { context, storage, listeners };
}

test("Plan Lanzamiento usa CTA HTML real en home sin activar automáticamente", () => {
  assert.match(indexHtml, /data-launch-plan/);
  assert.match(indexHtml, /Publica gratis hasta el 31 de enero de 2027/);
  assert.match(indexHtml, /Únete al Plan Lanzamiento de HomeClick24 y anuncia tu vivienda de forma sencilla y sin coste\./);
  assert.match(indexHtml, /Para particulares e inmobiliarias de toda España\./);
  assert.match(indexHtml, /Gratis hasta el 31 de enero de 2027\. Después pasarás al plan gratuito\. No hay renovación automática ni cargos\./);
  assert.match(indexHtml, /<a class="professional-promo-cta" href="\/registro\?plan=lanzamiento_2026" data-launch-plan-cta>Publicar gratis<\/a>/);
  assert.doesNotMatch(indexHtml, /31 de octubre|Promocion_60_dias_banner\.jpg|professional-60/);
});

test("promoción profesional aparece tras el hero y antes de secciones secundarias", () => {
  const heroIndex = indexHtml.indexOf("<section class=\"hero\"");
  const promoIndex = indexHtml.indexOf("class=\"professional-promo-home\"");
  const destacadasIndex = indexHtml.indexOf("id=\"homeDestacadasTitulo\"");

  assert.ok(heroIndex > -1);
  assert.ok(promoIndex > heroIndex);
  assert.ok(destacadasIndex > promoIndex);
});

test("Plan Lanzamiento compacta solo la presentación móvil sin cambiar CTA", () => {
  assert.match(indexHtml, /@media \(max-width: 768px\) \{[\s\S]*?\.professional-promo-home \{[\s\S]*?margin-top: 18px/);
  assert.match(indexHtml, /@media \(max-width: 768px\) \{[\s\S]*?\.professional-promo-cta \{[\s\S]*?width: 100%/);
  assert.match(indexHtml, /<a class="professional-promo-cta" href="\/registro\?plan=lanzamiento_2026" data-launch-plan-cta>Publicar gratis<\/a>/);
});

test("planes muestra versión compacta del Plan Lanzamiento sin duplicar imágenes", () => {
  assert.match(planesHtml, /class="planes-promo-profesional"/);
  assert.match(planesHtml, /data-launch-plan/);
  assert.match(planesHtml, /Plan Lanzamiento/);
  assert.match(planesHtml, /Activar gratis/);
  assert.doesNotMatch(planesHtml, /Promocion_60_dias_banner\.jpg/);
});

test("fecha de fin del Plan Lanzamiento está centralizada y activa hasta enero de 2027 Madrid", () => {
  const { context } = createLaunchContext();

  assert.equal(context.HomeClickLaunchPlan.END_ISO, "2027-01-31T22:59:59.000Z");
  assert.equal(context.HomeClickLaunchPlan.isLaunchPlanAvailable(new Date("2027-01-31T22:59:59.000Z")), true);
  assert.equal(context.HomeClickLaunchPlan.isLaunchPlanAvailable(new Date("2027-01-31T23:00:00.000Z")), false);
  assert.doesNotMatch(indexHtml, /2027-01-31T22:59:59\.000Z/);
  assert.doesNotMatch(planesHtml, /2027-01-31T22:59:59\.000Z/);
});

test("campaña Plan Lanzamiento activa muestra banner y expirada lo oculta", () => {
  const { context } = createLaunchContext();
  const section = { hidden: null, attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } };
  const link = { href: "", addEventListener(type, fn) { this.listener = { type, fn }; } };
  const root = {
    querySelectorAll(selector) {
      if (selector === "[data-launch-plan]") return [section];
      if (selector === "[data-launch-plan-cta]") return [link];
      return [];
    }
  };

  context.HomeClickLaunchPlan.setupLaunchPlan(root, new Date("2026-11-07T12:00:00.000Z"));
  assert.equal(section.hidden, false);
  assert.equal(section.attrs["aria-hidden"], "false");
  assert.equal(link.href, "/registro?plan=lanzamiento_2026");

  context.HomeClickLaunchPlan.setupLaunchPlan(root, new Date("2027-02-01T00:00:00.000Z"));
  assert.equal(section.hidden, true);
  assert.equal(section.attrs["aria-hidden"], "true");
});

test("CTA de Plan Lanzamiento conserva intención y distingue visitante/autenticado", () => {
  const visitor = createLaunchContext();
  assert.equal(visitor.context.HomeClickLaunchPlan.launchPlanTarget(), "/registro?plan=lanzamiento_2026");

  const authenticated = createLaunchContext({ token: "jwt-test" });
  assert.equal(authenticated.context.HomeClickLaunchPlan.launchPlanTarget(), "/planes?activar=lanzamiento_2026");

  const login = createLaunchContext({}, { search: "?plan=lanzamiento_2026" });
  assert.equal(login.context.HomeClickLaunchPlan.launchPlanLoginRedirectTarget("/"), "/planes?activar=lanzamiento_2026");
  assert.match(authJs, /launchPlanLoginRedirectTarget\("\/"\)/);
  assert.doesNotMatch(launchPlanJs, /api\/plan-lanzamiento\/activar|stripe|cloudinary/i);
});

test("CTA visitante va a registro y CTA autenticado nunca va a registro ni login", () => {
  const visitor = createPromoContext();
  assert.equal(visitor.context.HomeClickProfessionalPromo.professionalPromoTarget(), "/registro?promo=professional-60");

  const authenticated = createPromoContext({ token: "jwt-test" });
  const target = authenticated.context.HomeClickProfessionalPromo.professionalPromoTarget();
  assert.equal(target, "/profesionales?promo=professional-60");
  assert.doesNotMatch(target, /registro|login/);
});

test("registro promocional muestra opción de iniciar sesión conservando promo", () => {
  assert.match(registroHtml, /Estás accediendo a la Promoción Profesional 60 días\./);
  assert.match(registroHtml, /Estás accediendo al Plan Lanzamiento gratis hasta el 31 de enero de 2027\./);
  assert.match(registroHtml, /data-professional-promo-notice/);
  assert.match(registroHtml, /data-launch-plan-notice/);
  assert.match(registroHtml, /<a href="\/login" data-professional-promo-login data-launch-plan-login>Iniciar sesión<\/a>/);
  assert.match(registroHtml, /<script src="\/js\/professional-promo\.js"><\/script>/);
  assert.match(registroHtml, /<script src="\/js\/launch-plan\.js"><\/script>/);
});

test("login promocional muestra opción de crear cuenta conservando promo", () => {
  assert.match(loginHtml, /Estás accediendo a la Promoción Profesional 60 días\./);
  assert.match(loginHtml, /Estás accediendo al Plan Lanzamiento gratis hasta el 31 de enero de 2027\./);
  assert.match(loginHtml, /data-professional-promo-notice/);
  assert.match(loginHtml, /data-launch-plan-notice/);
  assert.match(loginHtml, /<a href="\/registro" data-professional-promo-register data-launch-plan-register>Crear cuenta gratis<\/a>/);
  assert.match(loginHtml, /<script src="\/js\/professional-promo\.js"><\/script>[\s\S]*<script src="\/js\/launch-plan\.js"><\/script>[\s\S]*<script src="\/js\/auth\.js"><\/script>/);
});

test("helper conserva intención promocional en registro, login y avisos", () => {
  const { context, storage } = createPromoContext({}, { search: "?promo=professional-60" });
  const notice = { hidden: true };
  const registerLink = { href: "" };
  const loginLink = { href: "" };
  const root = {
    querySelectorAll(selector) {
      if (selector === "[data-professional-promo]") return [];
      if (selector === "[data-professional-promo-cta]") return [];
      if (selector === "[data-professional-promo-register]") return [registerLink];
      if (selector === "[data-professional-promo-login]") return [loginLink];
      if (selector === "[data-professional-promo-notice]") return [notice];
      return [];
    }
  };

  context.HomeClickProfessionalPromo.setupProfessionalPromo(root);
  assert.equal(storage.get(context.HomeClickProfessionalPromo.PROMO_INTENT_KEY), "true");
  assert.equal(notice.hidden, false);
  assert.equal(registerLink.href, "/registro?promo=professional-60");
  assert.equal(loginLink.href, "/login?promo=professional-60");
});

test("login correcto desde promo redirige a profesionales y no activa la promoción", () => {
  const { context, storage } = createPromoContext({}, { search: "?promo=professional-60" });

  assert.equal(context.HomeClickProfessionalPromo.professionalPromoLoginRedirectTarget("/"), "/profesionales?promo=professional-60");
  assert.match(authJs, /professionalPromoLoginRedirectTarget\("\/"\)/);
  assert.doesNotMatch(authJs, /activar|promocion-profesional\/activar|professionalTrialStartedAt|professionalTrialEndsAt/i);

  const returning = createPromoContext({ [context.HomeClickProfessionalPromo.PROMO_INTENT_KEY]: "true" });
  assert.equal(returning.context.HomeClickProfessionalPromo.professionalPromoLoginRedirectTarget("/"), "/profesionales?promo=professional-60");
  assert.equal(storage.get(context.HomeClickProfessionalPromo.PROMO_INTENT_KEY), undefined);
});

test("verificación de email conserva la intención para el login posterior sin activar nada", () => {
  assert.match(setPasswordHtml, /<script src="\/js\/professional-promo\.js"><\/script>/);
  assert.match(setPasswordHtml, /<script src="\/js\/launch-plan\.js"><\/script>/);
  assert.match(setPasswordHtml, /window\.HomeClickLaunchPlan\?\.hasLaunchPlanIntent\?\.\(\)[\s\S]*\/login\?plan=lanzamiento_2026/);
  assert.match(setPasswordHtml, /window\.HomeClickProfessionalPromo\?\.hasProfessionalPromoIntent\?\.\(\)[\s\S]*\/login\?promo=professional-60/);
  assert.doesNotMatch(setPasswordHtml, /promocion-profesional\/activar|professionalTrialStartedAt|professionalTrialEndsAt|Stripe|Cloudinary/i);
  assert.doesNotMatch(setPasswordHtml, /api\/plan-lanzamiento\/activar/i);
});

test("CTA recuerda origen de promoción sin activar todavía la campaña", () => {
  const { context, storage } = createPromoContext();

  context.HomeClickProfessionalPromo.rememberProfessionalPromoIntent();
  assert.equal(storage.get(context.HomeClickProfessionalPromo.PROMO_INTENT_KEY), "true");
  assert.doesNotMatch(promoJs, /professionalTrialUsed|professionalTrialStartedAt|professionalTrialEndsAt|NIF|DNI|NIE|stripe/i);
});
