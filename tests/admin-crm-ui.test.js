import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const script = fs.readFileSync(new URL("../public/js/admin-crm.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
function element(tag) {
  return { tag, children: [], textContent: "", disabled: false, style: {},
    addEventListener() {}, append(...items) { this.children.push(...items); },
    replaceChildren() { this.children = []; }, showModal() { this.open = true; }, close() { this.open = false; } };
}
test("admin opens the target's CRM, simulates without importing, and confirms selected NEW for that account", async () => {
  assert.match(html, /abrirCrmDelegado\('\$\{u\._id\}'\)/);
  const elements = new Map(), calls = [], prompts = [];
  const document = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, element("div"));
    return elements.get(id);
  }, createElement: element, createTextNode: text => Object.assign(element("text"), { textContent: text }) };
  const get = key => document.getElementById("crmDelegated" + key);
  const date = new Date(Date.now() + 60000).toISOString();
  const responses = {
    source: { nombre: "Titular ficticio", provider: "inmoweb", sourceConfigured: true, active: true, authorized: true,
      grantActive: true, planActive: true, plan: "pro", available: 2, feedUrlMasked: "https://example.test/..." },
    simulate: { runId: "run", snapshotCount: 2, newCount: 2, newImportEligible: true, expiresAt: date, snapshotExpiresAt: date,
      results: [{ type: "NEW", externalId: "ALLOW", importNewEligible: true }, { type: "NEW", externalId: "DENY", importNewEligible: false }] },
    "import-new": { newImport: { status: "completed", counts: { imported: 1 } } }
  };
  const context = vm.createContext({ window: {}, document, adminToken: "admin-test-token", Date,
    confirm(message) { prompts.push(message); return true; },
    fetch: async (path, opts) => {
      assert.match(path, /^\/api\/crm-import\/admin\/users\/target\//);
      assert.equal(opts.headers.Authorization, "Bearer admin-test-token");
      calls.push([path.split("/").at(-1), opts.body && JSON.parse(opts.body)]);
      return { ok: true, json: async () => responses[calls.at(-1)[0]] };
    } });
  vm.runInContext(script, context);
  await context.window.abrirCrmDelegado("target");
  assert.equal(get("Target").textContent, "Estás importando inmuebles para: Titular ficticio");
  assert.deepEqual(calls.map(c => c[0]), ["source"]);
  await get("Simulate").onclick();
  const rows = get("Results").children;
  const inputs = rows.flatMap(row => row.children).filter(item => item.tag === "input");
  assert.deepEqual(inputs.map(input => input.value), ["ALLOW"]);
  inputs[0].checked = true;
  await rows.find(el => el.textContent === "Importar seleccionados").onclick();
  assert.deepEqual(calls.at(-1), ["import-new", { runId: "run", externalIds: ["ALLOW"] }]);
  assert.match(prompts[0], /Titular ficticio.*directamente en su cuenta/);
  assert.equal(get("Results").children.some(el => el.textContent === "Importar seleccionados"), false);
});
