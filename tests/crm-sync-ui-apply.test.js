import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const script = fs.readFileSync(new URL("../public/js/crm-sync-ui.js", import.meta.url), "utf8");
const preview = () => ({ runId: "own-run", status: "simulated", applyEligible: true, expired: false,
  snapshotComplete: true, expiresAt: new Date(Date.now() + 60000).toISOString(), updateCount: 1,
  results: [{ externalId: "CRM-1", type: "UPDATE", blocked: false, changedFields: ["precio"] }] });
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const success = () => response({ ok: true, runId: "own-run", appliedCount: 1 });
const refreshed = () => response({ ...preview(), status: "applied", applyEligible: false, appliedCount: 1,
  applyBlockedReason: "RUN_STATUS_NOT_APPLICABLE" });

function element() {
  const classes = new Set();
  return { children: [], listeners: {}, textContent: "", disabled: false, checked: false, value: "",
    classList: { add(value) { classes.add(value); }, remove(value) { classes.delete(value); }, contains(value) { return classes.has(value); } },
    append(value) { this.children.push(value); }, replaceChildren() { this.children = []; }, setAttribute() {},
    addEventListener(event, listener) { this.listeners[event] = listener; } };
}
function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }
function text(node) { return descendants(node).map(item => item.textContent).join("\n"); }
async function harness({ post = success, get = refreshed, data = preview(), confirmation = true } = {}) {
  const elements = new Map(), calls = [], confirmations = [];
  const document = { createElement: element, getElementById(id) {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  } };
  const context = vm.createContext({ window: {}, document, Date,
    confirm(message) { confirmations.push(message); return confirmation; },
    fetch: async (url, options) => {
      const path = url.split("/").at(-1);
      calls.push({ path, method: options.method, body: options.body ? JSON.parse(options.body) : undefined });
      if (path === "source") return response({ configured: true, importSourceId: "own-source" });
      if (path === "simulate") return response(data);
      if (path === "apply") return post();
      if (path === "own-run") return get();
      if (path === "enroll") return response({ alreadyEnrolled: false });
      assert.fail(`Unexpected request: ${path}`);
    } });
  vm.runInContext(script, context);
  context.window.HomeClickCrmSync.iniciar(() => "test-token");
  await new Promise(resolve => setImmediate(resolve));
  await elements.get("crmSyncSimulate").listeners.click();
  const output = elements.get("crmSyncResults"), status = elements.get("crmSyncStatus");
  const button = descendants(output).find(item => item.textContent === "Aplicar cambios");
  const checkbox = descendants(output).find(item => item.type === "checkbox");
  if (checkbox) { checkbox.checked = true; checkbox.listeners.change(); }
  return { elements, output, status, button, calls, confirmations };
}

test("POST success is visible before GET completes and remains after refresh", async () => {
  let release, entered;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const h = await harness({ get: async () => { entered(); await waiting; return refreshed(); } });
  const pending = h.button.listeners.click();
  await started;
  assert.match(h.status.textContent, /1 anuncios actualizados/);
  assert.equal(h.status.classList.contains("error"), false);
  assert.ok(!descendants(h.output).some(item => item.textContent === "Aplicar cambios"));
  await h.button.listeners.click();
  assert.equal(h.calls.filter(call => call.path === "apply").length, 1);
  release(); await pending;
  assert.match(h.status.textContent, /1 anuncios actualizados/);
  assert.match(text(h.output), /ya se han aplicado/);
  assert.doesNotMatch(text(h.output), /no permite una futura aplicación/);
  assert.deepEqual(h.calls.find(call => call.path === "apply").body, { runId: "own-run", externalIds: ["CRM-1"] });
  assert.match(h.confirmations[0], /No se crearán ni eliminarán anuncios y no se modificarán fotos/);
});

for (const [name, get] of [
  ["network", async () => { throw new TypeError("Failed to fetch"); }],
  ["timeout", async () => { throw Object.assign(new Error("timeout"), { name: "AbortError" }); }],
  ["HTTP", () => response({ error: "Temporary error" }, 503)]
]) test(`POST success + GET ${name} failure keeps success and adds only a refresh notice`, async () => {
  const h = await harness({ get }); await h.button.listeners.click();
  assert.match(h.status.textContent, /1 anuncios actualizados/);
  assert.equal(h.status.classList.contains("error"), false);
  assert.match(text(h.output), /Los cambios se aplicaron correctamente, pero no se pudo actualizar el estado visual/);
  assert.match(text(h.output), /Recarga la página/);
  assert.doesNotMatch(h.status.textContent + text(h.output), /Failed to fetch|Temporary error|timeout|aplicación.*fall/);
  await h.button.listeners.click();
  assert.equal(h.calls.filter(call => call.path === "apply").length, 1);
});

