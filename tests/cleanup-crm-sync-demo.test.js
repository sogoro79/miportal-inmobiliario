import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import mongoose from "mongoose";
import { encryptFeedUrl } from "../utils/import/feedUrlCrypto.js";
import { cleanupCrmSyncDemo, parseCleanupArgs, runCleanupCli, DEMO_IDS, CONFIRMATION, COLLECTIONS as C } from "../scripts/cleanup-crm-sync-demo.js";

const oid = n => new mongoose.Types.ObjectId(n.toString(16).padStart(24, "0"));
const U = oid(1), S = oid(2), OTHER = oid(3);
const FEED_URL = "https://www.homeclick24.com/test-sync/original.xml?token=do-not-print";
const options = { userId: String(U), sourceId: String(S), expectedFeedUrl: FEED_URL };
const args = [`--user-id=${U}`, `--source-id=${S}`, `--expected-feed-url=${FEED_URL}`];
const hash = crypto.createHash("sha256").update(FEED_URL).digest("hex");
const equal = (a, b) => a?.toHexString || b?.toHexString ? String(a) === String(b) : a instanceof Date && b instanceof Date ? +a === +b : a === b;
function matches(doc, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === "$or") return value.some(part => matches(doc, part));
    if (key === "$and") return value.every(part => matches(doc, part));
    const actual = doc[key];
    if (value && typeof value === "object" && !value.toHexString && !(value instanceof Date)) {
      return Object.entries(value).every(([op, target]) => {
        if (op === "$in") return target.some(item => equal(actual, item));
        if (op === "$exists") return (actual !== undefined) === target;
        if (op === "$lte") return actual != null && actual <= target;
        throw new Error(`Unsupported mock operator: ${op}`);
      });
    }
    return value === null ? actual == null : equal(actual, value);
  });
}
function harness() {
  const data = {
    [C.users]: [{ _id: U, plan: "lanzamiento_2026", favoritos: [], email: "personal-not-output", planActivo: true }, { _id: OTHER, plan: "vip", favoritos: [] }],
    [C.sources]: [{ _id: S, usuarioId: U, activo: true, feedType: "generic_xml", feedUrlHash: hash,
      encryptedFeedUrl: "never-output-ciphertext", feedUrlMasked: "never-output-url", feedUrlKeyVersion: "1", syncEnabled: false }],
    [C.properties]: DEMO_IDS.map((externalId, index) => ({ _id: oid(10 + index), usuarioId: U, importSourceId: S, source: "crm", externalId, imagenes: [],
      descripcion: index === 2 ? "Edited manually" : "Original", syncOverrides: index === 2 ? { descripcion: true } : {}, contentRevision: index === 2 ? 1 : 0 })),
    [C.runs]: [{ _id: oid(20), usuarioId: U, importSourceId: S, status: "completed", updatedAt: new Date("2026-10-01") }],
    [C.reconciliations]: [], conversacions: [], mensajes: [], notificacions: [], estadisticaanuncios: []
  };
  // Keep BSON identity/date types in snapshots without a database connection.
  function copy(value) {
    if (value?.toHexString) return new mongoose.Types.ObjectId(String(value));
    if (value instanceof Date) return new Date(value);
    if (Array.isArray(value)) return value.map(copy);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copy(v)]));
    return value;
  }
  const writes = [];
  const reads = [];
  let transaction;
  let beforeTransaction = () => {};
  let afterCommit = () => {};
  let mismatchDelete = false;
  let retries = 1;
  const state = session => session && transaction ? transaction : data;
  const db = {
    listCollections: () => ({ toArray: async () => Object.keys(data).map(name => ({ name, type: "collection" })) }),
    collection(name) {
      return {
        find(filter, settings = {}) {
          reads.push({ name, filter, settings });
          let limit = Infinity;
          const rows = () => (state(settings.session)[name] || []).filter(doc => matches(doc, filter)).slice(0, limit).map(doc => {
            if (!settings.projection) return copy(doc);
            return Object.fromEntries(Object.entries(doc).filter(([key]) => key === "_id" || settings.projection[key]).map(([key, value]) => [key, copy(value)]));
          });
          return { limit(n) { limit = n; return this; }, toArray: async () => rows(), close: async () => {},
            async *[Symbol.asyncIterator]() { yield* rows(); } };
        },
        async updateOne(filter, update, settings) {
          writes.push({ operation: "update", name, filter, settings });
          const doc = (state(settings.session)[name] || []).find(doc => matches(doc, filter));
          if (!doc) return { matchedCount: 0 };
          Object.assign(doc, update.$set);
          return { matchedCount: 1 };
        },
        async deleteMany(filter, settings) { return remove(filter, settings, false); },
        async deleteOne(filter, settings) { return remove(filter, settings, true); }
      };
      function remove(filter, settings, one) {
        writes.push({ operation: "delete", name, filter, settings });
        const current = state(settings.session);
        let removed = 0;
        current[name] = (current[name] || []).filter(doc => {
          if (matches(doc, filter) && (!one || removed === 0)) { removed++; return false; }
          return true;
        });
        return { deletedCount: mismatchDelete ? 0 : removed };
      }
    }
  };
  const client = { startSession() {
    const session = { async withTransaction(callback, settings) {
      assert.equal(settings.readConcern.level, "snapshot");
      assert.equal(settings.writeConcern.w, "majority");
      beforeTransaction();
      try {
        for (let i = 0; i < retries; i++) { transaction = copy(data); await callback(); }
        for (const key of Object.keys(data)) delete data[key];
        Object.assign(data, transaction);
        afterCommit();
      } finally { transaction = undefined; }
    }, async endSession() { h.ended = true; } };
    return session;
  } };
  const h = { data, db, client, writes, reads, copy, ended: false,
    before(fn) { beforeTransaction = fn; }, after(fn) { afterCommit = fn; },
    mismatch() { mismatchDelete = true; }, retry() { retries = 2; },
    run(overrides = {}) { return cleanupCrmSyncDemo({ db, client, options: { ...options, ...overrides } }); } };
  return h;
}
const apply = { apply: true, confirm: CONFIRMATION };

