import test from "node:test";
import assert from "node:assert/strict";
import { cleanup, parseArgs, EXTERNAL_ID, FEED_URL, CONFIRM } from "../scripts/cleanup-crm-sync-new.js";
import crypto from "node:crypto";

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
    Usuario: [{ _id: U, plan: "lanzamiento_2026", publicationVersion: 1 }],
    ImportSource: [{ _id: S, usuarioId: U, feedType: "generic_xml", feedUrlHash: crypto.createHash("sha256").update(FEED_URL).digest("hex") }],
    Propiedad: [{ _id: P, usuarioId: U, importSourceId: S, source: "crm", externalId: EXTERNAL_ID,
      referencia: "", titulo: "Piso de prueba NEW CRM en Chipiona", precio: 198000,
      localidad: "Chipiona", tipoOperacion: "venta", imagenes: [], videoUrl: "" }],
    ImportSyncRun: [{ _id: "run", usuarioId: U, importSourceId: S, status: "simulated", plan: [{ externalId: EXTERNAL_ID }],
      newImport: { status: "completed", selectedExternalIds: [EXTERNAL_ID], results: [{ externalId: EXTERNAL_ID, propertyId: P }] } }],
    ImportReconciliation: [], Conversacion: [], Notificacion: [], EstadisticaAnuncio: []
  };
  let tx, writes = 0, breakDeletion = false, breakVerification = false;
  const models = Object.fromEntries(Object.keys(db).map(name => [name, {
    find(filter) {
      let session;
      return { select() { return this; }, session(v) { session = v; return this; },
        async lean() {
          const records = (session ? tx : db)[name];
          if (session && breakVerification && name === "ImportSource" && !records.length) return structuredClone(db.ImportSource);
          return structuredClone(records.filter(v => matches(v, filter)));
        } };
    },
    async updateOne(filter, op, { session }) {
      assert.ok(session); writes++;
      const record = tx[name].find(v => matches(v, filter));
      if (!record) return { matchedCount: 0 };
      Object.assign(record, op.$set); return { matchedCount: 1 };
    },
    async deleteMany(filter, { session }) {
      assert.ok(session); writes++;
      const before = tx[name].length;
      if (!breakDeletion) tx[name] = tx[name].filter(v => !matches(v, filter));
      return { deletedCount: before - tx[name].length };
    }
  }]));
  const deps = { models, startSession: async () => ({
    async withTransaction(fn) { tx = structuredClone(db); try { await fn(); db = tx; } finally { tx = undefined; } },
    async endSession() {}
  }) };
  return { deps, get db() { return db; }, get writes() { return writes; },
    failDeletes() { breakDeletion = true; },
    failVerification() { breakVerification = true; },
    dry: () => cleanup(options, deps),
    apply: planHash => cleanup({ ...options, apply: true, confirm: CONFIRM, "expect-plan": planHash }, deps) };
}