test("POST rejection shows the existing error, no success and no follow-up GET", async () => {
  const h = await harness({ post: () => response({ error: "Vuelve a simular." }, 409) });
  await h.button.listeners.click();
  assert.equal(h.status.textContent, "Vuelve a simular.");
  assert.equal(h.status.classList.contains("error"), true);
  assert.ok(descendants(h.output).includes(h.button));
  assert.equal(h.calls.filter(call => call.path === "own-run").length, 0);
  assert.doesNotMatch(h.status.textContent, /actualizados|aplicaron correctamente/);
});

for (const [name, post] of [
  ["network exception", async () => { throw new TypeError("Failed to fetch"); }],
  ["timeout", async () => { throw Object.assign(new Error("timeout"), { name: "AbortError" }); }],
  ["unknown commit response", () => response({ code: "SYNC_APPLY_UNCONFIRMED" }, 503)],
  ["invalid success JSON", () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError(); } })],
  ["empty success body", () => response(null)]
]) test(`unconfirmed POST (${name}) never assumes success or retries`, async () => {
  const h = await harness({ post }); await h.button.listeners.click();
  assert.match(h.status.textContent, /No se pudo confirmar el resultado/);
  assert.match(h.status.textContent, /Consulta o refresca.*antes de volver a intentarlo/);
  assert.equal(h.status.classList.contains("error"), true);
  assert.doesNotMatch(h.status.textContent, /actualizados|aplicaron correctamente|Failed to fetch/);
  assert.equal(h.output.children.length, 0);
  await h.button.listeners.click();
  assert.equal(h.calls.filter(call => call.path === "apply").length, 1);
  assert.equal(h.calls.filter(call => call.path === "own-run").length, 0);
});

test("second click during the POST and after success does not send another apply", async () => {
  let release, entered;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const h = await harness({ post: async () => { entered(); await waiting; return success(); } });
  const pending = h.button.listeners.click(); await started;
  await h.button.listeners.click();
  release(); await pending; await h.button.listeners.click();
  assert.equal(h.calls.filter(call => call.path === "apply").length, 1);
  assert.equal(h.confirmations.length, 1);
});

test("cancelled confirmation does not apply or refresh", async () => {
  const h = await harness({ confirmation: false }); await h.button.listeners.click();
  assert.equal(h.calls.filter(call => ["apply", "own-run"].includes(call.path)).length, 0);
});

test("expired or truncated runs do not offer apply and a run expiring on screen is rejected", async () => {
  for (const reason of ["RUN_EXPIRED", "RUN_PLAN_TRUNCATED"]) {
    const h = await harness({ data: { ...preview(), applyEligible: false, applyBlockedReason: reason } });
    assert.equal(h.button, undefined);
    assert.equal(h.calls.filter(call => call.path === "apply").length, 0);
  }
  const data = preview(), h = await harness({ data });
  data.expiresAt = new Date(0).toISOString();
  await h.button.listeners.click();
  assert.match(text(h.output), /Esta simulación ha caducado/);
  assert.equal(h.calls.filter(call => call.path === "apply").length, 0);
});

test("enrollment remains explicit and asks for a fresh simulation without apply", async () => {
  const h = await harness({ data: { ...preview(), updateCount: 0, results: [
    { externalId: "CRM-1", type: "CONFLICT", blocked: true, enrollmentEligible: true, reason: "PROPERTY_SYNC_DISABLED" }
  ] } });
  const enroll = descendants(h.output).find(item => item.textContent === "Vincular anuncio");
  await enroll.listeners.click();
  assert.match(h.status.textContent, /Anuncio vinculado.*Vuelve a simular/);
  assert.deepEqual(h.calls.find(call => call.path === "enroll").body, { importSourceId: "own-source", externalIds: ["CRM-1"] });
  assert.equal(h.calls.filter(call => call.path === "apply").length, 0);
});
