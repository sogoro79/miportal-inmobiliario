import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { cleanup, parseArgs, EXTERNAL_ID, ALLOWED_EXTERNAL_IDS, FEED_URL, CONFIRM } from "../scripts/cleanup-crm-sync-missing.js";

const U = "000000000000000000000001", S = "000000000000000000000002", P = "000000000000000000000003";
const options = { "user-id": U, "source-id": S, apply: false };
const values = (doc, keys) => !keys.length ? Array.isArray(doc) ? doc.flatMap(v => values(v, [])) : [doc]
  : Array.isArray(doc) ? doc.flatMap(v => values(v, keys)) : values(doc?.[keys[0]], keys.slice(1));
function matches(doc, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return expected.some(f => matches(doc, f));
    const actual = values(doc, key.split("."));
    if (expected && typeof expected === "object") {
      if ("$in" in expected) return actual.some(v => expected.$in.includes(v));
      if ("$exists" in expected) return actual.some(v => v !== undefined) === expected.$exists;
    }
    return actual.some(v => v === expected);
  });
}
function harness() {
  let db = {
    Usuario: [{ _id: U, plan: "lanzamiento_2026", publicationVersion: 1 }], Propiedad: [],
    ImportSource: [{ _id: S, usuarioId: U, feedType: "generic_xml", feedUrlHash: crypto.createHash("sha256").update(FEED_URL).digest("hex") }],
    ImportSyncRun: [{ _id: "run", usuarioId: U, importSourceId: S, status: "simulated", plan: [{ externalId: EXTERNAL_ID }],
      missingHide: { status: "completed", selectedExternalIds: [EXTERNAL_ID], results: [{ externalId: EXTERNAL_ID, status: "hidden" }] },
      newImport: { status: "completed", selectedExternalIds: [EXTERNAL_ID], results: [{ externalId: EXTERNAL_ID, propertyId: P }] } }],
    ImportReconciliation: []
  };
  let tx, writes = 0, failDelete = false, failPost = false;
  const reads = [];
  const models = Object.fromEntries(Object.keys(db).map(name => [name, {
    find(filter) {
      reads.push({ name, filter }); let session;
      return { select() { return this; }, session(v) { session = v; return this; }, async lean() {
        const records = (session ? tx : db)[name];
        if (session && failPost && name === "ImportSource" && !records.length) return structuredClone(db.ImportSource);
        return structuredClone(records.filter(v => matches(v, filter)));
      } };
    },
    async updateOne(filter, op, { session }) {
      assert.equal(name, "ImportSource"); assert.ok(session); writes++;
      const record = tx[name].find(v => matches(v, filter));
      if (!record) return { matchedCount: 0 }; Object.assign(record, op.$set); return { matchedCount: 1 };
    },
    async deleteMany(filter, { session }) {
      assert.ok(["ImportSource", "ImportSyncRun", "ImportReconciliation"].includes(name)); assert.ok(session); writes++;
      const before = tx[name].length;
      if (!failDelete) tx[name] = tx[name].filter(v => !matches(v, filter));
      return { deletedCount: before - tx[name].length };
    }
  }]));
  for (const forbidden of ["Conversacion", "Mensaje", "Notificacion", "EstadisticaAnuncio"])
    models[forbidden] = new Proxy({}, { get() { assert.fail(`Forbidden model access: ${forbidden}`); } });
  const deps = { models, startSession: async () => ({ async withTransaction(fn) {
    tx = structuredClone(db); try { await fn(); db = tx; } finally { tx = undefined; }
  }, async endSession() {} }) };
  return { deps, reads, get db() { return db; }, get writes() { return writes; },
    failDeletes() { failDelete = true; }, failVerification() { failPost = true; },
    dry: () => cleanup(options, deps),
    apply: planHash => cleanup({ ...options, apply: true, confirm: CONFIRM, "expect-plan": planHash }, deps) };
}
test("CLI is dry-run by default and requires exact simultaneous apply confirmation/hash", () => {
  assert.equal(parseArgs([`--user-id=${U}`, `--source-id=${S}`]).apply, false);
  for (const extra of [["--apply"], ["--apply", `--confirm=${CONFIRM}`], ["--unknown=x"]])
    assert.throws(() => parseArgs([`--user-id=${U}`, `--source-id=${S}`, ...extra]));
});
test("missing property is expected; dry-run reports safe CRM plan without writes", async () => {
  const h = harness(), before = structuredClone(h.db), r = await h.dry();
  assert.equal(r.resultado, "APTO PARA LIMPIEZA"); assert.equal(r.propiedadEncontrada, false);
  assert.equal(r.otrasPropiedadesAfectadas, 0); assert.equal(r.newImportReceipts, 1);
  assert.equal(r.missingHideReceipts, 1); assert.equal(r.applyReceipts, 0);
  assert.deepEqual(r.allowedExternalIds, ALLOWED_EXTERNAL_IDS);
  assert.equal(r.dryRun, true); assert.equal(h.writes, 0); assert.deepEqual(h.db, before);
});
test("apply deletes only CRM metadata and embedded receipts; second apply has zero writes", async () => {
  const h = harness();
  h.db.Propiedad.push({ _id: "other", usuarioId: U, externalId: "OTHER" });
  h.db.ImportSource.push({ _id: "other-source", usuarioId: "other-user" });
  h.db.ImportSyncRun.push({ _id: "other-run", usuarioId: "other-user", importSourceId: "other-source" });
  h.db.ImportReconciliation.push({ _id: "other-rec", usuarioId: "other-user", importSourceId: "other-source", externalId: "OTHER" });
  const before = structuredClone(h.db);
  const r = await h.apply((await h.dry()).planHash);
  assert.deepEqual(r.deleted, { ImportSyncRun: 1, ImportReconciliation: 0, ImportSource: 1 });
  assert.equal(r.verificacionPosterior, true);
  assert.deepEqual(h.db.Usuario, before.Usuario); assert.deepEqual(h.db.Propiedad, before.Propiedad);
  assert.deepEqual(h.db.ImportSource, [before.ImportSource[1]]);
  assert.deepEqual(h.db.ImportSyncRun, [before.ImportSyncRun[1]]);
  assert.deepEqual(h.db.ImportReconciliation, before.ImportReconciliation);
  const writes = h.writes; assert.equal((await h.apply(r.planHash)).resultado, "YA LIMPIO"); assert.equal(h.writes, writes);
  assert.ok(h.reads.some(r => r.name === "ImportSyncRun" && r.filter.$or?.some(f => f["newImport.results.propertyId"]?.$in?.includes(P))));
});
const mutations = {
  "property externalId reappears": db => db.Propiedad.push({ _id: P, externalId: EXTERNAL_ID }),
  "control property reappears": db => db.Propiedad.push({ _id: P, externalId: ALLOWED_EXTERNAL_IDS[1] }),
  "property source reappears": db => db.Propiedad.push({ _id: P, importSourceId: S, externalId: "OTHER" }),
  "receipt points to live unrelated property": db => db.Propiedad.push({ _id: P, externalId: "OTHER" }),
  "wrong source URL": db => { db.ImportSource[0].feedUrlHash = "bad"; },
  "wrong source owner": db => { db.ImportSource[0].usuarioId = "other"; },
  "shared run": db => db.ImportSyncRun[0].plan.push({ externalId: "OTHER" }),
  "foreign receipt": db => db.ImportSyncRun[0].newImport.results.push({ externalId: "OTHER" }),
  "wrong run owner": db => { db.ImportSyncRun[0].usuarioId = "other"; },
  "wrong run source": db => { db.ImportSyncRun[0].importSourceId = "other"; },
  "truncated run": db => { db.ImportSyncRun[0].planTruncated = true; },
  "active lock": db => { db.ImportSource[0].importLockToken = "locked"; },
  "indeterminate receipt": db => { db.ImportSyncRun[0].newImport.status = "indeterminate"; },
  "indeterminate missing hide": db => { db.ImportSyncRun[0].missingHide.status = "indeterminate"; },
  "foreign missing receipt": db => db.ImportSyncRun[0].missingHide.results.push({ externalId: "OTHER", status: "hidden" }),
  "control hidden unexpectedly": db => { db.ImportSyncRun[0].missingHide.selectedExternalIds = [ALLOWED_EXTERNAL_IDS[1]]; },
  "mismatched run hash": db => { db.ImportSyncRun[0].sourceIdentityHash = "bad"; },
  "future lock without token": db => { db.ImportSource[0].importLockUntil = new Date(Date.now() + 60000); },
  "foreign missing evidence": db => { db.ImportSyncRun[0].plan[0].missingEvidence = { usuarioId: "other", importSourceId: S }; },
  "invalid property ID": db => db.ImportSyncRun[0].plan.push({ externalId: EXTERNAL_ID, propiedadId: "invalid" }),
  "CRM reference from another source": db => db.ImportSyncRun.push({ _id: "cross", usuarioId: "other", importSourceId: "other", plan: [{ externalId: "OTHER", propiedadId: P }] }),
  "foreign reconciliation": db => db.ImportReconciliation.push({ _id: "rec", usuarioId: "other", importSourceId: S, externalId: EXTERNAL_ID, source: "crm", state: "prepared", publicIds: [] }),
  "pending reconciliation": db => db.ImportReconciliation.push({ _id: "rec", usuarioId: U, importSourceId: S, externalId: EXTERNAL_ID, source: "crm", state: "unknown", publicIds: [], propiedadId: P })
};
for (const [name, mutate] of Object.entries(mutations)) test(`${name} aborts without modifying any data`, async () => {
  const h = harness(), plan = (await h.dry()).planHash;
  mutate(h.db); const before = structuredClone(h.db);
  assert.equal((await h.dry()).resultado, "NO APTO PARA LIMPIEZA");
  await assert.rejects(() => h.apply(plan)); assert.deepEqual(h.db, before); assert.equal(h.writes, 0);
});
test("unambiguous prepared reconciliation is deleted with dedicated CRM metadata", async () => {
  const h = harness();
  h.db.ImportReconciliation.push({ _id: "rec", usuarioId: U, importSourceId: S, externalId: EXTERNAL_ID, source: "crm", state: "prepared", publicIds: [], propiedadId: P });
  const r = await h.apply((await h.dry()).planHash); assert.equal(r.deleted.ImportReconciliation, 1);
});
test("changed dry-run plan aborts; partial delete and failed post verification roll back", async () => {
  const h = harness(), plan = (await h.dry()).planHash;
  h.db.ImportSyncRun[0].updatedAt = new Date();
  await assert.rejects(() => h.apply(plan), { code: "PLAN_CHANGED" });
  const fresh = (await h.dry()).planHash, before = structuredClone(h.db);
  h.failDeletes(); await assert.rejects(() => h.apply(fresh), { code: "DELETE_COUNT_MISMATCH" }); assert.deepEqual(h.db, before);
  const second = harness(), untouched = structuredClone(second.db), secondPlan = (await second.dry()).planHash;
  second.failVerification();
  await assert.rejects(() => second.apply(secondPlan), { code: "POST_VERIFICATION_FAILED" });
  assert.deepEqual(second.db, untouched);
});
test("script has no forbidden models, property writes, media inspection or Cloudinary", () => {
  const code = readFileSync(new URL("../scripts/cleanup-crm-sync-missing.js", import.meta.url), "utf8");
  assert.doesNotMatch(code, /Cloudinary|imagenes|videoUrl|Conversacion|Notificacion|EstadisticaAnuncio|favoritos/i);
  assert.doesNotMatch(code, /models\.(Propiedad|Usuario)\.(delete|update|save)/);
});
test("BASE and MISSING runs containing only TEST and CONTROL are both accepted", async () => {
  const h = harness();
  h.db.ImportSyncRun.push({ _id: "base", usuarioId: U, importSourceId: S, status: "simulated",
    plan: [{ externalId: EXTERNAL_ID, propiedadId: P }], totalResults: 1 });
  h.db.ImportSyncRun[0].plan.push({ externalId: ALLOWED_EXTERNAL_IDS[1], type: "NEW" });
  h.db.ImportSyncRun[0].totalResults = 2;
  const report = await h.dry();
  assert.equal(report.resultado, "APTO PARA LIMPIEZA");
  assert.equal(report.importSyncRuns, 2);
  assert.equal(report.missingHideReceipts, 1);
  assert.deepEqual(report.runs.find(r => r.runId === "run").externalIds, ALLOWED_EXTERNAL_IDS);
  const result = await h.apply(report.planHash);
  assert.equal(result.deleted.ImportSyncRun, 2);
  assert.equal(h.db.ImportSyncRun.length, 0);
  assert.ok(h.reads.some(r => r.name === "ImportSyncRun" && r.filter._id?.$in?.includes("base")));
});
test("plan hash includes receipt content, run IDs and reconciliation IDs", async () => {
  const h = harness(), initial = (await h.dry()).planHash;
  h.db.ImportSyncRun[0].missingHide.results[0].status = "already_hidden";
  const changed = (await h.dry()).planHash;
  assert.notEqual(changed, initial);
  await assert.rejects(() => h.apply(initial), { code: "PLAN_CHANGED" });
  assert.equal(h.writes, 0);
  h.db.ImportSyncRun[0]._id = "changed-run";
  assert.notEqual((await h.dry()).planHash, changed);
  const prior = (await h.dry()).planHash;
  h.db.ImportReconciliation.push({ _id: "rec", usuarioId: U, importSourceId: S,
    propiedadId: P, source: "crm", externalId: EXTERNAL_ID, state: "prepared", publicIds: [] });
  assert.notEqual((await h.dry()).planHash, prior);
});
test("apply UPDATE receipt is counted but deleted only as part of its run", async () => {
  const h = harness();
  h.db.ImportSyncRun[0].selectedExternalIds = [EXTERNAL_ID];
  h.db.ImportSyncRun[0].appliedAt = new Date("2026-10-12T00:00:00Z");
  assert.equal((await h.dry()).applyReceipts, 1);
  const report = await h.apply((await h.dry()).planHash);
  assert.equal(report.deleted.ImportSyncRun, 1);
  assert.equal(Object.keys(report.deleted).length, 3);
});
