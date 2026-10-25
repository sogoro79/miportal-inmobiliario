import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { buildSyncSnapshot } from "../utils/import/syncSnapshot.js";
import { prepareSyncPlan, safeRunSummary, snapshotDigest, runVersions } from "../utils/import/syncPlan.js";

const script = fs.readFileSync(new URL("../public/js/crm-sync-ui.js", import.meta.url), "utf8");
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const preview = (count = 1) => ({ runId: "own-run", status: "simulated", applyEligible: true,
  newImportEligible: true, snapshotComplete: true, expired: false,
  expiresAt: new Date(Date.now() + 60000).toISOString(), newCount: count,
  results: Array.from({ length: count }, (_, index) => ({ externalId: `NEW-${index + 1}`, type: "NEW",
    blocked: true, importNewEligible: true, importNewBlockCode: null, reason: "NEW_REQUIRES_MANUAL_IMPORT" })) });
const receipt = () => ({ status: "completed", selectedExternalIds: ["NEW-1"],
  counts: { imported: 1, skipped: 0, alreadyExists: 0, importedImages: 5, skippedImages: 0 },
  results: [{ externalId: "NEW-1", status: "imported" }] });
const success = () => response({ ok: true, runId: "own-run", newImport: receipt() });
function element(tag) {
  const classes = new Set();
  return { tag, attributes: {}, children: [], listeners: {}, textContent: "", disabled: false, checked: false, value: "",
    classList: { add(v) { classes.add(v); }, remove(v) { classes.delete(v); }, contains(v) { return classes.has(v); } },
    append(v) { this.children.push(v); }, replaceChildren() { this.children = []; },
    setAttribute(k, v) { this.attributes[k] = v; }, addEventListener(k, v) { this.listeners[k] = v; } };
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
const text = node => descendants(node).map(item => item.textContent).join("\n");
const checkboxes = output => descendants(output).filter(item => item.type === "checkbox");
const select = input => { input.checked = true; input.listeners.change(); };
async function harness({ data = preview(), post = success, simulate,
  get = () => response({ ...preview(), newImportEligible: false, newImport: receipt() }), confirmation = true } = {}) {
  const elements = new Map(), calls = [], confirmations = [];
  const document = { createElement: element, getElementById(id) {
    if (!elements.has(id)) elements.set(id, element("div"));
    return elements.get(id);
  } };
  const context = vm.createContext({ window: {}, document, Date,
    confirm(message) { confirmations.push(message); return confirmation; },
    fetch: async (url, options) => {
      const path = url.split("/").at(-1);
      calls.push({ path, method: options.method, body: options.body ? JSON.parse(options.body) : undefined });
      if (path === "source") return response({ configured: true, importSourceId: "own-source" });
      if (path === "simulate") return simulate ? simulate() : response(data);
      if (path === "import-new") return post();
      if (path === "own-run") return get();
      if (path === "apply") return response({ ok: true, appliedCount: 1 });
      if (path === "enroll") return response({ alreadyEnrolled: false });
      assert.fail(`Unexpected request: ${path}`);
    } });
  vm.runInContext(script, context);
  context.window.HomeClickCrmSync.iniciar(() => "test-token");
  await new Promise(resolve => setImmediate(resolve));
  await elements.get("crmSyncSimulate").listeners.click();
  const output = elements.get("crmSyncResults"), status = elements.get("crmSyncStatus");
  const button = descendants(output).find(item => item.textContent === "Importar nuevos");
  return { output, status, button, calls, confirmations, data, context };
}

test("eligible NEW has its own checkbox even when blocked for UPDATE", async () => {
  const h = await harness();
  assert.equal(checkboxes(h.output).length, 1);
  assert.match(text(h.output), /NEW-1: NEW · listo para importar/);
  assert.match(checkboxes(h.output)[0].attributes["aria-label"], /Seleccionar nuevo anuncio/);
  assert.match(text(h.output), /0 nuevos seleccionados \/ 10/);
  assert.equal(h.button.disabled, true);
});

for (const [name, change] of [
  ["ineligible", { newImportEligible: false }],
  ["expired", { newImportEligible: false, expired: true, newImportBlockedReason: "RUN_EXPIRED" }],
  ["truncated", { planTruncated: true, newImportBlockedReason: "RUN_PLAN_TRUNCATED" }],
  ["incomplete", { snapshotComplete: false, newImportBlockedReason: "RUN_SNAPSHOT_INCOMPLETE" }],
  ["importing", { newImport: { status: "importing" } }],
  ["indeterminate", { newImport: { status: "indeterminate" } }]
]) test(`${name} NEW has no checkbox or execution button`, async () => {
  const h = await harness({ data: { ...preview(), ...change } });
  assert.equal(checkboxes(h.output).length, 0);
  assert.equal(h.button, undefined);
  assert.equal(h.calls.filter(c => c.path === "import-new").length, 0);
});

test("entry explicitly ineligible or invalid has no NEW checkbox", async () => {
  for (const flags of [{ importNewEligible: false }, { errors: ["invalid"] }, { reason: "INVALID_RECORD" }]) {
    const data = preview(); Object.assign(data.results[0], flags);
    const h = await harness({ data });
    assert.equal(checkboxes(h.output).length, 0);
  }
});

test("NEW and UPDATE selections are independent; UPDATE is never sent to import-new", async () => {
  const data = preview(); data.results.push({ externalId: "UPDATE-1", type: "UPDATE", blocked: false, changedFields: ["precio"] });
  const h = await harness({ data });
  const inputs = checkboxes(h.output);
  const update = inputs.find(input => input.attributes["aria-label"].startsWith("Seleccionar cambios"));
  select(update);
  assert.equal(h.button.disabled, true);
  assert.match(text(h.output), /0 nuevos seleccionados/);
  select(inputs.find(input => input !== update));
  await h.button.listeners.click();
  assert.deepEqual(h.calls.find(c => c.path === "import-new").body, { runId: "own-run", externalIds: ["NEW-1"] });
  assert.equal(h.calls.filter(c => c.path === "apply").length, 0);
});

test("zero selected never confirms or sends POST", async () => {
  const h = await harness(); await h.button.listeners.click();
  assert.equal(h.confirmations.length, 0);
  assert.equal(h.calls.filter(c => c.path === "import-new").length, 0);
});

for (const size of [1, 10]) test(`${size} selected sends the exact contract and explicit confirmation`, async () => {
  const h = await harness({ data: preview(size) });
  checkboxes(h.output).forEach(select);
  await h.button.listeners.click();
  assert.deepEqual(h.calls.find(c => c.path === "import-new"), { path: "import-new", method: "POST",
    body: { runId: "own-run", externalIds: Array.from({ length: size }, (_, i) => `NEW-${i + 1}`) } });
  assert.match(h.confirmations[0], /consumirán cupo de tu plan/);
  assert.match(h.confirmations[0], /No se modificarán anuncios existentes/);
});

test("eleventh checkbox cannot extend the selection beyond ten", async () => {
  const h = await harness({ data: preview(11) });
  checkboxes(h.output).forEach(select);
  assert.equal(checkboxes(h.output)[10].checked, false);
  assert.match(text(h.output), /como máximo 10/);
  await h.button.listeners.click();
  assert.equal(h.calls.find(c => c.path === "import-new").body.externalIds.length, 10);
});

test("cancelled confirmation does not POST and allows selecting again", async () => {
  const h = await harness({ confirmation: false }); select(checkboxes(h.output)[0]);
  await h.button.listeners.click();
  assert.equal(h.calls.filter(c => c.path === "import-new").length, 0);
  assert.equal(h.button.disabled, false);
});

test("confirmed receipt is visible immediately before GET finishes; double click blocked", async () => {
  let release, entered;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const h = await harness({ get: async () => { entered(); await waiting; return response({ ...preview(), newImport: receipt() }); } });
  select(checkboxes(h.output)[0]); const pending = h.button.listeners.click(); await started;
  assert.match(h.status.textContent, /Importación completada/);
  assert.match(text(h.output), /1 anuncio importado/);
  assert.match(text(h.output), /5 imágenes importadas · 0 imágenes omitidas/);
  assert.match(text(h.output), /NEW-1: Importado/);
  assert.ok(descendants(h.output).some(item => item.href === "/perfil.html#listaPropiedades"));
  await h.button.listeners.click(); release(); await pending; await h.button.listeners.click();
  assert.equal(h.calls.filter(c => c.path === "import-new").length, 1);
});

test("double click while POST is pending sends one request and freezes selection", async () => {
  let release, entered;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const h = await harness({ post: async () => { entered(); await waiting; return success(); } });
  const input = checkboxes(h.output)[0]; select(input);
  const pending = h.button.listeners.click(); await started;
  assert.equal(h.button.disabled, true); assert.equal(input.disabled, true);
  await h.button.listeners.click(); release(); await pending;
  assert.equal(h.calls.filter(c => c.path === "import-new").length, 1);
  assert.equal(h.confirmations.length, 1);
});

for (const get of [async () => { throw new TypeError("Failed to fetch"); }, () => response({ error: "private error" }, 503)])
  test("failed GET preserves confirmed import and adds a separate refresh notice", async () => {
    const h = await harness({ get }); select(checkboxes(h.output)[0]); await h.button.listeners.click();
    assert.match(h.status.textContent, /Importación completada/);
    assert.equal(h.status.classList.contains("error"), false);
    assert.match(text(h.output), /1 anuncio importado/);
    assert.match(text(h.output), /importación se confirmó correctamente, pero/);
    assert.doesNotMatch(text(h.output), /private error|Failed to fetch/);
  });

for (const [code, expected] of [
  ["ALREADY_EXISTS", /ya existe/], ["PLAN_LIMIT", /cupo suficiente/], ["SYNC_NEW_PLAN_LIMIT", /cupo suficiente/], ["RUN_EXPIRED", /caducado/],
  ["SOURCE_BUSY", /ocupada/], ["SYNC_SOURCE_BUSY", /ocupada/],
  ["RECONCILIATION_PENDING", /pendiente de comprobación/], ["SYNC_NEW_RECONCILIATION_PENDING", /pendiente de comprobación/],
  ["INDETERMINATE", /No se pudo confirmar/], ["SYNC_NEW_UNCONFIRMED", /No se pudo confirmar/],
  ["SYNC_NEW_SELECTION_MISMATCH", /selección no coincide/], ["SYNC_NEW_IN_PROGRESS", /en curso/]
]) test(`${code} produces a safe message without false success`, async () => {
  const h = await harness({ post: () => response({ code, error: "private internal details" }, 409) });
  select(checkboxes(h.output)[0]); await h.button.listeners.click();
  assert.match(h.status.textContent, expected);
  assert.doesNotMatch(h.status.textContent, /completada|private internal/);
  assert.equal(h.status.classList.contains("error"), true);
  assert.equal(h.calls.filter(c => c.path === "own-run").length, 0);
});

for (const post of [async () => { throw new TypeError("Failed to fetch"); }, () => response(null)])
  test("indeterminate POST never assumes success or retries", async () => {
    const h = await harness({ post }); select(checkboxes(h.output)[0]); await h.button.listeners.click();
    assert.match(h.status.textContent, /No se pudo confirmar/);
    assert.match(h.status.textContent, /antes de volver a intentarlo/);
    await h.button.listeners.click();
    assert.equal(h.calls.filter(c => c.path === "import-new").length, 1);
    assert.equal(descendants(h.output).some(item => item.textContent === "Importar nuevos"), false);
  });

test("completed operation renders stored receipt without a new execution or selection", async () => {
  const h = await harness({ data: { ...preview(), newImportEligible: false, newImport: receipt() } });
  assert.equal(h.button, undefined); assert.equal(checkboxes(h.output).length, 0);
  assert.match(text(h.output), /1 anuncio importado/);
  assert.equal(h.calls.filter(c => c.path === "import-new").length, 0);
});

test("stale GET cannot replace the receipt acknowledged by POST", async () => {
  const stale = receipt(); stale.counts.imported = 0; stale.results = [];
  const h = await harness({ get: () => response({ ...preview(), newImport: stale }) });
  select(checkboxes(h.output)[0]); await h.button.listeners.click();
  assert.match(text(h.output), /1 anuncio importado/);
  assert.match(text(h.output), /NEW-1: Importado/);
  assert.doesNotMatch(text(h.output), /0 anuncios importados/);
  assert.equal(descendants(h.output).some(item => item.textContent === "Importar nuevos"), false);
});

test("failed POST does not present success or retry automatically", async () => {
  const h = await harness({ post: () => response({ code: "SYNC_NEW_FAILED", error: "internal error" }, 500) });
  select(checkboxes(h.output)[0]); await h.button.listeners.click(); await h.button.listeners.click();
  assert.equal(h.status.classList.contains("error"), true);
  assert.doesNotMatch(h.status.textContent, /Importación completada|internal error/);
  assert.equal(h.calls.filter(c => c.path === "import-new").length, 1);
});

test("external IDs are rendered as text, never HTML", async () => {
  const data = preview(); data.results[0].externalId = "<img src=x onerror=alert(1)>";
  const h = await harness({ data });
  const row = descendants(h.output).find(item => item.tag === "li");
  assert.match(row.textContent, /<img src=x/);
  assert.equal(row.children.some(item => item.tag === "img"), false);
  assert.doesNotMatch(script, /innerHTML/);
});

test("run expiring after render cannot execute NEW", async () => {
  const data = preview(), h = await harness({ data }); select(checkboxes(h.output)[0]);
  data.expiresAt = new Date(0).toISOString(); await h.button.listeners.click();
  assert.equal(h.button.disabled, true); assert.match(text(h.output), /caducado/);
  assert.equal(h.calls.filter(c => c.path === "import-new").length, 0);
});

test("receipt with skips and already-existing references remains truthful", async () => {
  const operation = receipt(); Object.assign(operation.counts, { imported: 0, skipped: 1, alreadyExists: 1 });
  operation.results = [{ externalId: "NEW-1", status: "already_exists", reason: "ALREADY_EXISTS" },
    { externalId: "NEW-2", status: "skipped", reason: "CREATION_FAILED" }];
  const h = await harness({ post: () => response({ ok: true, newImport: operation }), get: async () => { throw new Error(); } });
  select(checkboxes(h.output)[0]); await h.button.listeners.click();
  assert.match(text(h.output), /0 anuncios importados · 2 omitidos/);
  assert.match(text(h.output), /NEW-1: Ya existe/); assert.match(text(h.output), /NEW-2: Omitido/);
});

test("responsive profile keeps wrapped content, bounded buttons and cache version", () => {
  const html = fs.readFileSync(new URL("../public/perfil.html", import.meta.url), "utf8");
  assert.match(html, /crm-sync-results[^}]*overflow-wrap: anywhere/);
  assert.match(html, /crm-sync-results \.btn-perfil[^}]*max-width: 100%; white-space: normal/);
  assert.match(html, /crm-sync-ui\.js\?v=13/);
});