test("strict CLI defaults dry-run and requires IDs plus confirmation and plan hash for apply", () => {
  assert.equal(parseArgs([`--user-id=${U}`, `--source-id=${S}`]).apply, false);
  assert.throws(() => parseArgs([`--user-id=${U}`, `--source-id=${S}`, "--apply"]));
  assert.throws(() => parseArgs([`--user-id=${U}`, `--source-id=${S}`, "--unknown=x"]));
});
test("dry-run is read-only, reports embedded receipt and no media", async () => {
  const h = harness(), before = structuredClone(h.db), r = await h.dry();
  assert.equal(r.resultado, "APTO PARA LIMPIEZA"); assert.equal(r.dryRun, true);
  assert.equal(r.imagenesAsociadas, 0); assert.equal(r.importReceipts, 1);
  assert.equal(h.writes, 0); assert.deepEqual(h.db, before);
});
test("apply preserves users/plans and unrelated properties/source/run; second apply is already clean", async () => {
  const h = harness();
  h.db.Propiedad.push({ _id: "other", usuarioId: U, externalId: "OTHER", titulo: h.db.Propiedad[0].titulo });
  h.db.ImportSource.push({ _id: "other-source", usuarioId: "other-user" });
  h.db.ImportSyncRun.push({ _id: "other-run", importSourceId: "other-source", usuarioId: "other-user" });
  const user = structuredClone(h.db.Usuario);
  const r = await h.apply((await h.dry()).planHash);
  assert.deepEqual(r.deleted, { ImportSyncRun: 1, ImportReconciliation: 0, EstadisticaAnuncio: 0, Propiedad: 1, ImportSource: 1 });
  assert.equal(r.verificacionPosterior, true);
  assert.deepEqual(h.db.Usuario, user);
  assert.equal(h.db.Propiedad[0].externalId, "OTHER"); assert.equal(h.db.ImportSource[0]._id, "other-source");
  assert.equal(h.db.ImportSyncRun[0]._id, "other-run");
  const writes = h.writes;
  assert.equal((await h.apply(r.planHash)).resultado, "YA LIMPIO"); assert.equal(h.writes, writes);
});
const mutations = {
  "wrong owner": db => { db.Propiedad[0].usuarioId = "other"; },
  "wrong source": db => { db.Propiedad[0].importSourceId = "other"; },
  "wrong URL": db => { db.ImportSource[0].feedUrlHash = "bad"; },
  "wrong price": db => { db.Propiedad[0].precio = 1; },
  "wrong title": db => { db.Propiedad[0].titulo = "Otra propiedad"; },
  "wrong locality": db => { db.Propiedad[0].localidad = "Rota"; },
  "wrong source owner": db => { db.ImportSource[0].usuarioId = "other"; },
  "wrong reference": db => { db.Propiedad[0].referencia = EXTERNAL_ID; },
  "wrong externalId": db => { db.Propiedad[0].externalId = "other"; },
  "duplicate externalId": db => { db.Propiedad.push({ ...db.Propiedad[0], _id: "duplicate" }); },
  "other source property": db => { db.Propiedad.push({ ...db.Propiedad[0], _id: "other", externalId: "OTHER" }); },
  "shared run": db => { db.ImportSyncRun[0].plan.push({ externalId: "OTHER" }); },
  "foreign run": db => { db.ImportSyncRun[0].usuarioId = "other"; },
  "live lock": db => { db.ImportSource[0].importLockToken = "locked"; },
  "images": db => { db.Propiedad[0].imagenes = ["placeholder-is-still-persisted-media"]; },
  "conversation": db => { db.Conversacion.push({ _id: "chat", propiedadId: P }); },
  "notification": db => { db.Notificacion.push({ _id: "notice", propiedadId: P }); },
  "favorite": db => { db.Usuario.push({ _id: "someone", favoritos: [P] }); },
  "unconfirmed receipt": db => { db.ImportSyncRun[0].newImport.status = "indeterminate"; },
  "pending reconciliation": db => { db.ImportReconciliation.push({ _id: "rec", propiedadId: P, usuarioId: U,
    importSourceId: S, externalId: EXTERNAL_ID, source: "crm", state: "unknown", publicIds: [] }); }
};
for (const [name, mutate] of Object.entries(mutations)) test(`${name} aborts without changes`, async () => {
  const h = harness(), plan = (await h.dry()).planHash;
  mutate(h.db); const before = structuredClone(h.db);
  assert.equal((await h.dry()).resultado, "NO APTO PARA LIMPIEZA");
  await assert.rejects(() => h.apply(plan));
  assert.deepEqual(h.db, before); assert.equal(h.writes, 0);
});
test("safe prepared empty reconciliation and own statistics are removed exclusively", async () => {
  const h = harness();
  h.db.ImportReconciliation.push({ _id: "rec", propiedadId: P, usuarioId: U, importSourceId: S,
    externalId: EXTERNAL_ID, source: "crm", state: "prepared", publicIds: [] });
  h.db.EstadisticaAnuncio.push({ _id: "stat", propiedadId: P, usuarioId: U });
  const r = await h.apply((await h.dry()).planHash);
  assert.equal(r.deleted.ImportReconciliation, 1); assert.equal(r.deleted.EstadisticaAnuncio, 1);
});
test("changed manifest aborts and transaction failures rollback", async () => {
  const h = harness(), plan = (await h.dry()).planHash;
  h.db.ImportSyncRun[0].updatedAt = new Date();
  await assert.rejects(() => h.apply(plan), { code: "PLAN_CHANGED" });
  const fresh = (await h.dry()).planHash, before = structuredClone(h.db);
  h.failDeletes(); await assert.rejects(() => h.apply(fresh), { code: "DELETE_COUNT_MISMATCH" });
  assert.deepEqual(h.db, before);
});
test("script contains no Cloudinary calls nor deletion of conversations/notifications/users", async () => {
  const { readFileSync } = await import("node:fs");
  const code = readFileSync(new URL("../scripts/cleanup-crm-sync-new.js", import.meta.url), "utf8");
  assert.doesNotMatch(code, /cloudinary|uploadBuffer|destroy\(/i);
  assert.doesNotMatch(code, /models\.(Usuario|Conversacion|Notificacion)\.(delete|update)/);
});
test("failed post-verification rolls back all deletions", async () => {
  const h = harness(), plan = (await h.dry()).planHash, before = structuredClone(h.db);
  h.failVerification();
  await assert.rejects(() => h.apply(plan), { code: "POST_VERIFICATION_FAILED" });
  assert.deepEqual(h.db, before);
});
