import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const script = fs.readFileSync(new URL("../public/js/crm-sync-ui.js", import.meta.url), "utf8");
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const preview = (count = 1) => ({ runId: "own-run", status: "simulated", applyEligible: true,
  newImportEligible: true, snapshotComplete: true, expiresAt: new Date(Date.now() + 60000).toISOString(),
  missingCount: count, results: Array.from({ length: count }, (_, i) => ({ externalId: `M-${i + 1}`,
    type: "MISSING", blocked: true, hideMissingEligible: true, hideMissingBlockCode: null })) });
const receipt = () => ({ runId: "own-run", status: "completed", selectedExternalIds: ["M-1"],
  results: [{ externalId: "M-1", status: "hidden" }], countHidden: 1, countAlreadyHidden: 0 });
function element(tag) {
  const classes = new Set();
  return { tag, attributes: {}, children: [], listeners: {}, textContent: "", disabled: false, checked: false, value: "",
    classList: { add(v) { classes.add(v); }, remove(v) { classes.delete(v); }, contains(v) { return classes.has(v); } },
    append(v) { this.children.push(v); }, replaceChildren() { this.children = []; },
    setAttribute(k, v) { this.attributes[k] = v; }, addEventListener(k, v) { this.listeners[k] = v; } };
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
const text = node => descendants(node).map(item => item.textContent).join("\n");
const inputs = output => descendants(output).filter(item => item.type === "checkbox");
const select = input => { input.checked = true; input.listeners.change(); };
const findButton = (output, label) => descendants(output).find(item => item.textContent === label && item.tag === "button");
async function harness({ data = preview(), post = () => response(receipt()),
  get = () => response({ ...preview(), missingHide: receipt() }), confirmation = true, clock = Date } = {}) {
  const elements = new Map(), calls = [], confirmations = [], timers = [];
  const document = { createElement: element, getElementById(id) {
    if (!elements.has(id)) elements.set(id, element("div"));
    return elements.get(id);
  } };
  const context = vm.createContext({ window: {}, document, Date: clock,
    setTimeout(fn) { timers.push(fn); return timers.length - 1; },
    clearTimeout(id) { timers[id] = null; },
    confirm(message) { confirmations.push(message); return typeof confirmation === "function" ? confirmation(message) : confirmation; },
    fetch: async (url, options) => {
      const path = url.split("/").at(-1);
      calls.push({ path, method: options.method, headers: options.headers, body: options.body ? JSON.parse(options.body) : undefined });
      if (path === "source") return response({ configured: true, importSourceId: "own-source" });
      if (path === "simulate") return response(data);
      if (path === "hide-missing") return post();
      if (path === "own-run") return get();
      if (path === "apply") return response({ ok: true, appliedCount: 1 });
      if (path === "import-new") return response({ ok: true, runId: "own-run", newImport: {
        status: "completed", counts: { imported: 1 }, results: [{ externalId: "N-1", status: "imported" }] } });
      if (path === "enroll") return response({ alreadyEnrolled: false });
      assert.fail(`Unexpected request: ${path}`);
    } });
  vm.runInContext(script, context);
  context.window.HomeClickCrmSync.iniciar(() => "test-token");
  await new Promise(resolve => setImmediate(resolve));
  await elements.get("crmSyncSimulate").listeners.click();
  const output = elements.get("crmSyncResults"), status = elements.get("crmSyncStatus");
  return { output, status, button: findButton(output, "Ocultar anuncios"), calls, confirmations, data, timers };
}

test("eligible MISSING is selectable despite blocked=true, with accessible label and zero counter", async () => {
  const h = await harness();
  assert.match(text(h.output), /Este anuncio ya no aparece en el feed CRM. Listo para ocultar/);
  assert.equal(inputs(h.output).length, 1);
  assert.equal(inputs(h.output)[0].attributes["aria-label"], "Seleccionar anuncio para ocultar M-1");
  assert.match(text(h.output), /0 anuncios seleccionados \/ 10/);
  assert.equal(h.button.disabled, true);
  await h.button.listeners.click();
  assert.equal(h.confirmations.length, 0);
  assert.equal(h.calls.filter(c => c.path === "hide-missing").length, 0);
});

for (const [name, change] of [
  ["expired", { expiresAt: new Date(0).toISOString() }],
  ["incomplete", { snapshotComplete: false }],
  ["truncated", { planTruncated: true }],
  ["UPDATE consumed", { status: "applied" }],
  ["NEW consumed", { newImport: { status: "completed", counts: {}, results: [] } }],
  ["MISSING consumed", { missingHide: receipt() }],
  ["legacy", { results: [{ externalId: "M-1", type: "MISSING", blocked: true }] }]
]) test(`${name} run cannot select MISSING`, async () => {
  const h = await harness({ data: { ...preview(), ...change } });
  assert.equal(inputs(h.output).length, 0);
  assert.equal(h.button, undefined);
});

test("ineligible MISSING uses friendly block message without checkbox or raw code", async () => {
  const data = preview();
  Object.assign(data.results[0], { hideMissingEligible: false, hideMissingBlockCode: "MISSING_MANUAL_OVERRIDE" });
  const h = await harness({ data });
  assert.equal(inputs(h.output).length, 0);
  assert.match(text(h.output), /cambios manuales y requiere revisión/);
  assert.doesNotMatch(text(h.output), /MISSING_MANUAL_OVERRIDE/);
});

test("UPDATE, NEW and MISSING have independent selection state and request bodies", async () => {
  const data = preview();
  data.results.push({ externalId: "U-1", type: "UPDATE", blocked: false },
    { externalId: "N-1", type: "NEW", blocked: true, importNewEligible: true });
  const h = await harness({ data });
  select(inputs(h.output).find(i => i.attributes["aria-label"].startsWith("Seleccionar cambios")));
  select(inputs(h.output).find(i => i.attributes["aria-label"].startsWith("Seleccionar nuevo")));
  assert.equal(h.button.disabled, true);
  select(inputs(h.output).find(i => i.attributes["aria-label"].startsWith("Seleccionar anuncio para ocultar")));
  assert.match(text(h.output), /1 anuncios seleccionados \/ 10/);
  await h.button.listeners.click();
  const call = h.calls.find(c => c.path === "hide-missing");
  assert.deepEqual(call.body, { runId: "own-run", externalIds: ["M-1"] });
  assert.equal(call.headers.Authorization, "Bearer test-token");
  assert.equal(h.calls.filter(c => ["apply", "import-new"].includes(c.path)).length, 0);
});

test("ten selected is the maximum and confirmation is explicit", async () => {
  const data = preview(11);
  const h = await harness({ data, post: () => response({ ...receipt(),
    selectedExternalIds: data.results.slice(0, 10).map(r => r.externalId),
    results: data.results.slice(0, 10).map(r => ({ externalId: r.externalId, status: "hidden" })),
    countHidden: 10 }) });
  inputs(h.output).forEach(select);
  assert.equal(inputs(h.output)[10].checked, false);
  await h.button.listeners.click();
  assert.equal(h.calls.find(c => c.path === "hide-missing").body.externalIds.length, 10);
  assert.equal(h.confirmations[0], "Se ocultarán 10 anuncios que ya no aparecen en el feed CRM.\n\nNo se eliminarán sus datos, fotos, favoritos ni conversaciones.\n\nPodrás seguir viéndolos en Mis propiedades.\n\n¿Continuar?");
});
test("cancelled confirmation sends no POST and restores selection controls", async () => {
  const h = await harness({ confirmation: false });
  select(inputs(h.output)[0]); await h.button.listeners.click();
  assert.equal(h.calls.filter(c => c.path === "hide-missing").length, 0);
  assert.equal(h.button.disabled, false);
  assert.equal(inputs(h.output)[0].disabled, false);
});
for (const state of ["hidden", "already_hidden"]) test(`completed receipt renders ${state} and blocks another POST`, async () => {
  const result = { ...receipt(), results: [{ externalId: "M-1", status: state }],
    countHidden: state === "hidden" ? 1 : 0, countAlreadyHidden: state === "hidden" ? 0 : 1 };
  const h = await harness({ post: () => response(result) });
  const input = inputs(h.output)[0]; select(input); await h.button.listeners.click();
  assert.equal(h.status.textContent, "Ocultado completado.");
  assert.match(text(h.output), state === "hidden" ? /M-1: Ocultado/ : /M-1: Ya estaba oculto/);
  assert.ok(descendants(h.output).some(item => item.href === "/perfil.html#listaPropiedades"));
  assert.equal(h.button.disabled, true); assert.equal(input.checked, false);
  await h.button.listeners.click();
  assert.equal(h.calls.filter(c => c.path === "hide-missing").length, 1);
});
test("POST success is immediate and survives failed refresh", async () => {
  let release, entered;
  const wait = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
  const h = await harness({ get: async () => { entered(); await wait; throw new Error("private details"); } });
  select(inputs(h.output)[0]); const pending = h.button.listeners.click(); await started;
  assert.equal(h.status.textContent, "Ocultado completado.");
  assert.match(text(h.output), /1 anuncio ocultado/);
  await h.button.listeners.click(); release(); await pending;
  assert.match(text(h.output), /ocultaron correctamente, pero/);
  assert.doesNotMatch(text(h.output), /private details/);
  assert.equal(h.status.classList.contains("error"), false);
});
test("double click while POST is pending sends exactly one request", async () => {
  let release, entered;
  const wait = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
  const h = await harness({ post: async () => { entered(); await wait; return response(receipt()); } });
  const input = inputs(h.output)[0]; select(input);
  const pending = h.button.listeners.click(); await started;
  assert.equal(input.disabled, true); assert.equal(h.button.disabled, true);
  await h.button.listeners.click(); release(); await pending;
  assert.equal(h.calls.filter(c => c.path === "hide-missing").length, 1);
});
for (const [name, post] of [
  ...[502, 503, 504].map(code => [String(code), () => response({ error: "private" }, code)]),
  ["network", () => { throw new Error("private"); }],
  ["timeout", () => { throw Object.assign(new Error("private"), { name: "AbortError" }); }],
  ["unconfirmed", () => response({ code: "MISSING_UNCONFIRMED" }, 409)],
  ["in progress", () => response({ code: "MISSING_IN_PROGRESS" }, 409)],
  ["preparing", () => response({ status: "preparing" })],
  ["applying", () => response({ status: "applying" })],
  ["indeterminate", () => response({ status: "indeterminate" })],
  ["malformed", () => response(null)],
  ["foreign receipt", () => response({ ...receipt(), selectedExternalIds: ["OTHER"] })]
]) test(`${name} POST is unconfirmed, never retries, consult uses only GET`, async () => {
  const h = await harness({ post });
  select(inputs(h.output)[0]); await h.button.listeners.click();
  assert.match(h.status.textContent, /No se ha podido confirmar/);
  assert.doesNotMatch(h.status.textContent, /private|Ocultado completado/);
  await h.button.listeners.click();
  assert.equal(h.calls.filter(c => c.path === "hide-missing").length, 1);
  const before = h.calls.length;
  await findButton(h.output, "Consultar estado").listeners.click();
  assert.deepEqual(h.calls.slice(before).map(c => [c.method, c.path]), [["GET", "own-run"]]);
  assert.equal(h.status.textContent, "Ocultado completado.");
  assert.equal(findButton(h.output, "Ocultar anuncios"), undefined);
});
for (const state of ["preparing", "applying", "indeterminate", "failed"]) test(`GET ${state} stays blocked and does not repeat POST`, async () => {
  const h = await harness({ post: () => { throw new Error("lost response"); },
    get: () => response({ ...preview(), missingHide: { status: state, errorCode: "MISSING_MANUAL_OVERRIDE" } }) });
  select(inputs(h.output)[0]); await h.button.listeners.click();
  await findButton(h.output, "Consultar estado").listeners.click();
  assert.equal(findButton(h.output, "Ocultar anuncios"), undefined);
  assert.match(text(h.output), state === "failed" ? /cambios manuales/ : /No se ha podido confirmar/);
  assert.equal(h.calls.filter(c => c.path === "hide-missing").length, 1);
});
test("failed GET preserves uncertainty with a safe message and never sends POST", async () => {
  const h = await harness({ post: () => { throw new Error("lost"); }, get: () => response({ error: "private" }, 500) });
  select(inputs(h.output)[0]); await h.button.listeners.click();
  await findButton(h.output, "Consultar estado").listeners.click();
  assert.match(h.status.textContent, /No se pudo consultar el estado del ocultado/);
  assert.ok(findButton(h.output, "Consultar estado"));
  assert.doesNotMatch(h.status.textContent, /private/);
  assert.equal(h.calls.filter(c => c.path === "hide-missing").length, 1);
});
test("explicit POST rejection is safe and never presented as successful or retried", async () => {
  const h = await harness({ post: () => response({ code: "MISSING_PROPERTY_CHANGED", error: "private" }, 409) });
  select(inputs(h.output)[0]); await h.button.listeners.click(); await h.button.listeners.click();
  assert.match(h.status.textContent, /ha cambiado desde la simulación/);
  assert.doesNotMatch(h.status.textContent, /private|completado/);
  assert.equal(h.calls.filter(c => c.path === "hide-missing").length, 1);
});
test("run expiry clears and disables selection while page stays open", async () => {
  const h = await harness(), input = inputs(h.output)[0]; select(input);
  h.data.expiresAt = new Date(0).toISOString();
  h.timers.filter(Boolean).at(-1)();
  assert.equal(input.checked, false); assert.equal(input.disabled, true); assert.equal(h.button.disabled, true);
  assert.match(text(h.output), /La simulación ha caducado. Vuelve a simular/);
  await h.button.listeners.click();
  assert.equal(h.calls.filter(c => c.path === "hide-missing").length, 0);
});
test("expiry is also checked immediately before action without waiting for timer", async () => {
  const h = await harness(); select(inputs(h.output)[0]);
  h.data.expiresAt = new Date(0).toISOString(); await h.button.listeners.click();
  assert.equal(inputs(h.output)[0].checked, false);
  assert.equal(h.calls.filter(c => c.path === "hide-missing").length, 0);
});
test("run still valid after accepting confirmation sends one POST", async () => {
  const data = preview();
  let now = Date.now();
  class Clock extends Date { static now() { return now; } }
  const h = await harness({ data, clock: Clock, confirmation: () => {
    assert.ok(Clock.now() < Date.parse(data.expiresAt));
    now += 1000;
    assert.ok(Clock.now() < Date.parse(data.expiresAt));
    return true;
  } });
  select(inputs(h.output)[0]); await h.button.listeners.click();
  assert.equal(h.confirmations.length, 1);
  assert.equal(h.calls.filter(c => c.path === "hide-missing").length, 1);
  assert.equal(h.status.textContent, "Ocultado completado.");
});
test("run expires during accepted confirmation: zero POST, cleared and blocked selection, resimulation message", async () => {
  const data = preview();
  let now = Date.now();
  class Clock extends Date { static now() { return now; } }
  const h = await harness({ data, clock: Clock, confirmation: () => {
    assert.ok(Clock.now() < Date.parse(data.expiresAt));
    now = Date.parse(data.expiresAt);
    return true;
  } });
  const input = inputs(h.output)[0]; select(input);
  await h.button.listeners.click();
  assert.equal(h.confirmations.length, 1);
  assert.equal(h.calls.filter(c => c.path === "hide-missing").length, 0);
  assert.equal(h.calls.filter(c => c.path === "own-run").length, 0);
  assert.equal(input.checked, false); assert.equal(input.disabled, true);
  assert.equal(h.button.disabled, true);
  assert.equal(h.status.textContent, "La simulación ha caducado. Vuelve a simular.");
  assert.match(text(h.output), /La simulación ha caducado. Vuelve a simular/);
  await h.button.listeners.click();
  assert.equal(h.calls.filter(c => c.path === "hide-missing").length, 0);
});
test("responsive MISSING labels wrap and profile loads the new script version", () => {
  const html = fs.readFileSync(new URL("../public/perfil.html", import.meta.url), "utf8");
  assert.match(html, /crm-sync-ui\.js\?v=10/);
  assert.match(html, /\.crm-sync-missing-label span\s*\{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere/);
  assert.match(html, /\.crm-sync-results \.btn-perfil\s*\{[^}]*max-width: 100%;[^}]*white-space: normal/);
});
