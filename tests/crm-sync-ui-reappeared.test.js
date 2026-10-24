import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const script = fs.readFileSync(new URL("../public/js/crm-sync-ui.js", import.meta.url), "utf8");
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const preview = (count = 1) => ({ runId: "own-run", status: "simulated", applyEligible: true,
  newImportEligible: true, snapshotComplete: true, expiresAt: new Date(Date.now() + 60000).toISOString(),
  reappearedCount: count, results: Array.from({ length: count }, (_, i) => ({ externalId: `R-${i + 1}`,
    type: "REAPPEARED", blocked: true, restoreEligible: true, restoreBlockCode: null })) });
const receipt = (refs = ["R-1"]) => ({ runId: "own-run", status: "completed", selectedExternalIds: refs,
  results: refs.map(externalId => ({ externalId, status: "restored" })), countRestored: refs.length, countAlreadyRestored: 0 });
function element(tag) {
  const classes = new Set();
  return { tag, attributes: {}, children: [], listeners: {}, textContent: "", disabled: false, checked: false, value: "",
    classList: { add(v) { classes.add(v); }, remove(v) { classes.delete(v); }, contains(v) { return classes.has(v); } },
    append(v) { this.children.push(v); }, replaceChildren() { this.children = []; },
    setAttribute(k, v) { this.attributes[k] = v; }, addEventListener(k, v) { this.listeners[k] = v; },
    showModal() { this.open = true; }, close() { this.open = false; }, remove() { this.removed = true; }, focus() {} };
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
const text = node => descendants(node).map(item => item.textContent).join("\n");
const inputs = node => descendants(node).filter(item => item.type === "checkbox");
const select = input => { input.checked = true; input.listeners.change(); };
const button = (node, label) => descendants(node).find(item => item.tag === "button" && item.textContent === label);
const tick = () => new Promise(resolve => setImmediate(resolve));
async function harness({ data = preview(), post = () => response(receipt()),
  get = () => response({ ...preview(), reappearedRestore: receipt() }), clock = Date } = {}) {
  const elements = new Map(), calls = [], timers = [], body = element("body");
  const document = { body, activeElement: body, createElement(tag) {
    const node = element(tag);
    node.focus = () => { if (!node.disabled && !node.removed) document.activeElement = node; };
    return node;
  }, getElementById(id) {
    if (!elements.has(id)) elements.set(id, element("div")); return elements.get(id);
  } };
  const context = vm.createContext({ window: {}, document, Date: clock,
    setTimeout(fn) { timers.push(fn); return timers.length - 1; }, clearTimeout(id) { timers[id] = null; },
    confirm: () => false,
    fetch: async (url, options) => {
      const path = url.split("/").at(-1);
      calls.push({ path, method: options.method, body: options.body ? JSON.parse(options.body) : undefined });
      if (path === "source") return response({ configured: true, importSourceId: "own-source" });
      if (path === "simulate") return response(data);
      if (path === "restore-reappeared") return post();
      if (path === "own-run") return get();
      assert.fail(`Unexpected request: ${path}`);
    } });
  vm.runInContext(script, context);
  context.window.HomeClickCrmSync.iniciar(() => "test-token"); await tick();
  await elements.get("crmSyncSimulate").listeners.click();
  const output = elements.get("crmSyncResults"), status = elements.get("crmSyncStatus");
  const dialog = () => body.children.findLast(item => item.tag === "dialog" && !item.removed);
  return { data, output, status, calls, timers, elements, dialog, document,
    button: button(output, "Volver a publicar"),
    async start() { const pending = this.button.listeners.click(); await tick(); return { pending }; },
    async submit(accept = true) {
      const { pending } = await this.start();
      const modal = dialog(); if (modal) button(modal, accept ? "Volver a publicar" : "Cancelar").listeners.click();
      await pending;
    } };
}
const postCount = h => h.calls.filter(c => c.path === "restore-reappeared").length;

test("eligible REAPPEARED has accessible checkbox, clear presentation and independent zero counter", async () => {
  const h = await harness();
  assert.match(text(h.output), /Este anuncio ha vuelto a aparecer en tu CRM. Listo para volver a publicar/);
  assert.equal(inputs(h.output).length, 1);
  assert.equal(inputs(h.output)[0].attributes["aria-label"], "Seleccionar anuncio para volver a publicar R-1");
  assert.match(text(h.output), /0 anuncios seleccionados \/ 10/);
  assert.equal(h.button.disabled, true); await h.submit(); assert.equal(postCount(h), 0);
  select(inputs(h.output)[0]); assert.equal(h.button.disabled, false);
});
for (const [code, phrase] of [
  ["REAPPEARED_CONTENT_CHANGED", "ha vuelto con cambios"], ["REAPPEARED_PLAN_LIMIT", "No tienes espacio disponible"],
  ["REAPPEARED_PLAN_INACTIVE", "Tu plan no permite"], ["REAPPEARED_LISTING_EXPIRED", "está caducado"],
  ["REAPPEARED_NO_LONGER_PRESENT", "ya no aparece"], ["REAPPEARED_REVISION_CHANGED", "ha cambiado desde"],
  ["REAPPEARED_RECONCILIATION_PENDING", "comprobación pendiente"], ["REAPPEARED_RUN_EXPIRED", "ha caducado"],
  ["constructor", "Revisa el estado"]
]) test(`blocked ${code} has safe message and no checkbox`, async () => {
  const data = preview(); Object.assign(data.results[0], { restoreEligible: false, restoreBlockCode: code });
  const h = await harness({ data }); assert.equal(inputs(h.output).length, 0);
  assert.match(text(h.output), new RegExp(phrase)); assert.doesNotMatch(text(h.output), new RegExp(code));
});
for (const change of [{ expiresAt: new Date(0).toISOString() }, { snapshotComplete: false }, { planTruncated: true },
  { resultsTruncated: true }, { status: "applied" }, { missingHide: { status: "completed" } },
  { newImport: { status: "completed" } }, { reappearedRestore: receipt() }])
  test(`consumed/ineligible run ${JSON.stringify(change)} cannot select restore`, async () => {
    const h = await harness({ data: { ...preview(), ...change } });
    assert.equal(inputs(h.output).length, 0); assert.equal(h.button, undefined);
  });
test("maximum ten, explicit modal buttons and exact POST without internal fields", async () => {
  const h = await harness({ data: preview(11), post: () => response(receipt(Array.from({ length: 10 }, (_, i) => `R-${i + 1}`))) });
  inputs(h.output).forEach(select); assert.equal(inputs(h.output)[10].checked, false);
  const { pending } = await h.start();
  assert.match(text(h.dialog()), /Se volverán a publicar 10 anuncios. Volverán a aparecer en los listados públicos y contarán para el límite de tu plan/);
  assert.ok(button(h.dialog(), "Cancelar")); button(h.dialog(), "Volver a publicar").listeners.click(); await pending;
  const call = h.calls.find(c => c.path === "restore-reappeared");
  assert.deepEqual(call.body, { runId: "own-run", externalIds: Array.from({ length: 10 }, (_, i) => `R-${i + 1}`) });
  assert.equal(postCount(h), 1);
});
test("cancel and Escape send no POST and preserve selection", async () => {
  for (const escape of [false, true]) {
    const h = await harness(); select(inputs(h.output)[0]); const { pending } = await h.start();
    if (escape) h.dialog().listeners.cancel({ preventDefault() {} }); else button(h.dialog(), "Cancelar").listeners.click();
    await pending; assert.equal(postCount(h), 0); assert.equal(h.button.disabled, false); assert.equal(inputs(h.output)[0].checked, true);
  }
});
for (const escape of [false, true]) test(`${escape ? "Escape" : "Cancel"} returns focus only after controls are enabled`, async () => {
  const h = await harness(); select(inputs(h.output)[0]); h.button.focus();
  const { pending } = await h.start();
  assert.equal(h.button.disabled, true);
  assert.equal(h.document.activeElement, button(h.dialog(), "Cancelar"));
  if (escape) h.dialog().listeners.cancel({ preventDefault() {} });
  else button(h.dialog(), "Cancelar").listeners.click();
  await pending;
  assert.equal(h.button.disabled, false);
  assert.equal(inputs(h.output)[0].disabled, false);
  assert.equal(h.elements.get("crmSyncSave").disabled, false);
  assert.equal(h.elements.get("crmSyncSimulate").disabled, false);
  assert.equal(h.document.activeElement, h.button);
  assert.equal(postCount(h), 0);
});
test("expiry before confirmation sends no POST and clears selection", async () => {
  const h = await harness(); const input = inputs(h.output)[0]; select(input);
  h.data.expiresAt = new Date(0).toISOString(); await h.submit();
  assert.equal(postCount(h), 0); assert.equal(input.checked, false); assert.equal(input.disabled, true);
  assert.match(text(h.output), /La simulación ha caducado. Vuelve a simular/);
});
test("expiry while modal is open: postCount=0, blocked/cleared selection and resimulation message", async () => {
  let now = Date.now(); class Clock extends Date { static now() { return now; } }
  const h = await harness({ clock: Clock }); const input = inputs(h.output)[0]; select(input);
  const { pending } = await h.start(); now = Date.parse(h.data.expiresAt);
  button(h.dialog(), "Volver a publicar").listeners.click(); await pending;
  assert.equal(postCount(h), 0); assert.equal(input.checked, false); assert.equal(input.disabled, true);
  assert.equal(h.button.disabled, true); assert.equal(h.status.textContent, "La simulación ha caducado. Vuelve a simular.");
});
test("completed clears only restore selection, preserves all other selections and never repeats", async () => {
  const data = preview(); data.results.push({ externalId: "U", type: "UPDATE", blocked: false },
    { externalId: "N", type: "NEW", importNewEligible: true }, { externalId: "M", type: "MISSING", hideMissingEligible: true });
  const h = await harness({ data }); const all = inputs(h.output); all.forEach(select);
  assert.match(text(h.output), /Seleccionados: 1 \/ 10/); assert.match(text(h.output), /1 nuevos seleccionados \/ 10/);
  await h.submit(); assert.equal(h.status.textContent, "Publicación completada.");
  assert.match(text(h.output), /1 anuncio publicado · 0 ya estaban publicados/);
  assert.match(text(h.output), /R-1: Publicado/); assert.equal(all[0].checked, false);
  assert.ok(all.slice(1).every(input => input.checked && input.disabled));
  await h.button.listeners.click(); assert.equal(postCount(h), 1);
});
test("double click during confirmation and POST sends once, stable selection", async () => {
  let release; const waiting = new Promise(resolve => { release = resolve; });
  const h = await harness({ post: async () => { await waiting; return response(receipt()); } });
  const input = inputs(h.output)[0]; select(input); const { pending } = await h.start();
  await h.button.listeners.click(); assert.equal(h.elements.get("crmSyncSimulate").disabled, true);
  button(h.dialog(), "Volver a publicar").listeners.click(); await tick();
  await h.button.listeners.click(); assert.equal(input.checked, true); assert.equal(input.disabled, true);
  release(); await pending; assert.equal(postCount(h), 1);
});
test("success is immediate and survives failed GET refresh", async () => {
  let release; const waiting = new Promise(resolve => { release = resolve; });
  const h = await harness({ get: async () => { await waiting; throw new Error("private error"); } });
  select(inputs(h.output)[0]); const { pending } = await h.start();
  button(h.dialog(), "Volver a publicar").listeners.click(); await tick();
  assert.equal(h.status.textContent, "Publicación completada."); assert.match(text(h.output), /R-1: Publicado/);
  assert.equal(inputs(h.output)[0].checked, false);
  assert.equal(h.button.disabled, true);
  release(); await pending; assert.match(text(h.output), /publicaron correctamente, pero/);
  assert.equal(h.status.classList.contains("error"), false); assert.doesNotMatch(text(h.output), /private error/);
});
for (const [name, post] of [
  ...[502, 503, 504].map(code => [String(code), () => response({ error: "secret" }, code)]),
  ["network", () => { throw new Error("secret"); }], ["malformed", () => response(null)],
  ["preparing", () => response({ status: "preparing" })], ["applying", () => response({ status: "applying" })],
  ["indeterminate", () => response({ status: "indeterminate" })],
  ["in progress", () => response({ code: "REAPPEARED_IN_PROGRESS" }, 409)],
  ["foreign receipt", () => response(receipt(["OTHER"]))]
]) test(`${name} blocks retry and GET-only recovers confirmed receipt`, async () => {
  const h = await harness({ post }); select(inputs(h.output)[0]); await h.submit();
  assert.match(h.status.textContent, /No se ha podido confirmar todavía el resultado/);
  assert.doesNotMatch(text(h.output), /secret|Publicación completada/); await h.button.listeners.click();
  const before = h.calls.length; await button(h.output, "Consultar estado").listeners.click();
  assert.deepEqual(h.calls.slice(before).map(c => [c.method, c.path]), [["GET", "own-run"]]);
  assert.match(text(h.output), /Publicación completada/); assert.equal(postCount(h), 1);
});
for (const state of ["preparing", "applying", "indeterminate", "failed"])
  test(`GET ${state} never unlocks POST`, async () => {
    const h = await harness({ post: () => { throw new Error("lost"); },
      get: () => response({ ...preview(), reappearedRestore: { status: state, errorCode: "REAPPEARED_CONTENT_CHANGED" } }) });
    select(inputs(h.output)[0]); await h.submit(); await button(h.output, "Consultar estado").listeners.click();
    assert.equal(h.button.disabled, true); assert.equal(postCount(h), 1);
    assert.match(text(h.output), state === "failed" ? /ha vuelto con cambios/ : /No se ha podido confirmar/);
  });
test("failed GET retains consult action and never repeats POST", async () => {
  const h = await harness({ post: () => { throw new Error("lost"); }, get: () => response({ error: "secret" }, 500) });
  select(inputs(h.output)[0]); await h.submit(); await button(h.output, "Consultar estado").listeners.click();
  assert.match(h.status.textContent, /No se pudo consultar el estado/); assert.ok(button(h.output, "Consultar estado"));
  assert.equal(postCount(h), 1); assert.doesNotMatch(text(h.output), /secret/);
});
test("explicit safe rejection is not success and never repeats", async () => {
  const h = await harness({ post: () => response({ code: "REAPPEARED_PLAN_LIMIT", error: "raw Mongo error" }, 409) });
  select(inputs(h.output)[0]); await h.submit(); await h.button.listeners.click();
  assert.match(h.status.textContent, /No tienes espacio disponible/); assert.doesNotMatch(text(h.output), /raw Mongo|Publicación completada/);
  assert.equal(postCount(h), 1);
});
test("existing completed receipt renders result even after expiry, no new submit", async () => {
  const h = await harness({ data: { ...preview(), expiresAt: new Date(0).toISOString(), reappearedRestore: receipt() } });
  assert.match(text(h.output), /Publicación completada/); assert.equal(h.button, undefined); assert.equal(postCount(h), 0);
});
test("private evidence and unknown codes never appear in rendered REAPPEARED", async () => {
  const data = preview(); Object.assign(data.results[0], { restoreEligible: false, restoreBlockCode: "private-code",
    restoreEvidence: { propertyId: "private-id", hash: "private-hash" }, changedFields: ["private-revision"] });
  const h = await harness({ data }); assert.doesNotMatch(text(h.output), /private-/);
});
test("profile loads fresh JS and responsive accessible controls", () => {
  const html = fs.readFileSync(new URL("../public/perfil.html", import.meta.url), "utf8");
  assert.match(html, /crm-sync-ui\.js\?v=12/);
  assert.match(html, /\.crm-sync-restore-label span\s*\{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere/);
  assert.match(html, /max-width: calc\(100% - 32px\)/); assert.match(html, /crm-sync-restore-confirm-actions[^}]*flex-wrap: wrap/);
});