test("dry-run validates exactly four demo properties without any writes or sensitive output", async () => {
  const h = harness();
  const before = h.copy(h.data);
  const result = await h.run();
  assert.equal(result.mode, "DRY RUN");
  assert.equal(result.targetProperties, 4);
  assert.equal(result.syncRuns, 1);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.data, before);
  const output = JSON.stringify(result);
  for (const secret of [FEED_URL, "never-output", "personal-not-output", "encryptedFeedUrl", hash]) assert.ok(!output.includes(secret));
  assert.ok(h.reads.filter(r => r.name === C.users).every(r => r.settings.projection));
});

for (const [name, argv, code] of [
  ["missing user", args.slice(1), "USER_ID_REQUIRED"],
  ["missing source", [args[0], args[2]], "SOURCE_ID_REQUIRED"],
  ["missing URL", args.slice(0, 2), "EXPECTED_FEED_URL_REQUIRED"],
  ["invalid user", ["--user-id=no", ...args.slice(1)], "USER_ID_REQUIRED"],
  ["unknown option", [...args, "--force"], "INVALID_ARGUMENTS"],
  ["duplicate option", [...args, args[0]], "INVALID_ARGUMENTS"],
  ["credential URL", [args[0], args[1], "--expected-feed-url=https://secret:password@example.com/a"], "EXPECTED_FEED_URL_INVALID"]
]) test(name, () => assert.throws(() => parseCleanupArgs(argv), { code }));

const badCases = [
  ["wrong hash", h => h.data[C.sources][0].feedUrlHash = "wrong"],
  ["three properties", h => h.data[C.properties].pop()],
  ["five properties", h => h.data[C.properties].push({ ...h.data[C.properties][0], _id: oid(15), externalId: "EXTRA" })],
  ["duplicate externalId", h => h.data[C.properties][1].externalId = DEMO_IDS[0]],
  ["DEMO-005", h => h.data[C.properties].push({ ...h.data[C.properties][0], _id: oid(15), externalId: "SYNC-DEMO-005" })],
  ["DEMO-005 on other source", h => h.data[C.properties].push({ ...h.data[C.properties][0], _id: oid(15), importSourceId: oid(99), externalId: "SYNC-DEMO-005" })],
  ["foreign owner", h => h.data[C.properties][0].usuarioId = OTHER],
  ["non CRM", h => h.data[C.properties][0].source = "manual"],
  ["images", h => h.data[C.properties][0].imagenes.push("https://example.com/image.png")],
  ["unknown images", h => delete h.data[C.properties][0].imagenes],
  ["reconciliation property", h => h.data[C.reconciliations].push({ _id: oid(30), propiedadId: h.data[C.properties][0]._id })],
  ["reconciliation source", h => h.data[C.reconciliations].push({ _id: oid(30), importSourceId: S })],
  ["reconciliation string ID", h => h.data[C.reconciliations].push({ _id: oid(30), propiedadId: String(oid(10)) })],
  ["favorites", h => h.data[C.users][1].favoritos.push(h.data[C.properties][0]._id)],
  ["conversation", h => h.data.conversacions.push({ _id: oid(30), propiedadId: h.data[C.properties][0]._id, texto: "private" })],
  ["message legacy reference", h => h.data.mensajes.push({ _id: oid(30), propertyId: h.data[C.properties][0]._id })],
  ["notification", h => h.data.notificacions.push({ _id: oid(30), propiedadId: h.data[C.properties][0]._id })],
  ["daily stats", h => h.data.estadisticaanuncios.push({ _id: oid(30), propiedadId: h.data[C.properties][0]._id })],
  ["unknown nested collection", h => h.data.extra = [{ _id: oid(30), nested: { propertyId: String(h.data[C.properties][0]._id) } }]],
  ["live lock", h => Object.assign(h.data[C.sources][0], { importLockToken: "import", importLockUntil: new Date(Date.now() + 60000) })],
  ["stale lock token", h => h.data[C.sources][0].importLockToken = "old"],
  ["running source", h => h.data[C.sources][0].lastSyncStatus = "running"],
  ["running run", h => h.data[C.runs][0].status = "running"],
  ["foreign run", h => h.data[C.runs][0].usuarioId = OTHER],
  ["foreign source", h => h.data[C.sources][0].usuarioId = OTHER],
  ["second source", h => h.data[C.sources].push({ ...h.data[C.sources][0], _id: oid(99) })],
  ["inactive source", h => h.data[C.sources][0].activo = false],
  ["missing user", h => h.data[C.users].shift()]
];
for (const [name, mutate] of badCases) test(`${name}: aborts before writes`, async () => {
  const h = harness(); mutate(h);
  const before = h.copy(h.data);
  await assert.rejects(() => h.run(apply));
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.data, before);
});