for (const publicable of [true, false]) test(`real snapshot -> safe summary -> UI: publicable=${publicable}`, async () => {
  const xml = `<properties><property><id>REAL-NEW</id><title>Casa de prueba</title><operation>venta</operation>${publicable ? "<price>210000</price>" : ""}<address>Direccion de prueba</address><bedrooms>2</bedrooms></property></properties>`;
  const snapshot = buildSyncSnapshot(xml);
  const data = safeRunSummary({ _id: "507f1f77bcf86cd799439011", importSourceId: "507f1f77bcf86cd799439012",
    status: "simulated", snapshotComplete: snapshot.snapshotComplete, sourceIdentityHash: "a".repeat(64),
    snapshotDigest: snapshotDigest(snapshot), expiresAt: new Date(Date.now() + 600000),
    ...runVersions, ...prepareSyncPlan(snapshot, []) });
  assert.equal(data.newImportEligible, true);
  assert.equal(data.results[0].importNewEligible, publicable);
  assert.equal(data.results[0].importNewBlockCode, publicable ? null : "SYNC_NEW_INVALID_DATA");
  const h = await harness({ data });
  assert.equal(checkboxes(h.output).length, publicable ? 1 : 0);
  if (!publicable) assert.match(text(h.output), /datos que no permiten publicar/);
  assert.doesNotMatch(JSON.stringify(data.results), /Direccion de prueba|210000|Casa de prueba/);
});

