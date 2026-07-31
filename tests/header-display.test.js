import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const headerJs = fs.readFileSync(new URL("../public/js/header.js", import.meta.url), "utf8");
const perfilJs = fs.readFileSync(new URL("../public/js/perfil.js", import.meta.url), "utf8");

test("cabecera autenticada no usa Usuario como nombre provisional", () => {
  assert.doesNotMatch(headerJs, /usuario\.nombre\s*\|\|\s*["']Usuario["']/);
  assert.match(headerJs, /userToggle\.textContent\s*=\s*nombreUsuarioInicial/);
  assert.match(headerJs, /nombreUsuarioInicial[\s\S]*:\s*"\.\.\."/);
});

test("perfil no usa Usuario como fallback visual del nombre", () => {
  assert.doesNotMatch(perfilJs, /usuario\.nombre\s*\|\|\s*["']Usuario["']/);
  assert.match(perfilJs, /document\.getElementById\("nombreUsuario"\)\.textContent\s*=\s*nombre/);
});
