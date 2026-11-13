import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { duplicateReport } from "../utils/audit/inmowebDuplicateMatcher.js";
import { auditInmowebDuplicates } from "../utils/audit/inmowebDuplicateAudit.js";
import { buildFeedSnapshot } from "../utils/importers/importerRegistry.js";
import { snapshotDigest, runVersions } from "../utils/import/syncPlan.js";
import { encryptProviderSnapshot } from "../utils/import/providerSnapshotCrypto.js";

const fixture = file => readFileSync(new URL("./fixtures/crm/" + file, import.meta.url), "utf8");
const { incoming, existing } = JSON.parse(fixture("duplicate-audit-data.json"));
const [strong, possible, fresh] = ["SEGURAMENTE DUPLICADA", "POSIBLE DUPLICADA", "PROBABLEMENTE NUEVA"];
test("distinta referencia, precio cambiado y vivienda distinta", () => {
  const report = duplicateReport(incoming, existing);
  assert.deepEqual(report.filas.map(r => r.clasificacion), [strong, possible, fresh]);
  assert.equal(report.filas[0].candidata.referencia, "MAN-1");
  assert.doesNotMatch(JSON.stringify(report), /example.invalid|buhardilla/);
});
test("precio, localidad y dormitorios por sí solos son insuficientes", () => {
  const p = { ...incoming[2], localidad: existing[0].localidad, precio: existing[0].precio, habitaciones: 3 };
  assert.equal(duplicateReport([p], existing).filas[0].clasificacion, fresh);
});
test("fotos y estructura identifican una vivienda sin texto comparable", () => {
  const p = { ...incoming[0], descripcion: "", titulo: "" };
  assert.equal(duplicateReport([p], existing).filas[0].clasificacion, strong);
});
test("prioriza el mejor y marca candidatos casi empatados", () => {
  const other = { ...existing[0], _id: "000000000000000000000002", banos: 1 };
  const row = duplicateReport([incoming[0]], [other, ...existing]).filas[0];
  assert.equal(row.candidata._id, existing[0]._id);
  assert.deepEqual(row.alternativas.map(c => c._id), [other._id]);
  assert.equal(row.clasificacion, possible);
});

function setup() {
  const owner = "owner", source = { _id: "source", usuarioId: owner, feedType: "inmoweb", feedUrlHash: "hash" };
  const snapshot = buildFeedSnapshot(fixture("inmoweb-synthetic.xml"), { feedType: "inmoweb" });
  const run = { _id: "run", usuarioId: owner, importSourceId: source._id, ...runVersions, feedType: "inmoweb",
    sourceIdentityHash: "hash", snapshotDigest: snapshotDigest(snapshot), expiresAt: new Date(600000),
    snapshotComplete: false, newSnapshotComplete: true, providerNormalizationVersion: 1, status: "simulated",
    totalResults: snapshot.total, newCount: snapshot.total, delegationId: "grant", actorAdminId: "admin",
    plan: snapshot.properties.map(p => ({ type: "NEW", externalId: p.data.externalId })) };
  const metadata = { runId: run._id, usuarioId: owner, importSourceId: source._id, provider: "inmoweb",
    sourceIdentityHash: "hash", snapshotDigest: run.snapshotDigest, ...runVersions, providerAdapterVersion: 1,
    fetchedAt: new Date(0), expiresAt: new Date(300000) };
  const env = { CRM_FEED_URL_KEY_V1: randomBytes(32).toString("base64") };
  const doc = { ...metadata, ...encryptProviderSnapshot(snapshot, metadata, env) };
  const read = obj => ({ findOne: async () => obj });
  const properties = [];
  const db = { users: read({}), grants: read({}), runs: read(run), snapshots: read(doc),
    sources: { findOne: async filter => filter.feedType === source.feedType ? source : null },
    properties: { find(filter) { assert.deepEqual(filter, { usuarioId: owner }); return { toArray: async () => properties }; } } };
  return { run, source, doc, db, properties, audit: (time = 1000) => auditInmowebDuplicates(owner, db, { now: () => time, env }) };
}
test("auditoría de snapshot cifrada solo lee y descuenta un NEW ya incorporado", async () => {
  const h = setup();
  const before = structuredClone([h.doc, h.run]);
  assert.equal((await h.audit()).totalNEW, h.run.newCount);
  h.properties.push({ _id: "existing", source: "crm", importSourceId: "source", externalId: h.run.plan[0].externalId });
  assert.equal((await h.audit()).totalNEW, h.run.newCount - 1);
  assert.deepEqual([h.doc, h.run], before);
});
test("caducada, ausente, alterada o generic_xml: termina sin fetch, TTL ni acceso a propiedades", async () => {
  const h = setup();
  h.db.properties = {};
  assert.match((await h.audit(300001)).estado, /caducada/);
  h.doc.encryptedSnapshot = "invalid";
  assert.equal((await h.audit()).totalNEW, null);
  h.db.snapshots.findOne = async () => null;
  assert.match((await h.audit()).estado, /ausente/);
  h.source.feedType = "generic_xml";
  assert.match((await h.audit()).estado, /Fuente InmoWeb no disponible/);
});

const description = incoming[0].descripcion;
const title = incoming[0].titulo;
const photo = "https://example.invalid/common.jpg";
const gallery = { imagenes: [photo] };
const structure = { superficie: 120, superficieParcela: 200, habitaciones: 3 };
const market = { localidad: "Villa Azul", precio: 250000 };
for (const [name, left, right, expected, points, families] of [
  ["solo principal", gallery, gallery, fresh, 32, ["visual"]],
  ["solo foto secundaria", { imagenes: [photo] }, { imagenes: ["https://example.invalid/other.jpg", photo] }, fresh, 24, ["visual"]],
  ["solo descripción", { descripcion: description }, { descripcion: description }, fresh, 28, ["textual"]],
  ["solo título", { titulo: title }, { titulo: title }, fresh, 8, ["textual"]],
  ["título y descripción de una sola familia", { titulo: title, descripcion: description }, { titulo: title, descripcion: description }, fresh, 36, ["textual"]],
  ["foto y mercado", { ...gallery, ...market }, { ...gallery, ...market }, possible, 48, ["visual", "location_commercial"]],
  ["descripción y estructura", { descripcion: description, ...structure }, { descripcion: description, superficie: 120, habitaciones: 3 }, possible, 46, ["textual", "structural"]],
  ["estructura y mercado", { ...structure, ...market }, { ...structure, ...market }, possible, 44, ["structural", "location_commercial"]],
  ["precio y referencia", { precio: 1, referencia: "X" }, { precio: 1, referencia: "X" }, fresh, 10, ["reference", "location_commercial"]],
  ["descripción y referencia", { descripcion: description, referencia: "X" }, { descripcion: description, referencia: "X" }, fresh, 29, ["reference", "textual"]],
  ["dormitorios y mercado", { habitaciones: 3, ...market }, { habitaciones: 3, ...market }, fresh, 21, ["structural", "location_commercial"]],
  ["fuerte con dos familias", { ...gallery, ...structure, banos: 2, tipoOperacion: "venta" },
    { ...gallery, ...structure, banos: 2, tipoOperacion: "venta" }, strong, 66, ["visual", "structural"]]
]) {
  test(name, () => {
    const row = duplicateReport([left], [{ _id: "fixture", ...right }]).filas[0];
    assert.equal(row.clasificacion, expected);
    assert.equal(row.puntos, points);
    assert.deepEqual(new Set(row.evidenceFamilies), new Set(families));
  });
}
