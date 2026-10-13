import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { XMLValidator } from "fast-xml-parser";
import { analyzeGenericXml } from "../utils/importers/genericXmlImporter.js";
import { buildSyncSnapshot } from "../utils/import/syncSnapshot.js";
import { compareSyncSnapshot } from "../utils/import/syncDiff.js";
import { validateImportProperty } from "../utils/import/selectedImport.js";
import { buildPropiedadCreateData } from "../utils/propertyCreation.js";
import { managedFingerprint } from "../utils/import/syncBaseline.js";
import { prepareSyncPlan, safeRunSummary, runVersions, snapshotDigest } from "../utils/import/syncPlan.js";

const xml = fs.readFileSync(new URL("../public/test-sync-missing-ui/homeclick24-missing-ui.xml", import.meta.url), "utf8");
const EXTERNAL_ID = "SYNC-MISSING-UI-001";
const CONTROL_ID = "SYNC-MISSING-UI-CONTROL-001";
// Original BASE stays internal so tests model the already enrolled property.
const baselineXml = `<properties><property>
  <externalId>SYNC-MISSING-UI-001</externalId>
  <title>Piso prueba UI MISSING en Rota</title>
  <description>Datos ficticios exclusivos para prueba controlada de la UI MISSING CRM. No usar como anuncio real.</description>
  <operation>venta</operation><price>219000</price>
  <address>Dirección ficticia de prueba UI MISSING</address>
  <city>Rota</city><province>Cádiz</province>
  <propertyType>piso</propertyType><condition>used</condition>
  <bedrooms>2</bedrooms><bathrooms>1</bathrooms><surface>80</surface>
  <terrace>true</terrace><garage>false</garage><pool>false</pool>
</property></properties>`;
const U = "000000000000000000000001", S = "000000000000000000000002", P = "000000000000000000000003";
const expected = {
  titulo: "Control prueba UI MISSING", precio: 225000, tipoOperacion: "venta",
  direccion: "Dirección ficticia de prueba UI MISSING", localidad: "Rota", provincia: "Cádiz",
  tipoInmueble: "piso", estado: "segunda_mano", habitaciones: 1, banos: 1,
  superficie: 60, terraza: true, garaje: false, piscina: false
};
function created(content = xml) {
  const validation = validateImportProperty(analyzeGenericXml(content)[0]);
  assert.deepEqual(validation.errors, []);
  assert.ok(validation.data);
  return buildPropiedadCreateData(validation.data, { usuarioId: U, plan: "vip" });
}

test("stable UI feed contains exactly one complete publicable CONTROL and no original reference", () => {
  assert.equal(XMLValidator.validate(xml), true);
  const snapshot = buildSyncSnapshot(xml), mapped = analyzeGenericXml(xml);
  assert.equal(snapshot.snapshotComplete, true);
  assert.equal(snapshot.properties.length, 1);
  assert.equal(mapped.length, 1);
  assert.equal(snapshot.properties[0].data.externalId, CONTROL_ID);
  assert.equal(mapped[0].externalId, CONTROL_ID);
  assert.ok(!xml.includes(EXTERNAL_ID));
  const diff = compareSyncSnapshot(snapshot, []);
  assert.equal(diff.results.length, 1);
  assert.equal(diff.results[0].publishableByData, true);
});
test("Fase 2 creation and snapshot agree on all intended semantic fields", () => {
  const property = created(), data = buildSyncSnapshot(xml).properties[0].data;
  for (const [field, value] of Object.entries(expected)) {
    assert.equal(property[field], value, field);
    assert.equal(data[field], value, field);
  }
  assert.equal(property.descripcion, data.descripcion);
  assert.match(property.descripcion, /Datos ficticios exclusivos/);
});
test("CONTROL has no photos, video, coordinates, external resources or real user IDs", () => {
  assert.deepEqual(analyzeGenericXml(xml)[0].fotos, []);
  const property = created();
  assert.deepEqual(property.imagenes, []);
  assert.equal(property.videoUrl, "");
  assert.equal(property.lat, null);
  assert.equal(property.lng, null);
  assert.doesNotMatch(xml, /https?:\/\/|[a-f0-9]{24}|@|usuarioId|ownerId|importSourceId|<images|<video/i);
});
test("unchanged enrolled BASE results in UNCHANGED linked, never MISSING", () => {
  const property = { ...created(baselineXml), _id: P, usuarioId: U, importSourceId: S, source: "crm",
    externalId: EXTERNAL_ID, visiblePublicamente: true, syncEnabled: true, syncOverrides: {},
    contentRevision: 0, syncApplyFingerprintVersion: 1 };
  property.syncApplyFingerprint = managedFingerprint(property);
  const plan = prepareSyncPlan(buildSyncSnapshot(baselineXml), [property],
    { usuarioId: U, importSourceId: S, reconciliations: [] });
  assert.equal(plan.plan.length, 1);
  assert.equal(plan.plan[0].externalId, EXTERNAL_ID);
  assert.equal(plan.plan[0].type, "UNCHANGED");
  assert.equal(plan.plan[0].linked, true);
  assert.equal(plan.missingCount, 0);
});
test("same source with CONTROL yields NEW control and eligible MISSING for enrolled original", () => {
  const property = { ...created(baselineXml), _id: P, usuarioId: U, importSourceId: S, source: "crm",
    externalId: EXTERNAL_ID, visiblePublicamente: true, syncEnabled: true, syncOverrides: {},
    contentRevision: 0, syncApplyFingerprintVersion: 1 };
  property.syncApplyFingerprint = managedFingerprint(property);
  const before = structuredClone(property);
  const snapshot = buildSyncSnapshot(xml);
  const plan = prepareSyncPlan(snapshot, [property], { usuarioId: U, importSourceId: S, reconciliations: [] });
  assert.equal(plan.newCount, 1);
  assert.equal(plan.missingCount, 1);
  const now = new Date();
  const safe = safeRunSummary({ _id: P, usuarioId: U, importSourceId: S, status: "simulated",
    startedAt: now, expiresAt: new Date(+now + 600000), snapshotComplete: true,
    sourceIdentityHash: "a".repeat(64), snapshotDigest: snapshotDigest(snapshot), ...runVersions,
    ...plan, planTruncated: plan.resultsTruncated }, now);
  assert.equal(safe.results.find(e => e.externalId === CONTROL_ID).type, "NEW");
  const missing = safe.results.find(e => e.externalId === EXTERNAL_ID);
  assert.equal(missing.type, "MISSING");
  assert.equal(missing.hideMissingEligible, true);
  assert.equal(missing.hideMissingBlockCode, null);
  assert.equal(missing.blocked, true);
  assert.deepEqual(property, before);
});
