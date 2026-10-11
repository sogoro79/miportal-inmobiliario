import test from "node:test";
import assert from "node:assert/strict";
import { cleanup, parseArgs, EXPECTED_URL, EXTERNAL_ID, CONFIRMATION } from "../scripts/cleanup-crm-sync-apply.js";
import { encryptFeedUrl } from "../utils/import/feedUrlCrypto.js";

const env = { CRM_FEED_URL_KEY_V1: Buffer.alloc(32, 7).toString("base64") };
function values(doc, path) {
  if (!path.length) return [doc];
  if (Array.isArray(doc)) return doc.flatMap(item => values(item, path));
  return values(doc?.[path[0]], path.slice(1));
}
function match(doc, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return expected.some(f => match(doc, f));
    if (key === "$and") return expected.every(f => match(doc, f));
    const actual = values(doc, key.split("."));
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      return Object.entries(expected).every(([op, value]) => {
        if (op === "$ne") return !actual.some(v => v === value);
        if (op === "$exists") return actual.some(v => v !== undefined) === value;
        if (op === "$lte") return actual.some(v => v <= value);
        if (op === "$in") return actual.some(v => value.includes(v));
        throw new Error(`Unsupported ${op}`);
      });
    }
    return actual.some(v => v === expected || (Array.isArray(v) && v.includes(expected)) || (expected === null && v === undefined));
  });
}
function fixture() {
  let data = {
    Usuario: [{ _id: "u", nombre: "Alberto", plan: "lanzamiento_2026", favoritos: [] }],
    ImportSource: [{ _id: "s", usuarioId: "u", feedType: "generic_xml", activo: true, ...encryptFeedUrl(EXPECTED_URL, env) }],
    Propiedad: [{ _id: "p", usuarioId: "u", importSourceId: "s", source: "crm", externalId: EXTERNAL_ID,
      referencia: EXTERNAL_ID, imagenes: [], videoUrl: "", precio: 225000 }],
    ImportSyncRun: [{ _id: "r", usuarioId: "u", importSourceId: "s", status: "applied" }],
    ImportReconciliation: [], Conversacion: [], Notificacion: [], EstadisticaAnuncio: []
  };
  const writes = [];
  const faults = {};
  const db = Object.fromEntries(Object.keys(data).map(name => [name, {
    async findOne(filter) { return structuredClone(data[name].find(d => match(d, filter)) || null); },
    find(filter) { return { async toArray() { return structuredClone(data[name].filter(d => match(d, filter))); } }; },
    async countDocuments(filter, options) {
      if (faults.verify && name === "Propiedad" && options?.session && filter.$or) return 1;
      if (faults.postCommit && name === "Propiedad" && !options?.session && filter.$or) return 1;
      return data[name].filter(d => match(d, filter)).length;
    },
    async updateOne(filter, update) {
      writes.push([name, "update"]);
      const d = data[name].find(d => match(d, filter));
      if (!d) return { matchedCount: 0 };
      Object.assign(d, update.$set);
      return { matchedCount: 1 };
    },
    async deleteOne(filter) {
      writes.push([name, "delete"]);
      if (faults.delete && name === "ImportSource") throw new Error("simulated failure");
      const i = data[name].findIndex(d => match(d, filter));
      if (i < 0) return { deletedCount: 0 };
      data[name].splice(i, 1);
      return { deletedCount: 1 };
    },
    async deleteMany(filter) {
      writes.push([name, "deleteMany"]);
      const count = data[name].filter(d => match(d, filter)).length;
      data[name] = data[name].filter(d => !match(d, filter));
      return { deletedCount: count };
    }
  }]));
  const client = { async startSession() { return {
    async withTransaction(fn) {
      const before = structuredClone(data);
      try { if (faults.beforeTransaction) faults.beforeTransaction(data); await fn(); }
      catch (e) { data = before; throw e; }
    }, async endSession() {}
  }; } };
  return { db, client, env, userId: "u", sourceId: "s", writes, faults, get data() { return data; } };
}
test("dry-run validates identity, counts, and never writes", async () => {
  const f = fixture();
  const result = await cleanup(f);
  assert.equal(result.resultado, "APTO PARA LIMPIEZA");
  assert.equal(result.importSyncRuns, 1);
  assert.equal(result.importReconciliations, 0);
  assert.equal(result.plan, "lanzamiento_2026");
  assert.deepEqual(f.writes, []);
});
for (const [name, change, code] of [
  ["user missing", d => { d.Usuario = []; }, "USER_NOT_FOUND"],
  ["source owner", d => { d.ImportSource[0].usuarioId = "other"; }, "SOURCE_IDENTITY_MISMATCH"],
  ["source hash", d => { d.ImportSource[0].feedUrlHash = "wrong"; }, "SOURCE_IDENTITY_MISMATCH"],
  ["encrypted URL", d => { d.ImportSource[0].encryptedFeedUrl = "bad"; }, "SYNC_SOURCE_NOT_CONFIGURED"],
  ["property owner", d => { d.Propiedad[0].usuarioId = "other"; }, "PROPERTY_IDENTITY_MISMATCH"],
  ["externalId", d => { d.Propiedad[0].externalId = "other"; }, "PROPERTY_IDENTITY_MISMATCH"],
  ["non CRM", d => { d.Propiedad[0].source = "manual"; }, "PROPERTY_IDENTITY_MISMATCH"],
  ["missing property", d => { d.Propiedad = []; }, "EXACTLY_ONE_SOURCE_PROPERTY_REQUIRED"],
  ["extra property", d => { d.Propiedad.push({ _id: "other", importSourceId: "s" }); }, "EXACTLY_ONE_SOURCE_PROPERTY_REQUIRED"],
  ["images", d => { d.Propiedad[0].imagenes = ["image"]; }, "MEDIA_PRESENT"],
  ["video", d => { d.Propiedad[0].videoUrl = "video"; }, "MEDIA_PRESENT"],
  ["reconciliation", d => { d.ImportReconciliation.push({ propiedadId: "p", state: "unknown" }); }, "RECONCILIATION_PRESENT"],
  ["lock", d => { d.ImportSource[0].importLockToken = "busy"; }, "SOURCE_LOCK_PRESENT"],
  ["lease", d => { d.ImportSource[0].importLockUntil = new Date(Date.now() + 60000); }, "SOURCE_BUSY"],
  ["running", d => { d.ImportSyncRun[0].status = "running"; }, "RUN_ACTIVE"],
  ["foreign run", d => { d.ImportSyncRun[0].usuarioId = "other"; }, "RUN_OWNER_MISMATCH"],
  ["chat", d => { d.Conversacion.push({ propiedadId: "p" }); }, "EXTERNAL_REFERENCES_PRESENT"],
  ["notification", d => { d.Notificacion.push({ propiedadId: "p" }); }, "EXTERNAL_REFERENCES_PRESENT"],
  ["statistics", d => { d.EstadisticaAnuncio.push({ propiedadId: "p" }); }, "EXTERNAL_REFERENCES_PRESENT"],
  ["favorites", d => { d.Usuario[0].favoritos = ["p"]; }, "EXTERNAL_REFERENCES_PRESENT"],
  ["external run", d => { d.ImportSyncRun.push({ importSourceId: "other", plan: [{ propiedadId: "p" }] }); }, "EXTERNAL_REFERENCES_PRESENT"],
  ["external property", d => { d.Propiedad.push({ _id: "other", importSourceId: "other", lastSeenRunId: "r" }); }, "EXTERNAL_REFERENCES_PRESENT"]
]) test(`abort: ${name}`, async () => {
  const f = fixture(); change(f.data);
  await assert.rejects(cleanup(f), e => e.code === code);
  assert.deepEqual(f.writes, []);
});
test("apply deletes only target/source/runs and preserves user and unrelated data", async () => {
  const f = fixture();
  f.data.Propiedad.push({ _id: "other", importSourceId: "other" });
  f.data.ImportSource.push({ _id: "other", usuarioId: "other" });
  const user = structuredClone(f.data.Usuario);
  const result = await cleanup({ ...f, apply: true, confirm: CONFIRMATION });
  assert.equal(result.resultado, "LIMPIEZA CONFIRMADA");
  assert.deepEqual(f.data.Usuario, user);
  assert.deepEqual(f.data.Propiedad, [{ _id: "other", importSourceId: "other" }]);
  assert.equal(f.data.ImportSource[0]._id, "other");
  assert.equal(f.data.ImportSyncRun.length, 0);
  assert.ok(!f.writes.some(([name]) => name === "Usuario" || name === "ImportReconciliation"));
});
for (const fault of ["delete", "verify"]) test(`transaction rolls back on ${fault} failure`, async () => {
  const f = fixture(); const before = structuredClone(f.data); f.faults[fault] = true;
  await assert.rejects(cleanup({ ...f, apply: true, confirm: CONFIRMATION }));
  assert.deepEqual(f.data, before);
});
test("revalidation rejects concurrent property added after dry-run", async () => {
  const f = fixture();
  f.faults.beforeTransaction = d => d.Propiedad.push({ _id: "new", importSourceId: "s" });
  await assert.rejects(cleanup({ ...f, apply: true, confirm: CONFIRMATION }), e => e.code === "EXACTLY_ONE_SOURCE_PROPERTY_REQUIRED");
  assert.ok(!f.writes.some(([, action]) => action.startsWith("delete")));
});
test("post-commit verification failure does not report success or retry deletes", async () => {
  const f = fixture(); f.faults.postCommit = true;
  await assert.rejects(cleanup({ ...f, apply: true, confirm: CONFIRMATION }), e => e.code === "POST_VERIFICATION_FAILED");
  assert.equal(f.writes.filter(([name, action]) => name === "Propiedad" && action === "delete").length, 1);
  assert.equal(f.data.Propiedad.length, 0);
});
test("concurrent CRM lock prevents deletion", async () => {
  const f = fixture();
  f.faults.beforeTransaction = d => { d.ImportSource[0].importLockToken = "another-operation"; };
  await assert.rejects(cleanup({ ...f, apply: true, confirm: CONFIRMATION }), e => e.code === "SOURCE_BUSY");
  assert.ok(!f.writes.some(([, action]) => action.startsWith("delete")));
});
test("confirmation and strict CLI identifiers required", async () => {
  const f = fixture();
  await assert.rejects(cleanup({ ...f, apply: true }), e => e.code === "CONFIRMATION_REQUIRED");
  assert.deepEqual(f.writes, []);
  assert.throws(() => parseArgs([]));
  assert.throws(() => parseArgs(["--user-id=bad", "--source-id=bad"]));
  const ids = ["--user-id=aaaaaaaaaaaaaaaaaaaaaaaa", "--source-id=bbbbbbbbbbbbbbbbbbbbbbbb"];
  assert.equal(parseArgs(ids).apply, false);
  assert.throws(() => parseArgs([...ids, "--apply"]));
  assert.equal(parseArgs([...ids, "--apply", `--confirm=${CONFIRMATION}`]).apply, true);
  assert.throws(() => parseArgs([...ids, "--unexpected"]));
});
