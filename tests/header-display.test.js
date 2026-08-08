import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const headerJs = fs.readFileSync(new URL("../public/js/header.js", import.meta.url), "utf8");
const perfilJs = fs.readFileSync(new URL("../public/js/perfil.js", import.meta.url), "utf8");

test("cabecera autenticada no usa Usuario como nombre provisional", () => {
  assert.doesNotMatch(headerJs, /usuario\.nombre\s*\|\|\s*["']Usuario["']/);
  assert.match(headerJs, /userToggle\.textContent\s*=\s*nombreUsuarioInicial/);
  assert.match(headerJs, /fetch\("\/usuarios\/me"/);
  assert.match(headerJs, /localStorage\.setItem\("usuario", JSON\.stringify\(usuarioFusionado\)\)/);
  assert.match(headerJs, /nombreUsuarioInicial[\s\S]*:\s*"\.\.\."/);
});

test("perfil no usa Usuario como fallback visual del nombre", () => {
  assert.doesNotMatch(perfilJs, /usuario\.nombre\s*\|\|\s*["']Usuario["']/);
  assert.match(perfilJs, /document\.getElementById\("nombreUsuario"\)\.textContent\s*=\s*nombre/);
});

function crearEntornoHeader({ usuario, token = "token-test", respuesta, fetchError = null }) {
  const elementos = new Map();
  const almacenamiento = new Map();
  if (usuario !== undefined) almacenamiento.set("usuario", JSON.stringify(usuario));
  if (token) almacenamiento.set("token", token);

  function crearElemento(id) {
    let html = "";
    const elemento = {
      id,
      style: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {},
      closest() { return null; },
      appendChild() {},
      set innerHTML(value) {
        html = value;
        if (id === "main-header") {
          ["userToggle", "userMenu", "logoutBtn", "chatBadge", "notifBadge"].forEach(childId => {
            if (!elementos.has(childId)) elementos.set(childId, crearElemento(childId));
          });
        }
      },
      get innerHTML() {
        return html;
      },
      textContent: ""
    };
    return elemento;
  }

  elementos.set("main-header", crearElemento("main-header"));

  const document = {
    head: { appendChild() {} },
    createElement() {
      return crearElemento("");
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    getElementById(id) {
      return elementos.get(id) || null;
    },
    addEventListener(evento, callback) {
      if (evento === "DOMContentLoaded") callback();
    }
  };

  const contexto = {
    document,
    window: {
      location: { pathname: "/", search: "" },
      addEventListener() {}
    },
    location: { href: "" },
    localStorage: {
      getItem(key) {
        return almacenamiento.has(key) ? almacenamiento.get(key) : null;
      },
      setItem(key, value) {
        almacenamiento.set(key, String(value));
      },
      removeItem(key) {
        almacenamiento.delete(key);
      }
    },
    fetch: async () => {
      if (fetchError) throw fetchError;
      return respuesta;
    },
    setInterval() {},
    console: { warn() {} },
    alert() {}
  };

  vm.runInNewContext(headerJs, contexto);
  return { elementos, almacenamiento };
}

test("cabecera muestra el nombre local inmediatamente", async () => {
  const respuestaPendiente = new Promise(() => {});
  const { elementos } = crearEntornoHeader({
    usuario: { _id: "1", nombre: "Sonia", planActivo: true },
    respuesta: respuestaPendiente
  });

  assert.equal(elementos.get("userToggle").textContent, "Sonia");
});

test("cabecera completa el nombre desde backend sin entrar en perfil", async () => {
  const { elementos, almacenamiento } = crearEntornoHeader({
    usuario: { _id: "1", planActivo: true },
    respuesta: {
      ok: true,
      status: 200,
      json: async () => ({ _id: "1", nombre: "Sonia", planActivo: true })
    }
  });

  assert.equal(elementos.get("userToggle").textContent, "...");
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(elementos.get("userToggle").textContent, "Sonia");
  assert.equal(JSON.parse(almacenamiento.get("usuario")).nombre, "Sonia");
});

test("cabecera controla sesión caducada y respuestas inesperadas", async () => {
  const caducada = crearEntornoHeader({
    usuario: { _id: "1", planActivo: true },
    respuesta: { ok: false, status: 401, json: async () => ({}) }
  });

  await new Promise(resolve => setImmediate(resolve));

  assert.equal(caducada.almacenamiento.has("usuario"), false);
  assert.equal(caducada.almacenamiento.has("token"), false);

  const inesperada = crearEntornoHeader({
    usuario: { _id: "1", planActivo: true },
    respuesta: { ok: true, status: 200, json: async () => null }
  });

  await new Promise(resolve => setImmediate(resolve));

  assert.equal(inesperada.elementos.get("userToggle").textContent, "...");
});