test("legacy plan without individual eligibility requires resimulation", async () => {
  const data = preview(); delete data.results[0].importNewEligible;
  const h = await harness({ data });
  assert.equal(h.button, undefined);
  assert.equal(checkboxes(h.output).length, 0);
});
test("InmoWeb OFF shows activation pending with no NEW checkbox or button", async () => {
  const data = { ...preview(), feedType: "inmoweb", snapshotComplete: false,
    newImportEligible: false, newImportBlockedReason: "INMOWEB_NEW_DISABLED" };
  const h = await harness({ data });
  assert.equal(checkboxes(h.output).length, 0);
  assert.equal(h.button, undefined);
  assert.match(text(h.output), /Importación InmoWeb preparada\. Activación pendiente\./);
});

for (const status of [502, 503, 504]) for (const json of [false, true])
  test(`gateway ${status}, JSON body=${json}: indeterminate, GET recovery only`, async () => {
    const post = () => json ? response({ error: "gateway private error", code: "UNKNOWN_GATEWAY" }, status)
      : { ok: false, status, json: async () => { throw new SyntaxError("HTML"); } };
    const h = await harness({ post }); select(checkboxes(h.output)[0]); await h.button.listeners.click();
    assert.match(h.status.textContent, /No se pudo confirmar/);
    assert.doesNotMatch(h.status.textContent, /completada|gateway private/);
    await h.button.listeners.click();
    const consult = descendants(h.output).find(item => item.textContent === "Consultar estado");
    assert.ok(consult); await consult.listeners.click();
    assert.match(h.status.textContent, /Importación confirmada/);
    assert.match(text(h.output), /1 anuncio importado/);
    assert.equal(h.calls.filter(c => c.path === "import-new").length, 1);
    const calls = h.calls.filter(c => c.path === "own-run");
    assert.equal(calls.length, 1); assert.equal(calls[0].method, "GET"); assert.equal(calls[0].body, undefined);
  });

