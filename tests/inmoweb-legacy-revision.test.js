import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import Run from "../models/ImportSyncRun.js";
import {createSyncSimulator} from "../utils/import/syncSimulation.js";
import {buildFeedSnapshot} from "../utils/importers/importerRegistry.js";
import {prepareSyncPlan} from "../utils/import/syncPlan.js";
import {readInmowebComparisons} from "../utils/import/inmowebComparison.js";
import {encryptFeedUrl} from "../utils/import/feedUrlCrypto.js";
const owner="507f1f77bcf86cd799439099",sid="507f1f77bcf86cd799439098",rid="507f1f77bcf86cd799439097";
const single=fs.readFileSync(new URL("./fixtures/crm/inmoweb-synthetic.xml",import.meta.url),"utf8").match(/<propiedad\b[\s\S]*?<\/propiedad>/)[0];
const xml="<properties>"+Array.from({length:28},(_,i)=>single.replace('id="0001"','id="'+(i+1)+'"')).join("")+"</properties>";
const snapshot=buildFeedSnapshot(xml,{feedType:"inmoweb"});
const q=value=>({select(){return this;},lean(){return this;},limit(){return this;},then(a,b){return Promise.resolve(value).then(a,b);}});
function properties(revision) {
  const rows=snapshot.properties.slice(0,21).map((p,i)=>({...p.data,_id:(i+1).toString(16).padStart(24,"0"),
    usuarioId:owner,importSourceId:sid,source:"crm"}));
  rows[0].referencia="28";
  rows[0].contentRevision=revision;
  return rows;
}
for(const [label,value,expected] of [
  ["undefined",undefined,0],["null",null,0],["zero",0,0],["positive",3,3],["negative",-1,-1],
  ["fraction",1.5,1.5],["NaN",NaN,undefined],["Infinity",Infinity,undefined],["numeric string","3",undefined],
  ["legacy string","bad-legacy",undefined],["boolean",true,undefined],["object",{},undefined],["array",[],undefined]
]) test("revision "+label+" validates without coercion or property writes",async()=>{
  const rows=properties(value),before=structuredClone(rows);
  const plan=prepareSyncPlan(snapshot,rows);
  assert.equal(plan.newCount,6);
  assert.equal(plan.plan.length,28);
  assert.equal(plan.plan[0].expectedContentRevision,expected);
  assert.equal(Object.hasOwn(plan.plan[0],"expectedContentRevision"),expected!==undefined);
  const update={$set:{plan:plan.plan}};
  assert.doesNotThrow(()=>Run.updateOne({},update)._castUpdate(update));
  await new Run({usuarioId:owner,importSourceId:sid,startedAt:new Date(),status:"simulated",...plan}).validate();
  const review=await readInmowebComparisons({...plan,usuarioId:owner,importSourceId:sid},snapshot,
    {find:()=>q(rows)});
  if(expected===undefined) assert.deepEqual(review.find(r=>r.externalId==="1"),{externalId:"1",unavailable:true});
  assert.deepEqual(rows,before);
});

async function simulate({error,delegated=false}={}) {
  const env={CRM_FEED_URL_KEY_V1:crypto.randomBytes(32).toString("base64")};
  const source={...encryptFeedUrl("https://example.test/synthetic",env),_id:sid,usuarioId:owner,feedType:"inmoweb",activo:true};
  let saved,binds=0;
  const run=createSyncSimulator({env,
    ImportSourceModel:{findOne:()=>q(source),findOneAndUpdate:()=>q(source),updateOne:async()=>({matchedCount:1})},
    ImportSyncRunModel:{create:async()=>({_id:rid}),updateOne:async(filter,update)=>{
      if(update.$set.plan){
        if(error)throw error;
        Run.updateOne(filter,update)._castUpdate(update);
        saved=update.$set;
      }
      return {matchedCount:1};
    }},
    PropiedadModel:{find:()=>q(properties("bad-legacy"))},fetchXml:async()=>({xml}),
    providerSnapshots:{bind:async()=>{binds++;}}
  });
  const result=await run({usuarioId:owner,importSourceId:sid,
    ...(delegated?{delegation:{actorAdminId:owner,id:rid,assert:async()=>{}}}:{})});
  return {result,saved,binds};
}
test("28 records, 21 existing, 6 NEW survive simulator persistence",async()=>{
  const {result,saved,binds}=await simulate();
  assert.equal(result.status,"simulated");
  assert.equal(result.newCount,6);
  assert.equal(result.results.filter(r=>r.type==="NEW"&&r.importNewEligible).length,6);
  assert.equal(saved.plan[0].expectedContentRevision,undefined);
  assert.equal(binds,1);
});
for(const delegated of [false,true])test("safe original-exception logging "+delegated,async t=>{
  const messages=[];
  t.mock.method(console,"warn",(...args)=>messages.push(args));
  const error=Object.assign(new Error("SECRET URL rejected document"),{
    name:"CastError",path:"plan",reason:{path:"expectedContentRevision",value:"SECRET"}});
  await assert.rejects(simulate({error,delegated}),{code:"SYNC_RUN_FAILED",status:400});
  assert.deepEqual(messages,[[ "[CRM Sync Simulation]",{
    phase:"sync-plan-persist",provider:"inmoweb",safeCode:"SYNC_RUN_FAILED",
    errorClass:"CastError",validationPath:"plan.expectedContentRevision"
  }]]);
  messages.length=0;
  await assert.rejects(simulate({error:{name:"SECRET",path:"SECRET",message:"SECRET"},delegated}));
  assert.equal(messages[0][1].errorClass,"Error");
  assert.doesNotMatch(JSON.stringify(messages),/SECRET|validationPath/);
});