for (const partial of [{ apply: true }, { confirm: CONFIRMATION }, { apply: true, confirm: "wrong" }]) {
  test(`both exact authorizations required: ${JSON.stringify(partial)}`, async () => {
    const h = harness();
    assert.equal((await h.run(partial)).mode, "DRY RUN");
    assert.equal(h.writes.length, 0);
  });
}

test("apply deletes only exact properties/runs/source and leaves all users/plans/other data intact", async () => {
  const h = harness();
  const unrelatedProperty = { _id: oid(50), usuarioId: OTHER, source: "manual", imagenes: ["leave-this"] };
  const unrelatedSource = { _id: oid(51), usuarioId: OTHER, activo: true };
  const unrelatedRun = { _id: oid(52), usuarioId: OTHER, importSourceId: oid(51), status: "completed" };
  h.data[C.properties].push(unrelatedProperty);
  h.data[C.sources].push(unrelatedSource);
  h.data[C.runs].push(unrelatedRun);
  h.data[C.properties].push({ _id: oid(53), usuarioId: U, source: "manual", externalId: "NOT-DEMO", imagenes: [] });
  const users = h.copy(h.data[C.users]);
  const result = await h.run(apply);
  assert.equal(result.applied, true);
  assert.deepEqual(h.data[C.users], users);
  assert.deepEqual(h.data[C.sources], [unrelatedSource]);
  assert.deepEqual(h.data[C.runs], [unrelatedRun]);
  assert.equal(h.data[C.properties].length, 2);
  assert.deepEqual(h.data[C.properties][0], unrelatedProperty);
  assert.ok(h.writes.every(w => [C.sources, C.properties, C.runs].includes(w.name) && w.settings.session));
  assert.equal(h.ended, true);
});

for (const [name, change] of [
  ["new run", h => h.data[C.runs].push({ ...h.data[C.runs][0], _id: oid(22) })],
  ["run identity with same count", h => h.data[C.runs][0]._id = oid(22)],
  ["run content", h => h.data[C.runs][0].updatedAt = new Date()],
  ["property content", h => h.data[C.properties][2].descripcion = "Another edit"],
  ["plan", h => h.data[C.users][0].plan = "vip"],
  ["new reference", h => h.data.mensajes.push({ _id: oid(30), propertyId: oid(10) })]
]) test(`preflight rechecked in transaction: ${name}`, async () => {
  const h = harness(); h.before(() => change(h));
  await assert.rejects(() => h.run(apply));
  assert.equal(h.data[C.properties].length, 4);
  assert.equal(h.data[C.sources].length, 1);
  assert.equal(h.data[C.sources][0].importLockToken, undefined);
  assert.ok(!h.writes.some(w => w.operation === "delete"));
  assert.equal(h.ended, true);
});

test("delete count mismatch rolls back all deletes and source lock", async () => {
  const h = harness(); h.mismatch();
  const before = h.copy(h.data);
  await assert.rejects(() => h.run(apply), { code: "DELETE_COUNT_MISMATCH" });
  assert.deepEqual(h.data, before);
  assert.equal(h.ended, true);
});

test("withTransaction callback retry remains scoped and has no external effects", async () => {
  const h = harness(); h.retry();
  assert.equal((await h.run(apply)).applied, true);
  assert.equal(h.data[C.properties].length, 0);
  assert.equal(h.data[C.users].length, 2);
});

