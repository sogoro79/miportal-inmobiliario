import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../public/crm.html", import.meta.url), "utf8");
const script = fs.readFileSync(new URL("../public/js/crm-help.js", import.meta.url), "utf8");

test("CRM help includes metadata, one H1, guide, states and eight FAQs", () => {
  assert.match(html, /<title>CRM inmobiliario y sincronización XML \| HomeClick24<\/title>/);
  assert.match(html, /name="description" content="Conecta tu CRM con HomeClick24 e importa y sincroniza tus propiedades mediante feed XML compatible\."/);
  assert.match(html, /rel="canonical" href="https:\/\/www.homeclick24.com\/crm.html"/);
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.match(html, /Conecta tu CRM con HomeClick24<\/h1>/);
  for (const state of ["NEW", "UPDATE", "UNCHANGED", "MISSING", "REAPPEARED", "CONFLICT"]) {
    assert.ok(html.includes(`<dt>${state}</dt>`));
  }
  assert.equal((html.match(/<summary>/g) || []).length, 8);
  assert.match(html, /Simular no modifica tus anuncios/);
  assert.match(html, /href="\/contacto"/);
  assert.match(html, /href="#compatibilidad"/);
  assert.doesNotMatch(html, /Witei|Inmovilla|fetch\(|onclick=/i);
});

function linksFor(storage) {
  const links = [{ href: "/login?returnUrl=%2Fperfil%23crmImportCard" }, { href: "/login?returnUrl=%2Fperfil%23crmImportCard" }];
  vm.runInNewContext(script, {
    localStorage: { getItem(key) { if (storage instanceof Error) throw storage; return storage[key] ?? null; } },
    document: { querySelectorAll(selector) { assert.equal(selector, "[data-connect-crm]"); return links; } }
  });
  return links;
}

test("authenticated CRM CTAs use existing profile anchor", () => {
  assert.ok(linksFor({ usuario: '{"_id":"test-user"}', token: "test-token" }).every(link => link.href === "/perfil#crmImportCard"));
  const profile = fs.readFileSync(new URL("../public/perfil.html", import.meta.url), "utf8");
  assert.match(profile, /id="crmImportCard"/);
});

test("anonymous, incomplete and unavailable storage keep login return URL", () => {
  for (const storage of [{}, { token: "test-token" }, { usuario: "invalid" }, new Error("storage unavailable")]) {
    assert.ok(linksFor(storage).every(link => link.href === "/login?returnUrl=%2Fperfil%23crmImportCard"));
  }
});

test("page resources and internal link targets exist", () => {
  for (const [, href] of html.matchAll(/(?:href|src)="(\/[^"?]*)(?:\?[^\"]*)?"/g)) {
    const target = href.split("#")[0];
    const file = target === "/" ? "index.html" : target.slice(1);
    assert.ok(fs.existsSync(new URL(`../public/${file}`, import.meta.url)) || fs.existsSync(new URL(`../public/${file}.html`, import.meta.url)), href);
  }
});
