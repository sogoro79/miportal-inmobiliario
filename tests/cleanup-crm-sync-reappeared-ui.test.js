import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { cleanup, parseArgs, TARGET, CONTROL, ALLOWED_EXTERNAL_IDS, FEED_URL, CONFIRM } from "../scripts/cleanup-crm-sync-reappeared-ui.js";

const U = "000000000000000000000001", S = "000000000000000000000002", P = "000000000000000000000003";
const R = [4, 5, 6, 7].map(n => String(n).padStart(24, "0"));
const H = value => crypto.createHash("sha256").update(value).digest("hex");
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
  const run = (i, type, control = false) => ({ _id: R[i], usuarioId: U, importSourceId: S, mode: "simulation",
    status: "simulated", sourceIdentityHash: H(FEED_URL), snapshotComplete: true, totalResults: control ? 2 : 1,
    plan: [{ externalId: TARGET, type, propiedadId: P }, ...(control ? [{ externalId: CONTROL, type: "NEW" }] : [])] });
  let db = { Usuario: [{ _id: U, nombre: "Cuenta de prueba", email: "test@example.invalid", plan: "lanzamiento_2026" }],
    Propiedad: [], ImportSource: [{ _id: S, usuarioId: U, feedType: "generic_xml", feedUrlHash: H(FEED_URL),
      encryptedFeedUrl: "private-ciphertext", activo: true }],
    ImportSyncRun: [run(0, "CONFLICT"), run(1, "UNCHANGED"), run(2, "MISSING", true), run(3, "REAPPEARED", true)],
    ImportReconciliation: [] };
  db.ImportSyncRun[2].missingHide = { status: "completed", operationId: "hide-operation",
    selectedExternalIds: [TARGET], results: [{ externalId: TARGET, status: "hidden" }], countHidden: 1, countAlreadyHidden: 0,
    startedAt: new Date("2026-10-14T10:00:00Z"), completedAt: new Date("2026-10-14T10:00:01Z") };
  db.ImportSyncRun[3].reappearedRestore = { status: "completed", operationId: "restore-operation",
    selectionHash: H(JSON.stringify([TARGET])), selectedExternalIds: [TARGET], results: [{ externalId: TARGET, status: "restored" }],
    countRestored: 1, countAlreadyRestored: 0, startedAt: new Date("2026-10-14T10:10:00Z"), completedAt: new Date("2026-10-14T10:10:01Z") };
  db.ImportSyncRun[3].plan[0].restoreEvidence = { propiedadId: P, usuarioId: U, importSourceId: S, externalId: TARGET,
    causalRunId: R[2], expectedHiddenByMissingRunId: R[2] };
  let tx, writes = 0, sessions = 0, failedDelete = false, failPost = false, failAfter = false, changeBeforeTx;
  const reads = [];
  const models = Object.fromEntries(Object.keys(db).map(name => [name, {
    find(filter) {
      const tracked = { name, filter }; reads.push(tracked); let session;
      return { select(v) { tracked.select = v; return this; }, session(v) { session = v; return this; }, setOptions() { return this; },
        async lean() {
          if (name === "Propiedad" && (session && failPost && !tx.ImportSource.length || !session && failAfter && !db.ImportSource.length))
            return [{ _id: P, externalId: TARGET }];
          return structuredClone((session ? tx : db)[name].filter(row => matches(row, filter)));
        } };
    },
    async updateOne(filter, operation, { session }) {
      assert.equal(name, "ImportSource"); assert.ok(session); writes++;
      const row = tx[name].find(row => matches(row, filter));
      if (!row) return { matchedCount: 0 };
      Object.assign(row, operation.$set); return { matchedCount: 1 };
    },
    async deleteMany(filter, { session }) {
      assert.ok(["ImportSource", "ImportSyncRun", "ImportReconciliation"].includes(name)); assert.ok(session); writes++;
      const before = tx[name].length;
      if (!failedDelete) tx[name] = tx[name].filter(row => !matches(row, filter));
      return { deletedCount: before - tx[name].length };
    }
  }]));
  for (const name of ["Conversacion", "Mensaje", "Notificacion", "EstadisticaAnuncio", "Favorito", "Suscripcion"])
    models[name] = new Proxy({}, { get() { assert.fail(`Forbidden access ${name}`); } });
  const deps = { models, startSession: async () => {
    sessions++; changeBeforeTx?.(db);
    return { async withTransaction(fn, config) {
      assert.deepEqual(config, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
      tx = structuredClone(db); try { await fn(); db = tx; } finally { tx = undefined; }
    }, async endSession() {} };
  } };
  return { deps, reads, get db() { return db; }, get writes() { return writes; }, get sessions() { return sessions; },
    failDelete() { failedDelete = true; }, failPost() { failPost = true; }, failAfter() { failAfter = true; },
    beforeTx(fn) { changeBeforeTx = fn; }, dry: () => cleanup(options, deps),
    apply: plan => cleanup({ ...options, apply: true, confirm: CONFIRM, "expect-plan": plan }, deps) };
}