for (const [name, change] of [
  ["plan", h => h.data[C.users][0].plan = "vip"],
  ["user removed", h => h.data[C.users].shift()],
  ["source recreated", h => h.data[C.sources].push({ _id: S, usuarioId: U })],
  ["new run", h => h.data[C.runs].push({ _id: oid(21), usuarioId: U, importSourceId: S })],
  ["new property", h => h.data[C.properties].push({ _id: oid(10), importSourceId: S })]
]) test(`post-commit verification detects ${name}`, async () => {
  const h = harness(); h.after(() => change(h));
  await assert.rejects(() => h.run(apply), { code: "POST_VERIFICATION_FAILED" });
});

test("no fallback without transactions", async () => {
  const h = harness();
  await assert.rejects(() => cleanupCrmSyncDemo({ db: h.db, options: { ...options, ...apply } }), { code: "TRANSACTIONS_REQUIRED" });
  assert.deepEqual(h.writes, []);
});

test("CLI does not connect with missing mandatory arguments; driver secrets never printed", async () => {
  const output = [];
  let connects = 0;
  const mongo = { connect: async () => { connects++; throw new Error("mongodb://secret:password@host private-token"); }, disconnect: async () => {} };
  assert.equal(await runCleanupCli({ argv: [], env: {}, mongo, stderr: value => output.push(value) }), 1);
  assert.equal(connects, 0);
  assert.equal(await runCleanupCli({ argv: args, env: { MONGODB_URI: "test-only" }, mongo, stderr: value => output.push(value) }), 1);
  assert.equal(connects, 1);
  assert.ok(!output.join("").includes("secret"));
  assert.ok(!output.join("").includes(FEED_URL));
});

test("reference errors report collection/count only", async () => {
  const h = harness();
  h.data.mensajes.push({ _id: oid(30), propiedadId: oid(10), texto: "private-message" });
  await assert.rejects(() => h.run(), error => {
    assert.deepEqual(error.references, [{ collection: "mensajes", count: 1 }]);
    assert.ok(!JSON.stringify(error).includes("private-message"));
    return true;
  });
});

test("one-off imports neither models, CRM services, Cloudinary nor email; no HTTP route added", () => {
  const source = fs.readFileSync(new URL("../scripts/cleanup-crm-sync-demo.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\s+["'][^"']*(?:models|cloudinary|selectedImport|email)/i);
  assert.doesNotMatch(source, /fetch\(|https?\.request|sendMail|sendEmail|router\./);
  assert.match(source, /autoIndex: false, autoCreate: false/);
});

test("hash normalization matches the real source crypto helper", async () => {
  const h = harness();
  const unnormalized = " HTTPS://WWW.HOMECLICK24.COM:443/test-sync/original.xml?token=do-not-print ";
  h.data[C.sources][0].feedUrlHash = encryptFeedUrl(unnormalized, {
    CRM_FEED_URL_KEY_V1: crypto.randomBytes(32).toString("base64")
  }).feedUrlHash;
  assert.equal((await h.run({ expectedFeedUrl: unnormalized })).sourceValidated, true);
});

test("apply contends with a concurrent importer on the source document", async () => {
  const h = harness();
  h.before(() => Object.assign(h.data[C.sources][0], { importLockToken: "importer", importLockUntil: new Date(Date.now() + 60000) }));
  await assert.rejects(() => h.run(apply), { code: "SOURCE_BUSY" });
  assert.equal(h.data[C.sources][0].importLockToken, "importer");
  assert.ok(!h.writes.some(w => w.operation === "delete"));
});

test("views and failed reference reads are fail-closed", async () => {
  const h = harness();
  h.db.listCollections = () => ({ toArray: async () => [{ name: "unknown-view", type: "view" }] });
  await assert.rejects(() => h.run(apply), { code: "UNSUPPORTED_COLLECTION" });
  assert.equal(h.writes.length, 0);
  h.db.listCollections = () => ({ toArray: async () => { throw new Error("permission denied"); } });
  await assert.rejects(() => h.run(apply));
  assert.equal(h.writes.length, 0);
});

test("CLI successful dry-run uses no writes, disables auto indexing and disconnects", async () => {
  const h = harness();
  let disconnected = false;
  const mongo = { connection: { db: h.db, getClient: () => h.client },
    async connect(uri, settings) { assert.equal(uri, "mock-uri"); assert.equal(settings.autoIndex, false); assert.equal(settings.autoCreate, false); },
    async disconnect() { disconnected = true; } };
  const output = [];
  assert.equal(await runCleanupCli({ argv: args, env: { MONGODB_URI: "mock-uri" }, mongo, stdout: text => output.push(text) }), 0);
  assert.equal(disconnected, true);
  assert.equal(JSON.parse(output[0]).mode, "DRY RUN");
  assert.deepEqual(h.writes, []);
});
