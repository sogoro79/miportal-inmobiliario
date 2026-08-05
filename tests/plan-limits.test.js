import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Readable, Writable } from "node:stream";
import {
  getDuracionAnunciosDiasPlan,
  getKnownPlanIds,
  getLimiteAnunciosPlan,
  getLimiteFotosPlan,
  getPlanLimits,
  getPlanConfig,
  getPublicPlanCatalog,
  planTieneLimiteFotos
} from "../utils/planLimits.js";

process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret";
process.env.RESEND_API_KEY = "re_test";
process.env.STRIPE_SECRET_KEY = "sk_test_123";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";

const { default: app } = await import("../server.js");

const EXPECTED_LIMITS = {
  gratis: { anuncios: 2, fotos: 7, duracionAnunciosDias: 15, categoria: "particular", stripe: false, trial: false },
  basico: { anuncios: 3, fotos: 10, duracionAnunciosDias: null, categoria: "particular", stripe: true, trial: false },
  destacado: { anuncios: 4, fotos: 15, duracionAnunciosDias: null, categoria: "particular", stripe: true, trial: false },
  starter: { anuncios: 15, fotos: 20, duracionAnunciosDias: null, categoria: "profesional", stripe: true, trial: false },
  pro_agentes: { anuncios: 40, fotos: 30, duracionAnunciosDias: null, categoria: "profesional", stripe: true, trial: false },
  agencia_basica: { anuncios: 50, fotos: 40, duracionAnunciosDias: null, categoria: "profesional", stripe: true, trial: false },
  agencia_pro: { anuncios: Infinity, fotos: 50, duracionAnunciosDias: null, categoria: "profesional", stripe: false, trial: false },
  vip_trial: { anuncios: Infinity, fotos: Infinity, duracionAnunciosDias: null, categoria: "interno", stripe: false, trial: true },
  vip: { anuncios: Infinity, fotos: Infinity, duracionAnunciosDias: null, categoria: "interno", stripe: false, trial: false }
};
const COMMERCIAL_PLAN_IDS = ["gratis", "basico", "destacado", "starter", "pro_agentes", "agencia_basica"];

function createReq(path) {
  const req = new Readable({
    read() {
      this.push(null);
    }
  });
  req.method = "GET";
  req.url = path;
  req.originalUrl = path;
  req.headers = {};
  req.socket = { remoteAddress: "127.0.0.1" };
  return req;
}

function createRes(resolve) {
  const chunks = [];
  const headers = new Map();
  const res = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      callback();
    }
  });
  res.statusCode = 200;
  res.setHeader = (name, value) => headers.set(String(name).toLowerCase(), String(value));
  res.getHeader = name => headers.get(String(name).toLowerCase());
  res.getHeaders = () => Object.fromEntries(headers);
  res.removeHeader = name => headers.delete(String(name).toLowerCase());
  res.writeHead = (statusCode, nextHeaders = {}) => {
    res.statusCode = statusCode;
    Object.entries(nextHeaders || {}).forEach(([name, value]) => res.setHeader(name, value));
    return res;
  };
  const originalEnd = res.end.bind(res);
  res.end = (chunk, encoding, callback) => {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    originalEnd(undefined, encoding, callback);
    resolve({
      status: res.statusCode,
      text: Buffer.concat(chunks).toString("utf8"),
      headers
    });
    return res;
  };
  return res;
}

function request(path) {
  return new Promise((resolve, reject) => {
    app.handle(createReq(path), createRes(resolve), reject);
  });
}

test("catálogo central contiene todos los planes conocidos con límites exactos", () => {
  assert.deepEqual(getKnownPlanIds(), Object.keys(EXPECTED_LIMITS));

  for (const [plan, expected] of Object.entries(EXPECTED_LIMITS)) {
    const config = getPlanConfig(plan);
    assert.equal(getLimiteAnunciosPlan(plan), expected.anuncios, plan);
    assert.equal(getLimiteFotosPlan(plan), expected.fotos, plan);
    assert.equal(getDuracionAnunciosDiasPlan(plan), expected.duracionAnunciosDias, plan);
    assert.equal(config.categoria, expected.categoria, plan);
    assert.equal(config.dependeDeStripe, expected.stripe, plan);
    assert.equal(config.esTrial, expected.trial, plan);
  }
});

test("exports históricos de límites conservan compatibilidad", () => {
  assert.deepEqual(getPlanLimits("basico"), {
    anuncios: 3,
    fotos: 10,
    duracionAnunciosDias: null
  });
  assert.deepEqual(getPlanLimits("inventado"), {
    anuncios: 2,
    fotos: 7,
    duracionAnunciosDias: 15
  });
});

