import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import mongoose from "mongoose";
import { createProviderSnapshots, SNAPSHOT_REQUIRED } from "../utils/import/providerSnapshots.js";
import { logProviderSnapshotDiagnostic } from "../utils/import/providerSnapshotDiagnostic.js";
import { buildFeedSnapshot } from "../utils/importers/importerRegistry.js";
import { snapshotDigest, runVersions } from "../utils/import/syncPlan.js";
import { providerSnapshotStore } from "./helpers/providerSnapshotStore.js";
import { createInmowebRunReader } from "../utils/import/inmowebRunView.js";

const fixture = fs.readFileSync(new URL("./fixtures/crm/inmoweb-synthetic.xml", import.meta.url), "utf8");
function setup(t, xml = fixture) {
  const events = [];
  t.mock.method(console, "warn", (prefix, event) => events.push(event));
  let time = Date.now();
  const env = { CRM_FEED_URL_KEY_V1: crypto.randomBytes(32).toString("base64") };
  const db = providerSnapshotStore();
  const run = { ...runVersions, _id: "507f1f77bcf86cd799439097", usuarioId: "507f1f77bcf86cd799439099",
    importSourceId: "507f1f77bcf86cd799439098", feedType: "inmoweb", providerNormalizationVersion: 1,
    sourceIdentityHash: "a".repeat(64), snapshotDigest: snapshotDigest(buildFeedSnapshot(xml, { feedType: "inmoweb" })),
    expiresAt: new Date(time + 1200000) };
  const memory = createProviderSnapshots({ now: () => time, env, SnapshotModel: db.Model });
  const fetched = { xml, captureId: memory.record({ xml, usuarioId: run.usuarioId,
    sourceHash: run.sourceIdentityHash, fetchedAt: new Date(time).toISOString() }) };
  const source = { _id: run.importSourceId, usuarioId: run.usuarioId, feedType: "inmoweb",
    feedUrlHash: run.sourceIdentityHash, activo: true };
  return { events, db, env, run, fetched, memory, source, advance: ms => { time += ms; },
    bind: () => memory.bind({ fetched, run, usuarioId: run.usuarioId }),
    restore: () => memory.readPersisted({ run, source, usuarioId: run.usuarioId }) };
}
const rejects = action => assert.rejects(async () => action(), { code: SNAPSHOT_REQUIRED, status: 409 });
for (const kind of ["cast", "validation", "duplicate", "init", "encrypt", "decode", "validity"]) {
  test("persist diagnoses " + kind + " without changing public error", async t => {
    const h = setup(t);
    if (kind === "cast") h.db.Model.findOneAndUpdate = () => {
      throw new mongoose.Error.CastError("Number", "SECRET", "snapshotVersion");
    };
    if (kind === "validation") h.db.Model.findOneAndUpdate = () => {
      const error = new mongoose.Error.ValidationError();
      error.addError("snapshotDigest", new mongoose.Error.ValidatorError({
        path: "snapshotDigest", type: "required", value: "SECRET", message: "SECRET"
      }));
      throw error;
    };
    if (kind === "duplicate") h.db.Model.findOneAndUpdate = () => {
      throw Object.assign(new Error("SECRET"), { name: "MongoServerError", code: 11000 });
    };
    if (kind === "init") h.db.Model.init = async () => { throw new Error("SECRET"); };
    if (kind === "encrypt") delete h.env.CRM_FEED_URL_KEY_V1;
    if (kind === "decode") h.db.Model.findOneAndUpdate = () => Promise.resolve(null);
    if (kind === "validity") {
      await h.bind();
      h.advance(2000);
      h.fetched.captureId = h.memory.record({ xml: fixture, usuarioId: h.run.usuarioId,
        sourceHash: h.run.sourceIdentityHash, fetchedAt: new Date(Date.now() + 1000).toISOString() });
    }
    await rejects(h.bind);
    const e = h.events.at(-1);
    assert.equal(e.stage, { init: "model-init", encrypt: "encrypt", decode: "snapshot-decode",
      validity: "snapshot-validity" }[kind] || "snapshot-upsert");
    if (kind === "cast") assert.deepEqual([e.originalErrorClass, e.validationPath, e.mongooseKind],
      ["CastError", "snapshotVersion", "Number"]);
    if (kind === "validation") assert.deepEqual([e.originalErrorClass, e.validationPath, e.mongooseKind],
      ["ValidationError", "snapshotDigest", "required"]);
    if (kind === "duplicate") assert.equal(e.mongoCode, 11000);
    assert.doesNotMatch(JSON.stringify(h.events), /SECRET/);
  });
}
for (const stage of ["missing", "expired", "identity", "digest", "version"]) {
  test("bind stage " + stage, async t => {
    const h = setup(t);
    if (stage === "missing") h.fetched.captureId = "absent";
    if (stage === "expired") h.advance(300001);
    if (stage === "identity") h.run.sourceIdentityHash = "b".repeat(64);
    if (stage === "digest") h.run.snapshotDigest = "b".repeat(64);
    if (stage === "version") h.run.providerNormalizationVersion++;
    await rejects(h.bind);
    assert.equal(h.events[0].stage, "snapshot-" + stage);
    assert.equal(Object.hasOwn(h.events[0], "originalErrorClass"), false);
  });
}
test("restore logs read failure and reader returns unavailable evidence", async t => {
  const h = setup(t); await h.bind();
  h.db.Model.findOne = () => { throw Object.assign(new Error("SECRET"), { name: "MongoServerError", code: 11000 }); };
  await rejects(h.restore);
  assert.equal(h.events[0].stage, "snapshot-read");
  const reader = createInmowebRunReader({ providerSnapshots: h.memory, env: {} });
  const dto = await reader.evaluate({ ...h.run, status: "simulated", plan: [], snapshotComplete: false,
    newSnapshotComplete: true }, h.run.usuarioId, h.source);
  assert.equal(dto.snapshotState, "unavailable");
});
test("adversarial metadata and throwing log cannot escape", () => {
  const events = [];
  const meta = { provider: "inmoweb", phase: "sync-snapshot-persist", stage: "encrypt" };
  logProviderSnapshotDiagnostic({ ...meta, error: { name: "SECRET", path: "SECRET", kind: "SECRET",
    message: "token SECRET", stack: "https://SECRET", value: "SECRET", code: Infinity } }, e => events.push(e));
  assert.deepEqual(events[0], { ...meta, safeCode: SNAPSHOT_REQUIRED, originalErrorClass: "Error" });
  assert.doesNotThrow(() => logProviderSnapshotDiagnostic({ ...meta, error: new Error() }, () => { throw new Error(); }));
  logProviderSnapshotDiagnostic({ ...meta, provider: "generic_xml" }, e => events.push(e));
  assert.equal(events.length, 1);
});
test("throwing logger preserves snapshot rejection", async t => {
  const h = setup(t); delete h.env.CRM_FEED_URL_KEY_V1;
  t.mock.method(console, "warn", () => { throw new Error("SECRET"); });
  await rejects(h.bind);
});
test("normalized payload above 8 MiB fails at encrypt before DB write", async t => {
  // Repeated valid records enlarge normalized metadata as well as data without a real feed.
  const single = fixture.match(/<propiedad\b[\s\S]*?<\/propiedad>/)[0];
  const text = "x".repeat(100000);
  const expanded = single.replace("Datos inventados exclusivamente para tests.", text);
  const xml = "<properties>" + Array.from({ length: 46 }, (_, i) =>
    expanded.replace('id="0001"', 'id="' + i + '"')).join("") + "</properties>";
  const h = setup(t, xml);
  await rejects(h.bind);
  assert.equal(h.events.at(-1).stage, "encrypt");
  assert.equal(h.db.effects.inserts, 0);
});