for (const state of ["importing", "indeterminate", "failed"]) test(`consult ${state} keeps NEW blocked and safe`, async () => {
  const operation = { status: state, results: [], failureCode: "SYNC_NEW_PLAN_LIMIT" };
  const h = await harness({ post: async () => { throw new TypeError(); },
    get: () => response({ ...preview(), newImportEligible: false, newImport: operation }) });
  select(checkboxes(h.output)[0]); await h.button.listeners.click();
  const consult = descendants(h.output).find(item => item.textContent === "Consultar estado");
  await consult.listeners.click();
  assert.match(h.status.textContent, state === "importing" ? /en curso/ : state === "indeterminate" ? /No se pudo confirmar/ : /cupo suficiente/);
  assert.equal(descendants(h.output).some(item => item.textContent === "Importar nuevos"), false);
  assert.ok(descendants(h.output).some(item => item.textContent === "Consultar estado"));
  assert.equal(h.calls.filter(c => c.path === "import-new").length, 1);
});

test("failed state GET keeps manual consult and never sends POST again", async () => {
  const h = await harness({ post: async () => { throw new TypeError(); }, get: async () => { throw new Error("private URL"); } });
  select(checkboxes(h.output)[0]); await h.button.listeners.click();
  const consult = descendants(h.output).find(item => item.textContent === "Consultar estado");
  await consult.listeners.click(); await consult.listeners.click();
  assert.match(h.status.textContent, /No se pudo consultar el estado/);
  assert.doesNotMatch(h.status.textContent, /private URL/);
  assert.equal(h.calls.filter(c => c.path === "own-run").length, 2);
  assert.equal(h.calls.filter(c => c.path === "import-new").length, 1);
});