test("plan desconocido cae a gratis sin romper límites ni downgrade", () => {
  assert.equal(getLimiteAnunciosPlan("inventado"), 2);
  assert.equal(getLimiteFotosPlan("inventado"), 7);
  assert.equal(getDuracionAnunciosDiasPlan("inventado"), 15);
  assert.equal(getPlanConfig("inventado").id, "gratis");
});

test("planes ilimitados y downgrade de vip_trial se expresan de forma estable", () => {
  assert.equal(getLimiteAnunciosPlan("agencia_pro"), Infinity);
  assert.equal(getLimiteFotosPlan("vip"), Infinity);
  assert.equal(getLimiteAnunciosPlan("vip_trial"), Infinity);
  assert.equal(getLimiteFotosPlan("vip_trial"), Infinity);
  assert.equal(planTieneLimiteFotos("vip_trial"), false);
  assert.equal(getPlanConfig("vip_trial").planDestinoAlExpirar, "gratis");
});

test("catálogo público no serializa infinitos ni expone secretos", () => {
  const catalogo = getPublicPlanCatalog();
  const json = JSON.stringify(catalogo);
  const vipTrial = catalogo.find(plan => plan.id === "vip_trial");

  assert.ok(vipTrial);
  assert.equal(vipTrial.anuncios, null);
  assert.equal(vipTrial.fotos, null);
  assert.equal(vipTrial.ilimitadoAnuncios, true);
  assert.equal(vipTrial.ilimitadoFotos, true);
  assert.doesNotMatch(json, /STRIPE_|PRICE|sk_test|whsec|secret|coupon/i);
});

test("endpoint público de catálogo devuelve solo información pública de planes", async () => {
  const response = await request("/api/planes/catalogo");
  assert.equal(response.status, 200);

  const data = JSON.parse(response.text);
  assert.equal(Array.isArray(data.planes), true);
  assert.equal(data.planes.length, getKnownPlanIds().length);

  const basico = data.planes.find(plan => plan.id === "basico");
  assert.equal(basico.nombre, "Básico");
  assert.equal(basico.fotos, 10);
  assert.equal(basico.dependeDeStripe, true);
  assert.equal("stripePriceId" in basico, false);
  assert.equal("priceId" in basico, false);
  assert.doesNotMatch(response.text, /STRIPE_|sk_|whsec|RESEND|MONGODB|JWT/i);
});

test("frontend consume el catálogo público, conserva fallbacks y no mantiene límites divergentes", () => {
  const planesHtml = fs.readFileSync(new URL("../public/planes.html", import.meta.url), "utf8");
  const perfilHtml = fs.readFileSync(new URL("../public/perfil.html", import.meta.url), "utf8");
  const publicarHtml = fs.readFileSync(new URL("../public/publicar.html", import.meta.url), "utf8");

  assert.match(planesHtml, /\/api\/planes\/catalogo/);
  assert.match(perfilHtml, /\/api\/planes\/catalogo/);
  assert.match(publicarHtml, /\/api\/planes\/catalogo/);
  assert.doesNotMatch(planesHtml, /20 fotos por anuncio|30 fotos por anuncio|40 fotos por anuncio/);
  assert.doesNotMatch(perfilHtml, /PLANES_INFO/);
  assert.doesNotMatch(publicarHtml, /LIMITE_FOTOS/);
  assert.match(planesHtml, /FALLBACK_PLANES_COMERCIALES/);
  assert.match(perfilHtml, /FALLBACK_PLANES_PERFIL/);
  assert.match(publicarHtml, /FALLBACK_PLANES_PUBLICAR/);
});

test("planes.html usa fallback comercial completo ante catálogo fallido o vacío", () => {
  const planesHtml = fs.readFileSync(new URL("../public/planes.html", import.meta.url), "utf8");

  assert.match(planesHtml, /catch \(error\)[\s\S]*FALLBACK_PLANES_COMERCIALES/);
  assert.match(planesHtml, /comerciales\.length !== PLAN_IDS_COMERCIALES\.length/);
  assert.match(planesHtml, /Catálogo incompleto/);

  for (const planId of COMMERCIAL_PLAN_IDS) {
    assert.match(planesHtml, new RegExp(`id: "${planId}"`), planId);
  }

  assert.match(planesHtml, /id: "gratis"[\s\S]*anuncios: 2[\s\S]*fotos: 7[\s\S]*duracionAnunciosDias: 15/);
  assert.match(planesHtml, /id: "basico"[\s\S]*anuncios: 3[\s\S]*fotos: 10/);
  assert.match(planesHtml, /id: "destacado"[\s\S]*anuncios: 4[\s\S]*fotos: 15/);
  assert.match(planesHtml, /id: "starter"[\s\S]*anuncios: 15[\s\S]*fotos: 20/);
  assert.match(planesHtml, /id: "pro_agentes"[\s\S]*anuncios: 40[\s\S]*fotos: 30/);
  assert.match(planesHtml, /id: "agencia_basica"[\s\S]*anuncios: 50[\s\S]*fotos: 40/);
});

