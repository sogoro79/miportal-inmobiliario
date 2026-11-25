import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createProviderSnapshots, SNAPSHOT_REQUIRED } from '../utils/import/providerSnapshots.js';
import { createInmowebRunReader } from '../utils/import/inmowebRunView.js';
import { prepareSyncPlan, snapshotDigest, runVersions } from '../utils/import/syncPlan.js';
import { buildFeedSnapshot } from '../utils/importers/importerRegistry.js';
import { providerSnapshotStore } from './helpers/providerSnapshotStore.js';
const xml=fs.readFileSync(new URL('./fixtures/crm/inmoweb-synthetic.xml',import.meta.url),'utf8');
const snap=buildFeedSnapshot(xml,{feedType:'inmoweb'});
const q=value=>({select(){return this},lean(){return Promise.resolve(value)}});
async function setup(t){
  t.mock.method(console,'warn',()=>{});
  let time=Date.parse('2026-11-25T18:00:00Z'), portfolios=0, revoked=false;
  const initial=time, db=providerSnapshotStore();
  const source={_id:'507f1f77bcf86cd799439011',usuarioId:'507f1f77bcf86cd799439012',activo:true,feedType:'inmoweb',feedUrlHash:'a'.repeat(64)};
  const run={...runVersions,...prepareSyncPlan(snap,[]),_id:'507f1f77bcf86cd799439013',usuarioId:source.usuarioId,
    importSourceId:source._id,sourceIdentityHash:source.feedUrlHash,feedType:'inmoweb',status:'simulated',
    snapshotComplete:false,newSnapshotComplete:true,providerNormalizationVersion:1,snapshotDigest:snapshotDigest(snap),
    startedAt:new Date(time),expiresAt:new Date(time+1200000),actorAdminId:'admin',delegationId:'grant'};
  const env={CRM_FEED_URL_KEY_V1:crypto.randomBytes(32).toString('base64')};
  const snapshots=createProviderSnapshots({now:()=>time,SnapshotModel:db.Model,env});
  await snapshots.bind({run,usuarioId:run.usuarioId,fetched:{xml,captureId:snapshots.record({xml,usuarioId:run.usuarioId,sourceHash:run.sourceIdentityHash,fetchedAt:new Date(time).toISOString()})}});
  const delegation={actorAdminId:'admin',id:'grant',assert:async()=>{if(revoked)throw Error('revoked')}};
  const options={providerSnapshots:snapshots,now:()=>new Date(time),env,
    PropiedadModel:{find(){portfolios++;return q([])}},ImportSourceModel:{findOne:()=>q(source)},ImportSyncRunModel:{findOne:()=>q(run)}};
  const args={run,source,usuarioId:run.usuarioId};
  return {db,run,source,args,snapshots,options,initial,advance:ms=>{time=initial+ms},revoke:()=>{revoked=true},portfolios:()=>portfolios,
    review:(externalId=snap.properties[0].data.externalId,review='ficha')=>createInmowebRunReader(options).evaluate(run,run.usuarioId,source,delegation,{externalId,review}),
    normal:()=>createInmowebRunReader(options).evaluate(run,run.usuarioId,source,delegation)};
}
for(const [age,valid] of [[0,true],[300000,true],[300001,true],[1799000,true],[1800000,false],[1800001,false]]){
 test(`NEW review at ${age} ms: ${valid}`,async t=>{
   const h=await setup(t),before=structuredClone([...h.db.docs.values()]);h.advance(age);
   const dto=await h.review();assert.equal(Boolean(dto.newReviews?.length),valid);
   assert.equal(h.portfolios(),0);assert.deepEqual([...h.db.docs.values()],before);
   assert.equal(h.db.effects.inserts,1);assert.equal(h.db.effects.inits,1);
   if(valid){assert.equal(+new Date(dto.newReviewExpiresAt),h.initial+1800000);await h.review(undefined,'duplicates');assert.equal(h.portfolios(),1);}
   if(age>300000){await assert.rejects(()=>h.snapshots.get(h.args),{code:SNAPSHOT_REQUIRED});assert.equal(dto.newImportEligible,false);}
 });
}
for(const kind of ['owner','source','run','digest','version','snapshot','externalId','delegation']){
 test(`long review rejects ${kind}`,async t=>{
   const h=await setup(t);h.advance(900000);
   if(kind==='owner')h.run.usuarioId='foreign';
   if(kind==='source')h.source.feedUrlHash='b'.repeat(64);
   if(kind==='run')h.run._id='507f1f77bcf86cd799439099';
   if(kind==='digest')h.run.snapshotDigest='b'.repeat(64);
   if(kind==='version')h.run.normalizationVersion=999;
   if(kind==='snapshot')h.db.docs.values().next().value.encryptedSnapshot='corrupt';
   if(kind==='delegation')h.revoke();
   assert.equal((await h.review(kind==='externalId'?'foreign':undefined)).newReviews,undefined);
   assert.equal(h.portfolios(),0);assert.equal(h.db.effects.inserts,1);
 });
}
test('normal run keeps NEW lazy and import/freshness unchanged; review never installs an import lease',async t=>{
 const h=await setup(t);h.advance(900000);
 assert.equal((await h.normal()).newReviews,undefined);assert.equal(h.portfolios(),0);
 const dto=await h.review();assert.ok(dto.newReviews);assert.equal(dto.snapshotState,'unavailable');assert.equal(dto.newImportEligible,false);
 await assert.rejects(()=>h.snapshots.readPersisted(h.args),{code:SNAPSHOT_REQUIRED});
 await assert.rejects(()=>h.snapshots.get(h.args),{code:SNAPSHOT_REQUIRED});
 assert.equal(h.db.effects.inserts,1);
});
test('clock expiring during candidate query discards result and delegation revoked mid-read also blocks',async t=>{
 for(const revoke of [false,true]){
  const h=await setup(t);h.advance(900000);
  h.options.PropiedadModel.find=()=>{if(revoke)h.revoke();else h.advance(1800000);return q([])};
  assert.equal((await h.review(undefined,'duplicates')).newReviews,undefined);
 }
});