test("CLI requires IDs and all apply confirmations; default is dry-run", () => {
  assert.equal(parseArgs([`--user-id=${U}`, `--source-id=${S}`]).apply, false);
  for (const extra of [["--apply"], ["--apply", `--confirm=${CONFIRM}`], ["--apply", "--confirm=wrong", `--expect-plan=${"a".repeat(64)}`],
    ["--email=test@example.invalid"], ["--user-id=wrong"], ["--apply", "--apply"]])
    assert.throws(() => parseArgs([`--user-id=${U}`, `--source-id=${S}`, ...extra]));
});
test("dry-run validates both causal receipts with no writes, sessions or private output", async () => {
  const h = harness(), before = structuredClone(h.db), report = await h.dry();
  assert.equal(report.resultado, "APTO PARA LIMPIEZA");
  assert.equal(report.missingHideCompletedValido, true); assert.equal(report.reappearedRestoreCompletedValido, true);
  assert.equal(report.importSyncRuns, 4); assert.equal(report.propiedadTargetEncontrada, false); assert.equal(report.propiedadControlEncontrada, false);
  assert.equal(report.otrasPropiedadesAfectadas, 0); assert.equal(report.referenciasExternas, 0);
  assert.deepEqual(report.allowedExternalIds, ALLOWED_EXTERNAL_IDS); assert.equal(report.dryRun, true);
  assert.doesNotMatch(JSON.stringify(report), /private-ciphertext|selectionHash|restoreEvidence|operationId/);
  assert.deepEqual(h.db, before); assert.equal(h.writes, 0); assert.equal(h.sessions, 0);
});
const mutations = {
  "wrong source owner": db => { db.ImportSource[0].usuarioId = "other"; },
  "wrong source ID": db => { db.ImportSource[0]._id = R[0]; },
  "wrong URL hash": db => { db.ImportSource[0].feedUrlHash = H("https://example.invalid/"); },
  "wrong type": db => { db.ImportSource[0].feedType = "other"; },
  "missing user": db => { db.Usuario = []; },
  "target property exists": db => db.Propiedad.push({ _id: P, externalId: TARGET }),
  "control property exists": db => db.Propiedad.push({ _id: P, externalId: CONTROL }),
  "other property uses source": db => db.Propiedad.push({ _id: P, importSourceId: S, externalId: "OTHER" }),
  "historic property reassigned": db => db.Propiedad.push({ _id: P, usuarioId: "other", externalId: "OTHER" }),
  "inverse hidden marker": db => db.Propiedad.push({ _id: R[0], hiddenByMissingRunId: R[2], externalId: "OTHER" }),
  "inverse lastSeen marker": db => db.Propiedad.push({ _id: R[0], lastSeenRunId: R[3], externalId: "OTHER" }),
  "external ID outside whitelist": db => db.ImportSyncRun[0].plan.push({ externalId: "OTHER" }),
  "run owner changed": db => { db.ImportSyncRun[0].usuarioId = "other"; },
  "run source changed": db => { db.ImportSyncRun[0].importSourceId = R[0]; },
  "run hash changed": db => { db.ImportSyncRun[0].sourceIdentityHash = "bad"; },
  "run incomplete": db => { db.ImportSyncRun[0].snapshotComplete = false; },
  "run truncated": db => { db.ImportSyncRun[0].planTruncated = true; },
  "unexpected UPDATE": db => { db.ImportSyncRun[0].selectedExternalIds = [TARGET]; db.ImportSyncRun[0].appliedAt = new Date(); },
  "unexpected NEW control": db => { db.ImportSyncRun[0].newImport = { status: "completed", selectedExternalIds: [CONTROL], results: [{ externalId: CONTROL }] }; },
  "unexpected NEW target": db => { db.ImportSyncRun[0].newImport = { status: "completed", selectedExternalIds: [TARGET], results: [{ externalId: TARGET }] }; },
  "missing hide receipt absent": db => { delete db.ImportSyncRun[2].missingHide; },
  "restore receipt absent": db => { delete db.ImportSyncRun[3].reappearedRestore; },
  "missing hide count wrong": db => { db.ImportSyncRun[2].missingHide.countHidden = 2; },
  "restore count wrong": db => { db.ImportSyncRun[3].reappearedRestore.countRestored = 2; },
  "already hidden": db => { db.ImportSyncRun[2].missingHide.countAlreadyHidden = 1; },
  "already restored": db => { db.ImportSyncRun[3].reappearedRestore.results[0].status = "already_restored"; },
  "CONTROL in hide selection": db => { db.ImportSyncRun[2].missingHide.selectedExternalIds = [CONTROL]; },
  "CONTROL in restore result": db => { db.ImportSyncRun[3].reappearedRestore.results[0].externalId = CONTROL; },
  "restore duplicate selection": db => db.ImportSyncRun[3].reappearedRestore.selectedExternalIds.push(TARGET),
  "missing duplicate result": db => db.ImportSyncRun[2].missingHide.results.push({ externalId: TARGET, status: "hidden" }),
  "restore selection hash mismatch": db => { db.ImportSyncRun[3].reappearedRestore.selectionHash = "bad"; },
  "causal run mismatch": db => { db.ImportSyncRun[3].plan[0].restoreEvidence.causalRunId = R[0]; },
  "causal owner mismatch": db => { db.ImportSyncRun[3].plan[0].restoreEvidence.usuarioId = "other"; },
  "property identity mismatch": db => { db.ImportSyncRun[3].plan[0].propiedadId = R[0]; },
  "second hide completed": db => db.ImportSyncRun.push({ ...structuredClone(db.ImportSyncRun[2]), _id: "000000000000000000000010" }),
  "second restore completed": db => db.ImportSyncRun.push({ ...structuredClone(db.ImportSyncRun[3]), _id: "000000000000000000000010" }),
  "lock token": db => { db.ImportSource[0].importLockToken = "private-lock"; },
  "null lock token requires review": db => { db.ImportSource[0].importLockToken = null; },
  "missing receipt null dates": db => { db.ImportSyncRun[2].missingHide.startedAt = null; db.ImportSyncRun[2].missingHide.completedAt = null; },
  "restore receipt null dates": db => { db.ImportSyncRun[3].reappearedRestore.startedAt = null; db.ImportSyncRun[3].reappearedRestore.completedAt = null; },
  "future lock": db => { db.ImportSource[0].importLockUntil = new Date(Date.now() + 60000); },
  "foreign reconciliation": db => db.ImportReconciliation.push({ _id: R[0], usuarioId: "other", importSourceId: S, externalId: TARGET }),
  "pending reconciliation": db => db.ImportReconciliation.push({ _id: R[0], usuarioId: U, importSourceId: S, externalId: TARGET,
    propiedadId: P, source: "crm", state: "unknown", publicIds: [] }),
  "foreign causal reference": db => db.ImportSyncRun.push({ _id: "000000000000000000000010", usuarioId: "other", importSourceId: "other",
    plan: [{ externalId: "OTHER", restoreEvidence: { causalRunId: R[2] } }] }),
  "foreign historical property ref": db => db.ImportSyncRun.push({ _id: "000000000000000000000010", usuarioId: "other", importSourceId: "other",
    plan: [{ externalId: "OTHER", propiedadId: P }] }),
  "foreign reconciliation by property": db => db.ImportReconciliation.push({ _id: R[0], usuarioId: "other", importSourceId: "other", externalId: "OTHER", propiedadId: P })
};
for (const status of ["running", "applying", "failed", "incomplete", "aborted", "indeterminate"])
  mutations[`run ${status}`] = db => { db.ImportSyncRun[0].status = status; };
