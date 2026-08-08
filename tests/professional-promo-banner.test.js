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

test("promoción profesional usa la imagen oficial y CTA HTML real en home", () => {
  assert.match(indexHtml, /data-professional-promo/);
  assert.match(indexHtml, /src="\/img\/promociones\/Promocion_60_dias_banner\.jpg"/);
  assert.match(indexHtml, /alt="Promoción Profesional 60 días gratis para profesionales e inmobiliarias en HomeClick24"/);
  assert.match(indexHtml, /<a class="professional-promo-media" href="\/registro\?promo=professional-60" data-professional-promo-cta aria-label="Ver Promoción Profesional 60 días">/);
  assert.match(indexHtml, /<a class="professional-promo-cta" href="\/registro\?promo=professional-60" data-professional-promo-cta>Quiero mis 60 días gratis<\/a>/);
  assert.match(indexHtml, /Si eres profesional o inmobiliaria, regístrate hasta el 31 de octubre/);
  assert.match(indexHtml, /Sin tarjeta\. Sin permanencia\. Activación sujeta a verificación profesional\./);
  assert.match(indexHtml, /Promoción limitada a una prueba por profesional o empresa/);
});

test("promoción profesional aparece tras el hero y antes de secciones secundarias", () => {
  const heroIndex = indexHtml.indexOf("<section class=\"hero\"");
  const promoIndex = indexHtml.indexOf("class=\"professional-promo-home\"");
  const destacadasIndex = indexHtml.indexOf("id=\"homeDestacadasTitulo\"");

  assert.ok(heroIndex > -1);
  assert.ok(promoIndex > heroIndex);
  assert.ok(destacadasIndex > promoIndex);
});

test("promoción profesional compacta solo la presentación móvil sin cambiar CTA", () => {
  assert.match(indexHtml, /@media \(max-width: 768px\) \{[\s\S]*?\.professional-promo-home \{[\s\S]*?margin-top: 18px/);
  assert.match(indexHtml, /@media \(max-width: 768px\) \{[\s\S]*?\.professional-promo-media img \{[\s\S]*?max-height: 220px/);
  assert.match(indexHtml, /@media \(max-width: 768px\) \{[\s\S]*?\.professional-promo-cta \{[\s\S]*?width: 100%/);
  assert.match(indexHtml, /@media \(max-width: 480px\) \{[\s\S]*?\.professional-promo-media img \{[\s\S]*?max-height: 170px/);
  assert.match(indexHtml, /<a class="professional-promo-cta" href="\/registro\?promo=professional-60" data-professional-promo-cta>Quiero mis 60 días gratis<\/a>/);
});

test("planes muestra versión compacta sin duplicar la imagen grande", () => {
  assert.match(planesHtml, /class="planes-promo-profesional"/);
  assert.match(planesHtml, /data-professional-promo/);
  assert.match(planesHtml, /Quiero mis 60 días gratis/);
  assert.doesNotMatch(planesHtml, /Promocion_60_dias_banner\.jpg/);
});

test("fecha de fin de campaña está centralizada y activa hasta 31 de octubre de 2026 Madrid", () => {
  const { context } = createPromoContext();

  assert.equal(context.HomeClickProfessionalPromo.PROMO_END_ISO, "2026-10-31T22:59:59.000Z");
  assert.equal(context.HomeClickProfessionalPromo.isProfessionalPromoActive(new Date("2026-10-31T22:59:59.000Z")), true);
  assert.equal(context.HomeClickProfessionalPromo.isProfessionalPromoActive(new Date("2026-10-31T23:00:00.000Z")), false);
  assert.doesNotMatch(indexHtml, /2026-10-31T22:59:59\.000Z/);
  assert.doesNotMatch(planesHtml, /2026-10-31T22:59:59\.000Z/);
});

test("campaña activa muestra banner y expirada lo oculta", () => {
  const { context } = createPromoContext();
  const section = { hidden: null, attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } };
  const link = { href: "", addEventListener(type, fn) { this.listener = { type, fn }; } };
  const imageLink = { href: "", addEventListener(type, fn) { this.listener = { type, fn }; } };
  const root = {
    querySelectorAll(selector) {
      if (selector === "[data-professional-promo]") return [section];
      if (selector === "[data-professional-promo-cta]") return [imageLink, link];
      return [];
    }
  };

  context.HomeClickProfessionalPromo.setupProfessionalPromo(root, new Date("2026-08-07T12:00:00.000Z"));
  assert.equal(section.hidden, false);
  assert.equal(section.attrs["aria-hidden"], "false");
  assert.equal(imageLink.href, "/registro?promo=professional-60");
  assert.equal(link.href, "/registro?promo=professional-60");

  context.HomeClickProfessionalPromo.setupProfessionalPromo(root, new Date("2026-11-01T00:00:00.000Z"));
  assert.equal(section.hidden, true);
  assert.equal(section.attrs["aria-hidden"], "true");
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
  assert.match(registroHtml, /data-professional-promo-notice/);
  assert.match(registroHtml, /<a href="\/login" data-professional-promo-login>Iniciar sesión<\/a>/);
  assert.match(registroHtml, /<script src="\/js\/professional-promo\.js"><\/script>/);
});

test("login promocional muestra opción de crear cuenta conservando promo", () => {
  assert.match(loginHtml, /Estás accediendo a la Promoción Profesional 60 días\./);
  assert.match(loginHtml, /data-professional-promo-notice/);
  assert.match(loginHtml, /<a href="\/registro" data-professional-promo-register>Crear cuenta gratis<\/a>/);
  assert.match(loginHtml, /<script src="\/js\/professional-promo\.js"><\/script>[\s\S]*<script src="\/js\/auth\.js"><\/script>/);
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
  assert.match(setPasswordHtml, /window\.HomeClickProfessionalPromo\?\.hasProfessionalPromoIntent\?\.\(\)[\s\S]*\/login\?promo=professional-60/);
  assert.doesNotMatch(setPasswordHtml, /promocion-profesional\/activar|professionalTrialStartedAt|professionalTrialEndsAt|Stripe|Cloudinary/i);
});

test("CTA recuerda origen de promoción sin activar todavía la campaña", () => {
  const { context, storage } = createPromoContext();

  context.HomeClickProfessionalPromo.rememberProfessionalPromoIntent();
  assert.equal(storage.get(context.HomeClickProfessionalPromo.PROMO_INTENT_KEY), "true");
  assert.doesNotMatch(promoJs, /professionalTrialUsed|professionalTrialStartedAt|professionalTrialEndsAt|NIF|DNI|NIE|stripe/i);
});