test("recalculating selection after expiry disables NEW immediately", async () => {
  const data = preview(), h = await harness({ data });
  data.expiresAt = new Date(0).toISOString(); select(checkboxes(h.output)[0]);
  assert.equal(h.button.disabled, true);
  assert.equal(checkboxes(h.output)[0].disabled, true);
  assert.match(text(h.output), /La simulación|simulación ha caducado/);
  assert.equal(h.calls.filter(c => c.path === "import-new").length, 0);
});

test("recognized gateway error retains its existing safe semantics", async () => {
  const h = await harness({ post: () => response({ code: "FEED_TIMEOUT" }, 504) });
  select(checkboxes(h.output)[0]); await h.button.listeners.click();
  assert.doesNotMatch(h.status.textContent, /No se pudo confirmar/);
  assert.equal(descendants(h.output).some(item => item.textContent === "Consultar estado"), false);
});

// Use the real DTO and synthetic provider identity, never a production external ID.
async function inmowebSummary() {
  const { buildFeedSnapshot } = await import("../utils/importers/importerRegistry.js");
  const xml = fs.readFileSync(new URL("./fixtures/crm/inmoweb-synthetic.xml", import.meta.url), "utf8");
  const snapshot = buildFeedSnapshot(xml, { feedType: "inmoweb" });
  const env = { INMOWEB_NEW_ENABLED: "true", INMOWEB_NEW_ALLOWED_EXTERNAL_IDS: "0001" };
  const run = { _id: "own-run", importSourceId: "507f1f77bcf86cd799439012", feedType: "inmoweb",
    status: "simulated", snapshotComplete: snapshot.snapshotComplete, newSnapshotComplete: true,
    providerNormalizationVersion: 1, sourceIdentityHash: "a".repeat(64), snapshotDigest: snapshotDigest(snapshot),
    expiresAt: new Date(Date.now() + 600000), ...runVersions, ...prepareSyncPlan(snapshot, []) };
  return { data: safeRunSummary(run, new Date(), env), run, env };
}