test("planes.html no renderiza planes internos como contratables y usa DOM seguro", () => {
  const planesHtml = fs.readFileSync(new URL("../public/planes.html", import.meta.url), "utf8");

  assert.match(planesHtml, /const PLAN_IDS_COMERCIALES = \["gratis", "basico", "destacado", "starter", "pro_agentes", "agencia_basica"\]/);
  assert.match(planesHtml, /PLAN_IDS_COMERCIALES\.includes\(plan\.id\)/);
  assert.match(planesHtml, /document\.createElement/);
  assert.match(planesHtml, /\.textContent =/);
  assert.match(planesHtml, /button\.dataset\.plan = plan\.id/);
  assert.doesNotMatch(planesHtml, /innerHTML\s*=/);
  assert.doesNotMatch(planesHtml, /pintar\("planes.*vip/);
  assert.doesNotMatch(planesHtml, /pintar\("planes.*agencia_pro/);
});

test("publicar.html separa fallo de catálogo de fallo de sesión y mantiene fallback seguro", () => {
  const publicarHtml = fs.readFileSync(new URL("../public/publicar.html", import.meta.url), "utf8");
  const guard = publicarHtml.match(/try \{[\s\S]*?const usuario = await refrescarUsuarioPublicar\(token\);[\s\S]*?await cargarCatalogoPlanesPublicar\(\);[\s\S]*?\} catch/);

  assert.ok(guard);
  assert.match(publicarHtml, /catch \(error\)[\s\S]*FALLBACK_PLANES_PUBLICAR/);
  assert.match(publicarHtml, /catalogoPlanesPublicar\.gratis \|\| FALLBACK_PLANES_PUBLICAR\.gratis/);
  assert.match(publicarHtml, /vip_trial: \{ fotos: null, ilimitadoFotos: true \}/);
  assert.match(publicarHtml, /vip: \{ fotos: null, ilimitadoFotos: true \}/);
  assert.match(publicarHtml, /const plan = usuario\?\.plan \|\| "gratis"/);
});

test("perfil.html fallback representa vip, vip_trial y plan desconocido correctamente", () => {
  const perfilHtml = fs.readFileSync(new URL("../public/perfil.html", import.meta.url), "utf8");

  assert.match(perfilHtml, /FALLBACK_PLANES_PERFIL/);
  assert.match(perfilHtml, /id: "vip_trial"[\s\S]*nombre: "Prueba VIP"[\s\S]*ilimitadoAnuncios: true[\s\S]*ilimitadoFotos: true/);
  assert.match(perfilHtml, /id: "vip"[\s\S]*nombre: "VIP"[\s\S]*ilimitadoAnuncios: true[\s\S]*ilimitadoFotos: true/);
  assert.match(perfilHtml, /id: "agencia_pro"[\s\S]*fotos: 50[\s\S]*ilimitadoAnuncios: true/);
  assert.match(perfilHtml, /PLANES_CATALOGO\[usuario\.plan\] \|\| PLANES_CATALOGO\.gratis/);
  assert.match(perfilHtml, /limitePlanTexto\(valor, ilimitado\)[\s\S]*return ilimitado \? "∞" : valor/);
});

test("admin mantiene lista explícita de planes asignables", () => {
  const adminRoutes = fs.readFileSync(new URL("../routes/admin.js", import.meta.url), "utf8");

  assert.match(adminRoutes, /const ADMIN_ASSIGNABLE_PLAN_IDS = \[/);
  assert.match(adminRoutes, /'gratis', 'basico', 'destacado', 'starter'/);
  assert.match(adminRoutes, /'pro_agentes', 'agencia_basica', 'agencia_pro'/);
  assert.match(adminRoutes, /'vip', 'vip_trial'/);
  assert.match(adminRoutes, /const PLANES_VALIDOS = ADMIN_ASSIGNABLE_PLAN_IDS/);
  assert.doesNotMatch(adminRoutes, /getKnownPlanIds/);
  assert.doesNotMatch(adminRoutes, /professional_trial/);
});