for (const field of ["missingHide", "reappearedRestore"])
  for (const status of ["preparing", "applying", "indeterminate", "failed"])
    mutations[`${field} ${status}`] = db => { db.ImportSyncRun[field === "missingHide" ? 2 : 3][field].status = status; };
for (const [name, mutate] of Object.entries(mutations)) test(`${name} aborts with zero writes`, async () => {
  const h = harness(), plan = (await h.dry()).planHash; mutate(h.db); const before = structuredClone(h.db);
  assert.equal((await h.dry()).resultado, "NO APTO"); await assert.rejects(() => h.apply(plan));
  assert.deepEqual(h.db, before); assert.equal(h.writes, 0);
});
test("apply deletes only validated CRM records; second dry/apply is YA LIMPIO with zero writes", async () => {
  const h = harness();
  h.db.Propiedad.push({ _id: R[0], usuarioId: U, externalId: "OTHER" });
  h.db.ImportSource.push({ _id: R[0], usuarioId: "other", feedUrlHash: "other" });
  h.db.ImportSyncRun.push({ _id: "000000000000000000000010", usuarioId: "other", importSourceId: R[0], plan: [{ externalId: "OTHER" }] });
  h.db.ImportReconciliation.push({ _id: R[0], usuarioId: U, importSourceId: S, source: "crm", externalId: TARGET, propiedadId: P,
    state: "prepared", publicIds: [] });
  const before = structuredClone(h.db), report = await h.apply((await h.dry()).planHash);
  assert.deepEqual(report.deleted, { ImportSyncRun: 4, ImportReconciliation: 1, ImportSource: 1 });
  assert.equal(report.verificacionPosterior, true); assert.deepEqual(h.db.Usuario, before.Usuario); assert.deepEqual(h.db.Propiedad, before.Propiedad);
  assert.deepEqual(h.db.ImportSource, [before.ImportSource[1]]); assert.deepEqual(h.db.ImportSyncRun, [before.ImportSyncRun[4]]);
  const writes = h.writes; assert.equal((await h.dry()).resultado, "YA LIMPIO");
  assert.equal((await h.apply(report.planHash)).resultado, "YA LIMPIO"); assert.equal(h.writes, writes);
});
test("plan hash covers actual IDs, receipt evidence, source and reconciliation content", async () => {
  for (const mutate of [db => { db.ImportSyncRun[0]._id = "000000000000000000000010"; },
    db => { db.ImportSyncRun[3].reappearedRestore.operationId = "new-op"; },
    db => { db.ImportSource[0].encryptedFeedUrl = "changed-private-ciphertext"; },
    db => { db.Usuario[0].plan = "vip"; },
    db => db.ImportReconciliation.push({ _id: R[0], usuarioId: U, importSourceId: S, externalId: TARGET,
      propiedadId: P, source: "crm", state: "prepared", publicIds: [] })]) {
    const h = harness(), original = (await h.dry()).planHash; mutate(h.db);
    assert.notEqual((await h.dry()).planHash, original); await assert.rejects(() => h.apply(original), { code: "PLAN_CHANGED" });
    assert.equal(h.writes, 0);
  }
});
test("revalidation inside transaction catches a change after initial inspection", async () => {
  const h = harness(), plan = (await h.dry()).planHash;
  h.beforeTx(db => { db.ImportSyncRun[3].reappearedRestore.operationId = "changed"; });
  await assert.rejects(() => h.apply(plan), { code: "PLAN_CHANGED" }); assert.equal(h.writes, 0);
});
test("partial delete and failed in-transaction verification roll back all CRM writes", async () => {
  for (const kind of ["delete", "verify"]) {
    const h = harness(), plan = (await h.dry()).planHash, before = structuredClone(h.db);
    if (kind === "delete") h.failDelete(); else h.failPost();
    await assert.rejects(() => h.apply(plan), { code: kind === "delete" ? "DELETE_COUNT_MISMATCH" : "POST_VERIFICATION_FAILED" });
    assert.deepEqual(h.db, before);
  }
});
test("failed post-commit verification is explicit and never claims confirmed completion", async () => {
  const h = harness(), plan = (await h.dry()).planHash; h.failAfter();
  await assert.rejects(() => h.apply(plan), { code: "POST_VERIFICATION_FAILED" });
  assert.equal(h.db.ImportSource.length, 0);
});
test("historical IDs and defensive projections remain in post-check queries", async () => {
  const h = harness(); await h.apply((await h.dry()).planHash);
  assert.ok(h.reads.some(r => r.name === "Propiedad" && r.select.includes("+hiddenByMissingRunId") &&
    r.filter.$or.some(f => f.hiddenByMissingRunId?.$in?.includes(R[2]))));
  assert.ok(h.reads.some(r => r.name === "Propiedad" && r.filter.$or.some(f => f.lastSeenRunId?.$in?.includes(R[3]))));
  assert.ok(h.reads.some(r => r.name === "ImportSyncRun" && r.filter._id?.$in?.includes(R[3])));
});
test("canonical plan hash is deterministic despite object key ordering", async () => {
  const h = harness(), plan = (await h.dry()).planHash;
  h.db.ImportSource[0] = Object.fromEntries(Object.entries(h.db.ImportSource[0]).reverse());
  assert.equal((await h.dry()).planHash, plan);
});
test("foreign raw references and invalid statuses are not printed", async () => {
  const h = harness();
  h.db.ImportSyncRun[0].plan.push({ externalId: "https://private.example/feed?token=secret-token" });
  h.db.ImportSyncRun[0].status = "secret-status";
  const report = await h.dry();
  assert.equal(report.resultado, "NO APTO");
  assert.doesNotMatch(JSON.stringify(report), /secret-token|private.example|secret-status/);
});
test("script has no property/user writes, forbidden services or index/collection creation", () => {
  const code = fs.readFileSync(new URL("../scripts/cleanup-crm-sync-reappeared-ui.js", import.meta.url), "utf8");
  assert.doesNotMatch(code, /models\.(?:Propiedad|Usuario)\.(?:delete|update|save)|createIndexes|createCollection|cloudinary|fetch\(/i);
  assert.match(code, /autoIndex: false, autoCreate: false/);
});
