import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ProviderSnapshot from '../models/ProviderSnapshot.js';
import { updateProviderSnapshotTtl, main } from '../scripts/update-provider-snapshot-ttl.js';
import { PROVIDER_SNAPSHOT_COLLECTION, PROVIDER_SNAPSHOT_TTL_INDEX, PROVIDER_SNAPSHOT_TTL_SECONDS } from '../utils/import/providerSnapshotRetention.js';
const correct = ttl => ({ name: 'expiresAt_1', key: { expiresAt: 1 }, expireAfterSeconds: ttl });
function fixture(indexes = [correct(0)], { commandError, noChange = false, readError } = {}) {
  const logs = [], commands = []; let reads = 0;
  const db = { collection(name) {
    assert.equal(name, 'providerSnapshots');
    return { listIndexes: () => ({ toArray: async () => { reads++; if(readError)throw readError; return structuredClone(indexes); } }) };
  }, async command(command) {
    commands.push(command); if(commandError)throw commandError;
    if(!noChange)indexes[0].expireAfterSeconds = 1800;
    return { ok: 1 };
  } };
  const logger={log:(...args)=>logs.push(args),error:(...args)=>logs.push(args)};
  return { db, logger, logs, commands, reads:()=>reads, run:()=>updateProviderSnapshotTtl({db,logger}) };
}
test('actual schema collection/key/default name and target match administrative helper',()=>{
  assert.equal(ProviderSnapshot.schema.options.collection,PROVIDER_SNAPSHOT_COLLECTION);
  const [key, options]=ProviderSnapshot.schema.indexes().find(([key])=>key.expiresAt===1);
  assert.deepEqual(key,{expiresAt:1});assert.equal(Object.entries(key).flat().join('_'),PROVIDER_SNAPSHOT_TTL_INDEX);
  assert.equal(options.expireAfterSeconds,PROVIDER_SNAPSHOT_TTL_SECONDS);
  assert.equal(5*60+PROVIDER_SNAPSHOT_TTL_SECONDS,35*60);
});
test('already correct: no collMod',async()=>{
 const h=fixture([correct(1800)]);assert.equal((await h.run()).changed,false);assert.equal(h.commands.length,0);assert.equal(h.reads(),1);
});
for(const ttl of [0,1500])test(`old TTL ${ttl}: one collMod, reread and confirmed exact target`,async()=>{
 const h=fixture([correct(ttl)]);assert.equal((await h.run()).changed,true);assert.equal(h.reads(),2);
 assert.deepEqual(h.commands,[{collMod:'providerSnapshots',index:{name:'expiresAt_1',expireAfterSeconds:1800}}]);
 assert.deepEqual(h.logs.map(row=>row[1].currentTTL),[ttl,1800]);
});
test('second invocation does not change anything',async()=>{
 const h=fixture();await h.run();assert.equal((await h.run()).changed,false);assert.equal(h.commands.length,1);
});
for(const [name,indexes] of [
 ['missing',[]],['unexpected key',[{...correct(0),key:{fetchedAt:1}}]],
 ['compound key',[{...correct(0),key:{expiresAt:1,runId:1}}]],
 ['unexpected name',[{...correct(0),name:'SECRET-custom-index'}]],
 ['not TTL',[{name:'expiresAt_1',key:{expiresAt:1}}]],
 ['unknown TTL',[correct(999)]],['partial',[{...correct(0),partialFilterExpression:{secret:'SECRET'}}]],
 ['ambiguous',[correct(0),{...correct(0),name:'other'}]]
])test(`${name}: fail closed without command/create/drop`,async()=>{
 const h=fixture(indexes);await assert.rejects(h.run,{code:'TTL_INDEX_REVIEW_REQUIRED'});assert.equal(h.commands.length,0);
 assert.doesNotMatch(JSON.stringify(h.logs),/SECRET/);
});
for(const [code,expected] of [[59,'TTL_COLLMOD_UNSUPPORTED'],[72,'TTL_COLLMOD_UNSUPPORTED'],[115,'TTL_COLLMOD_UNSUPPORTED'],[13,'TTL_COLLMOD_FORBIDDEN'],[999,'TTL_COLLMOD_FAILED']])
 test(`collMod error ${code} is safely classified without fallback`,async()=>{
 const h=fixture(undefined,{commandError:Object.assign(Error('SECRET mongodb://user:password@private'),{code})});
 await assert.rejects(h.run,{code:expected});assert.equal(h.commands.length,1);assert.equal(h.reads(),1);
 assert.doesNotMatch(JSON.stringify(h.logs),/SECRET|password|mongodb/);
});
test('post verification mismatch fails; no rollback or silent drop/create',async()=>{
 const h=fixture(undefined,{noChange:true});await assert.rejects(h.run,{code:'TTL_VERIFY_FAILED'});assert.equal(h.commands.length,1);assert.equal(h.reads(),2);
});
test('post verification requires index still to exist',async()=>{
 const h=fixture();h.db.command=async()=>{h.db.collection=()=>({listIndexes:()=>({toArray:async()=>[]})});return {ok:1}};
 await assert.rejects(h.run,{code:'TTL_VERIFY_FAILED'});
});
test('metadata only: never log other index fields',async()=>{
 const h=fixture([{...correct(0),private:'SECRET',ns:'private'}]);await h.run();
 for(const [,metadata] of h.logs)assert.deepEqual(Object.keys(metadata),['collection','index','currentTTL','targetTTL']);
 assert.doesNotMatch(JSON.stringify(h.logs),/SECRET|private/);
});
test('main closes native driver and reports connection/command failures with static messages only',async()=>{
 for(const failConnect of [true,false]){
  const h=fixture(undefined,{commandError:Error('SECRET')});let closed=0;const runtime={exitCode:0};
  await main({env:{MONGODB_URI:'mongodb://SECRET'},runtime,logger:h.logger,
    createClient:uri=>{assert.equal(uri,'mongodb://SECRET');return {connect:async()=>{if(failConnect)throw Error(uri)},db:()=>h.db,close:async()=>{closed++}}}});
  assert.equal(closed,1);assert.equal(runtime.exitCode,1);assert.doesNotMatch(JSON.stringify(h.logs),/SECRET|mongodb:\/\//);
 }
});
test('missing configuration never constructs a client',async()=>{
 const logs=[],runtime={exitCode:0};await main({env:{},runtime,logger:{error:x=>logs.push(x)},createClient:()=>assert.fail('no connection')});
 assert.equal(runtime.exitCode,1);assert.match(logs[0],/Falta la configuración/);
});
test('successful CLI run closes connection and leaves exit code zero',async()=>{
 const h=fixture();let closed=0;const runtime={exitCode:0};
 await main({env:{MONGODB_URI:'synthetic'},runtime,logger:h.logger,createClient:()=>({connect:async()=>{},db:()=>h.db,close:async()=>{closed++}})});
 assert.equal(runtime.exitCode,0);assert.equal(closed,1);
});
test('script cannot auto-init models or run with server startup; no document writes',()=>{
 const source=fs.readFileSync(new URL('../scripts/update-provider-snapshot-ttl.js',import.meta.url),'utf8');
 const server=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
 assert.doesNotMatch(source,/models\/|\.init\(|syncIndexes|createIndex|dropIndex|updateMany|insertOne|deleteMany|setInterval/);
 assert.doesNotMatch(server,/update-provider-snapshot-ttl/);
 assert.match(source,/import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/);
});
