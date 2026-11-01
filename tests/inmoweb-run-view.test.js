import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createInmowebRunReader } from '../utils/import/inmowebRunView.js';
import { createProviderSnapshots } from '../utils/import/providerSnapshots.js';
import { buildFeedSnapshot } from '../utils/importers/importerRegistry.js';
import { snapshotDigest, runVersions, safeRunSummary } from '../utils/import/syncPlan.js';
import { providerSnapshotStore } from './helpers/providerSnapshotStore.js';
const owner = '507f1f77bcf86cd799439099', sid = '507f1f77bcf86cd799439098', rid = '507f1f77bcf86cd799439097';
const record = fs.readFileSync(new URL('./fixtures/crm/inmoweb-synthetic.xml', import.meta.url), 'utf8').match(/<propiedad\b[\s\S]*?<\/propiedad>/)[0];
const xml = `<properties>${['TEST-A', 'TEST-B'].map(id => record.replace('id="0001"', `id="${id}"`)).join('')}</properties>`;
async function setup() {
  let time = Date.parse('2026-01-01T18:00:00Z');
  const env = { CRM_FEED_URL_KEY_V1: crypto.randomBytes(32).toString('base64'), INMOWEB_NEW_ENABLED: 'true', INMOWEB_NEW_ALLOWED_EXTERNAL_IDS: 'TEST-A' };
  const db = providerSnapshotStore(), snapshot = buildFeedSnapshot(xml, { feedType: 'inmoweb' });
  const source = { _id: sid, usuarioId: owner, activo: true, feedType: 'inmoweb', feedUrlHash: 'a'.repeat(64) };
  const run = { ...runVersions, _id: rid, usuarioId: owner, importSourceId: sid, feedType: 'inmoweb',
    startedAt: new Date(time), expiresAt: new Date(time + 1200000), status: 'simulated', snapshotComplete: false,
    newSnapshotComplete: true, providerNormalizationVersion: 1, sourceIdentityHash: source.feedUrlHash,
    snapshotDigest: snapshotDigest(snapshot), totalResults: 2, newCount: 2,
    plan: snapshot.properties.map(p => ({ externalId: p.data.externalId, type: 'NEW', blocked: true,
      importNewEligible: false, safeReasonCode: 'NEW_REQUIRES_MANUAL_IMPORT' })) };
  const create = () => createProviderSnapshots({ now: () => time, env, SnapshotModel: db.Model });
  const memory = create(), fetchedAt = new Date(time).toISOString();
  const captureId = memory.record({ xml, usuarioId: owner, sourceHash: source.feedUrlHash, fetchedAt });
  await memory.bind({ fetched: { xml, captureId }, run, usuarioId: owner });
  const queries = [];
  const query = value => ({ select() { return this; }, sort(order) { assert.deepEqual(order, { startedAt: -1, _id: -1 }); return this; }, lean() { return Promise.resolve(value); } });
  const reader = createInmowebRunReader({ env, now: () => new Date(time), providerSnapshots: create(),
    ImportSourceModel: { findOne(filter) { queries.push(filter); return query(source); } },
    ImportSyncRunModel: { findOne(filter) { queries.push(filter); return query(run); } } });
  return { reader, run, source, env, db, queries, advance(ms) { time += ms; } };
}
test('restart restores exact persisted run, re-evaluates stale rows and allowlist without writes or renewal', async () => {
  const h = await setup(), before = structuredClone([...h.db.docs]), effects = { ...h.db.effects };
  const dto = await h.reader.latest(owner);
  assert.equal(dto.newImportEligible, true); assert.equal(dto.snapshotState, 'valid');
  assert.deepEqual(dto.results.map(r => r.importNewEligible), [true, false]);
  assert.equal(dto.results[1].importNewBlockCode, 'INMOWEB_NEW_EXTERNAL_ID_NOT_ALLOWED');
  assert.equal(dto.snapshotComplete, false); assert.equal(dto.applyEligible, false);
  assert.deepEqual(h.queries, [{ usuarioId: owner, activo: true }, { usuarioId: owner, importSourceId: sid }]);
  assert.deepEqual([...h.db.docs], before); assert.equal(h.db.effects.inserts, effects.inserts); assert.equal(h.db.effects.inits, effects.inits);
  assert.doesNotMatch(JSON.stringify(dto), /https?:|encryptedSnapshot|sourceIdentityHash|snapshotDigest/);
  h.env.INMOWEB_NEW_ENABLED = 'false';
  assert.equal((await h.reader.byId(rid, owner)).newImportBlockedReason, 'INMOWEB_NEW_DISABLED');
  h.env.INMOWEB_NEW_ENABLED = 'true'; h.env.INMOWEB_NEW_ALLOWED_EXTERNAL_IDS = 'TEST-B';
  assert.deepEqual((await h.reader.latest(owner)).results.map(r => r.importNewEligible), [false, true]);
});
for (const change of ['expired', 'missing', 'digest', 'cipher', 'version', 'identity', 'read-error']) test(`restoration blocks ${change} without refetch or renewal`, async () => {
  const h = await setup(); const doc = h.db.docs.get(rid);
  if (change === 'expired') h.advance(300001);
  if (change === 'missing') h.db.docs.clear();
  if (change === 'digest') doc.snapshotDigest = 'b'.repeat(64);
  if (change === 'cipher') doc.encryptedSnapshot = 'invalid';
  if (change === 'version') doc.normalizationVersion++;
  if (change === 'identity') doc.sourceIdentityHash = 'b'.repeat(64);
  if (change === 'read-error') h.db.faults.read = true;
  const before = structuredClone([...h.db.docs]);
  const dto = await h.reader.latest(owner);
  assert.equal(dto.newImportEligible, false); assert.equal(dto.snapshotState, 'unavailable');
  assert.ok(dto.results.every(r => !r.importNewEligible)); assert.deepEqual([...h.db.docs], before);
});
for (const change of ['owner', 'source', 'source-owner', 'source-identity', 'version', 'consumed', 'running', 'indeterminate']) test(`latest rejects ${change} and never falls back to an older run`, async () => {
  const h = await setup();
  if (change === 'owner') h.run.usuarioId = 'other';
  if (change === 'source') h.run.importSourceId = 'other';
  if (change === 'source-owner') h.source.usuarioId = 'other';
  if (change === 'source-identity') h.source.feedUrlHash = 'b'.repeat(64);
  if (change === 'version') h.run.normalizationVersion++;
  if (change === 'consumed') h.run.newImport = { status: 'completed' };
  if (change === 'running') h.run.status = 'running';
  if (change === 'indeterminate') h.run.newImport = { status: 'indeterminate' };
  assert.equal(await h.reader.latest(owner), null); assert.ok(h.queries.length <= 2); assert.equal(h.db.effects.reads, 0);
});
test('exact five-minute boundary is valid; generic_xml has no new recovery policy', async () => {
  const h = await setup(); h.advance(300000); assert.equal((await h.reader.latest(owner)).newImportEligible, true);
  h.source.feedType = 'generic_xml'; assert.equal(await h.reader.latest(owner), null);
  h.run.feedType = 'generic_xml';
  assert.deepEqual(await h.reader.evaluate(h.run, owner), safeRunSummary(h.run, new Date(+h.run.startedAt + 300000), h.env));
});
