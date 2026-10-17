import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const banner = html.match(/<section class="crm-home-banner"[\s\S]*?<\/section>/)?.[0];

test("CRM banner is after launch promotion and before property listings", () => {
  assert.ok(banner);
  assert.equal((html.match(/class="crm-home-banner"/g) || []).length, 1);
  assert.ok(html.indexOf(banner) > html.indexOf('class="professional-promo-home"'));
  assert.ok(html.indexOf(banner) < html.indexOf('id="homeDestacadasSection"'));
  assert.match(html, /id="busqueda"/);
  assert.match(html, /id="main-header"/);
  assert.match(html, /data-launch-plan-cta>Activar gratis<\/a>/);
});

test("CRM banner copy and real CTA point only to the help page", () => {
  for (const copy of ["Conecta tu CRM con HomeClick24", "Importa y sincroniza tus inmuebles de forma fácil, rápida y profesional.", "Nuevos anuncios", "Actualizaciones", "Sincronización CRM", "Ahorra tiempo", "Feeds XML compatibles", "Importación y cambios con tu confirmación."]) {
    assert.ok(banner.includes(copy), copy);
  }
  assert.match(banner, /<a class="crm-home-cta" href="\/crm.html">Descubre cómo funciona<\/a>/);
  assert.equal((banner.match(/<a\b/g) || []).length, 1);
  assert.match(banner, /aria-labelledby="crmHomeTitle"/);
  assert.match(banner, /id="crmHomeTitle"/);
  assert.match(banner, /class="crm-home-visual" aria-hidden="true"/);
  assert.doesNotMatch(banner, /onclick|<script|Witei|Inmovilla|todos los CRM/i);
});

test("CRM banner has responsive constraints and visible keyboard focus", () => {
  assert.match(html, /\.crm-home-cta:focus-visible\s*\{[^}]*outline: 3px/);
  assert.match(html, /@media \(max-width: 800px\)\s*\{\s*\.crm-home-inner \{ grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(html, /@media \(max-width: 480px\)[\s\S]*?\.crm-home-cta \{ width: 100%/);
  assert.match(html, /<title>HomeClick24 - Inicio<\/title>/);
  assert.match(html, /rel="canonical" href="https:\/\/www.homeclick24.com\/"/);
});

test("homepage inline scripts remain syntactically valid", () => {
  for (const [, attrs, source] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (/application\/ld\+json/.test(attrs)) JSON.parse(source);
    else if (!/\bsrc=/.test(attrs)) new vm.Script(source);
  }
});