test("InmoWeb NEW: real DTO exposes separate completeness and permits selecting an authorized synthetic ID", async () => {
  const { data, env } = await inmowebSummary();
  const { assertInmowebNewSelectionAllowed } = await import("../utils/import/inmowebPolicy.js");
  assert.equal(data.snapshotComplete, false);
  assert.equal(data.newSnapshotComplete, true);
  assert.equal(data.newImportEligible, true);
  assert.equal(data.applyEligible, false);
  const h = await harness({ data });
  assert.match(text(h.output), /0001: NEW · listo para importar/);
  assert.equal(checkboxes(h.output).length, 1);
  select(checkboxes(h.output)[0]);
  assert.equal(h.button.disabled, false);
  await h.button.listeners.click();
  const selection = h.calls.find(c => c.path === "import-new").body.externalIds;
  assert.deepEqual(selection, ["0001"]);
  assert.doesNotThrow(() => assertInmowebNewSelectionAllowed("inmoweb", selection, env));
});

for (const complete of [false, undefined]) test(`InmoWeb NEW fails closed with independent completeness=${complete}`, async () => {
  const { data, run, env } = await inmowebSummary();
  const dto = safeRunSummary({ ...run, newSnapshotComplete: complete }, new Date(), env);
  assert.equal(dto.newSnapshotComplete, false);
  assert.equal(dto.newImportEligible, false);
  // UI independently requires explicit evidence, even with an inconsistent eligibility flag.
  const h = await harness({ data: { ...data, newSnapshotComplete: complete } });
  assert.equal(checkboxes(h.output).length, 0);
  assert.equal(h.button, undefined);
});

