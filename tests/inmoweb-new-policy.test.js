import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { inmowebNewEnabled, assertInmowebNewEnabled, receivedNewSnapshotValid } from "../utils/import/inmowebPolicy.js";
import { buildFeedSnapshot, analyzeFeedXml } from "../utils/importers/importerRegistry.js";
import { createSelectedImporter } from "../utils/import/selectedImport.js";
import { safeRunSummary, snapshotDigest, prepareSyncPlan, runVersions } from "../utils/import/syncPlan.js";
import { safeInmowebPreview } from "../utils/import/inmowebPreview.js";

const xml = fs.readFileSync(new URL("./fixtures/crm/inmoweb-synthetic.xml", import.meta.url), "utf8");
for (const value of [undefined, "false", "0", "TRUE", true, " true "]) test(`gate is OFF without exact explicit opt-in: ${value}`, () => {
  const env = { INMOWEB_NEW_ENABLED: value };
  assert.equal(inmowebNewEnabled(env), false);
  assert.throws(() => assertInmowebNewEnabled("inmoweb", env), { code: "INMOWEB_NEW_DISABLED" });
  assert.doesNotThrow(() => assertInmowebNewEnabled("generic_xml", env));
});
test("gate only opens with explicit true; no action authority is inferred from data eligibility", () => {
  assert.equal(inmowebNewEnabled({ INMOWEB_NEW_ENABLED: "true" }), true);
  const snapshot = buildFeedSnapshot(xml, { feedType: "inmoweb" });
  assert.equal(snapshot.snapshotComplete, false); assert.equal(receivedNewSnapshotValid(snapshot), true);
  const safe = safeInmowebPreview(analyzeFeedXml(xml, { feedType: "inmoweb" }));
  assert.equal(safe.previewOnly, true); assert.equal(safe.importEnabled, false); assert.equal(safe.syncEnabled, false);
});
test("presence evidence is conservative: malformed, duplicate, truncated or structurally uncertain records reject", () => {
  const valid = buildFeedSnapshot(xml, { feedType: "inmoweb" });
  for (const change of [{ structurallyComplete: false }, { total: 2001 }, { snapshotCount: 0 }, { normalizationVersion: 2 },
    { properties: [{ ...valid.properties[0], errors: ["INMOWEB_DUPLICATE_ID"] }] }, { snapshotComplete: true }]) {
    assert.equal(receivedNewSnapshotValid({ ...valid, ...change }), false);
  }
  const unknownType = buildFeedSnapshot(xml.replace('<familia id="24">', '<familia id="999">'), { feedType: "inmoweb" });
  assert.equal(receivedNewSnapshotValid(unknownType), false);
});
test("selectedImport cannot bypass the gate or accept an HTTP-like InmoWeb import without sync context", async () => {
  const analyzed = analyzeFeedXml(xml, { feedType: "inmoweb" });
  for (const enabled of [false, true]) {
    const service = createSelectedImporter({ env: enabled ? { INMOWEB_NEW_ENABLED: "true" } : {},
      UsuarioModel: { findById() { assert.fail("No user/plan work before gate/context validation"); } },
      downloadImage() { assert.fail("No image work"); }, uploadImage() { assert.fail("No upload"); } });
    await assert.rejects(() => service({ usuarioId: "test", feedUrl: "https://example.test/catalog", analyzed,
      selectedExternalIds: ["0001"] }), { code: enabled ? "INMOWEB_NEW_REQUIRES_SYNC" : "INMOWEB_NEW_DISABLED" });
  }
});
test("run presence evidence enables only NEW in synthetic opt-in, never UPDATE/MISSING/REAPPEARED", () => {
  const snapshot = buildFeedSnapshot(xml, { feedType: "inmoweb" });
  const run = { _id: "507f1f77bcf86cd799439011", usuarioId: "507f1f77bcf86cd799439012", importSourceId: "507f1f77bcf86cd799439013",
    status: "simulated", expiresAt: new Date(Date.now() + 60000), sourceIdentityHash: "a".repeat(64), ...runVersions,
    feedType: "inmoweb", newSnapshotComplete: true, providerNormalizationVersion: 1,
    snapshotComplete: false, snapshotDigest: snapshotDigest(snapshot), ...prepareSyncPlan(snapshot, []) };
  const summary = safeRunSummary(run, new Date(), { INMOWEB_NEW_ENABLED: "true" });
  assert.equal(summary.newImportEligible, true); assert.equal(summary.applyEligible, false); assert.equal(summary.missingCount, 0);
  assert.doesNotMatch(JSON.stringify(summary), /sourceIdentityHash|newSnapshotComplete|providerNormalizationVersion|encryptedFeedUrl/);
  for (const change of [{ newSnapshotComplete: undefined }, { providerNormalizationVersion: undefined }, { snapshotComplete: true }]) {
    assert.equal(safeRunSummary({ ...run, ...change }, new Date(), { INMOWEB_NEW_ENABLED: "true" }).newImportEligible, false);
  }
});