test("generic XML NEW cannot use InmoWeb completeness to bypass an incomplete snapshot", async () => {
  const h = await harness({ data: { ...preview(), feedType: "generic_xml", snapshotComplete: false, newSnapshotComplete: true } });
  assert.equal(checkboxes(h.output).length, 0);
  assert.equal(h.button, undefined);
});

test("InmoWeb NEW readiness does not enable MISSING, REAPPEARED, UPDATE or enrollment", async () => {
  const { data } = await inmowebSummary();
  data.results.push(
    { externalId: "ABSENT", type: "MISSING", hideMissingEligible: true },
    { externalId: "RETURNED", type: "REAPPEARED", restoreEligible: true },
    { externalId: "CHANGED", type: "UPDATE", blocked: true },
    { externalId: "UNLINKED", type: "UNCHANGED", enrollmentEligible: true, reason: "PROPERTY_SYNC_DISABLED" },
    { externalId: "DENIED", type: "NEW", importNewEligible: false, reason: "NEW_REQUIRES_MANUAL_IMPORT" }
  );
  const h = await harness({ data });
  assert.equal(checkboxes(h.output).length, 1);
  assert.match(checkboxes(h.output)[0].attributes["aria-label"], /0001/);
  assert.equal(h.calls.some(c => ["apply", "enroll", "hide-missing", "restore-reappeared"].includes(c.path)), false);
});


test("recent capture age is shown without infrastructure details", async () => {
  const h = await harness({ data: { ...preview(), feedFetchedAt: new Date(Date.now() - 120000).toISOString() } });
  assert.match(text(h.output), /Datos actualizados hace 2 minutos/);
});

test("provider cooldown is a safe rejection, not an unconfirmed NEW write", async () => {
  const h = await harness({ post: () => response({ code: "CRM_PROVIDER_TEMPORARILY_BLOCKED",
    error: "El proveedor no está disponible temporalmente. Inténtalo más tarde." }, 503) });
  select(checkboxes(h.output)[0]);
  await h.button.listeners.click();
  assert.match(text(h.output) + h.status.textContent, /El proveedor no está disponible temporalmente/);
  assert.doesNotMatch(text(h.output) + h.status.textContent, /Render|whitelist|proxy|403|resultado no está confirmado/i);
  assert.equal(h.calls.filter(call => call.path === "import-new").length, 1);
});


test("InmoWeb unavailable keeps the previous review and uses nontechnical copy", async () => {
  let attempts = 0;
  const h = await harness({ simulate: () => ++attempts === 1 ? response(preview()) : response({
    code: "INMOWEB_TEMPORARILY_UNAVAILABLE", error: "No podemos actualizar InmoWeb en este momento. Inténtalo más tarde."
  }, 503) });
  const before = text(h.output);
  await h.context.document.getElementById("crmSyncSimulate").listeners.click();
  assert.equal(text(h.output), before);
  assert.equal(h.status.textContent, "No podemos actualizar InmoWeb en este momento. Conservamos la última revisión disponible.");
  assert.equal(attempts, 2);
});

test("missing InmoWeb capture asks for a new review, never retries import", async () => {
  const h = await harness({ post: () => response({ code: "INMOWEB_FRESH_SNAPSHOT_REQUIRED",
    error: "Actualiza y revisa los inmuebles de InmoWeb antes de importar." }, 409) });
  select(checkboxes(h.output)[0]); await h.button.listeners.click();
  assert.match(text(h.output) + h.status.textContent, /Actualiza y revisa los inmuebles de InmoWeb/);
  assert.equal(h.calls.filter(call => call.path === "import-new").length, 1);
});
