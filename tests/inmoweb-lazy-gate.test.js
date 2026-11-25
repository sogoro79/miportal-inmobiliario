import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import vm from "node:vm";
import {createSyncSimulator} from "../utils/import/syncSimulation.js";
import {createFeedAccess} from "../utils/import/feedAccess.js";
import {encryptFeedUrl} from "../utils/import/feedUrlCrypto.js";
import {INMOWEB_UNAVAILABLE, INMOWEB_UNAVAILABLE_MESSAGE} from "../utils/import/inmowebAvailability.js";
import {createAdminCrmRouter} from "../routes/adminCrm.js";
import {createCrmImportRouter} from "../routes/crmImport.js";
const owner="507f1f77bcf86cd799439099",sid="507f1f77bcf86cd799439098",rid="507f1f77bcf86cd799439097";
const xml=fs.readFileSync(new URL("./fixtures/crm/inmoweb-synthetic.xml",import.meta.url),"utf8");
const q=v=>({select(){return this},lean(){return this},limit(){return this},session(){return this},then(a,b){return Promise.resolve(v).then(a,b)}});
function simulation(date) {
  let downloads=0,binds=0; const now=()=>new Date(date);
  const env={CRM_FEED_URL_KEY_V1:crypto.randomBytes(32).toString("base64")};
  const url="https://example.test/synthetic";
  const source={...encryptFeedUrl(url,env),_id:sid,usuarioId:owner,feedType:"inmoweb",activo:true};
  const access=createFeedAccess({now:()=>+now(),log:()=>{},fetchXml:async()=>{downloads++;return {xml}}});
  const execute=createSyncSimulator({env,now,fetchXml:access,
    ImportSourceModel:{findOne:()=>q(source),findOneAndUpdate:()=>q(source),updateOne:async()=>({matchedCount:1})},
    ImportSyncRunModel:{create:async()=>({_id:rid}),updateOne:async()=>({matchedCount:1})},
    PropiedadModel:{find:()=>q([])},providerSnapshots:{bind:async()=>{binds++}}});
  return {run:()=>execute({usuarioId:owner,importSourceId:sid}),counts:()=>({downloads,binds}),
    // A synthetic transport cache seeded at the same instant; no real network.
    seed:()=>access(url,{usuarioId:owner,feedType:"generic_xml",fresh:false})};
}
test("12:00 Madrid cold process preserves functional 503 without feed or snapshot",async()=>{
  const h=simulation("2026-11-25T11:00:00Z");
  await assert.rejects(h.run(),{code:INMOWEB_UNAVAILABLE,status:503});
  assert.deepEqual(h.counts(),{downloads:0,binds:0});
});
test("12:00 Madrid valid transport cache still allows simulation",async()=>{
  const h=simulation("2026-11-25T11:00:00Z");await h.seed();
  assert.equal((await h.run()).status,"simulated");
  assert.deepEqual(h.counts(),{downloads:1,binds:1});
});
for(const time of ["2026-11-25T17:00:00Z","2026-11-26T07:59:00Z"])
test("allowed window unchanged "+time,async()=>{
  const h=simulation(time);assert.equal((await h.run()).status,"simulated");
  assert.deepEqual(h.counts(),{downloads:1,binds:1});
});
function response(){return {statusCode:200,status(n){this.statusCode=n;return this},json(body){this.body=body;return this}}}
const handler=(router,path)=>router.stack.find(l=>l.route?.path===path).route.stack.at(-1).handle;
test("delegated functional error keeps safe status/code and logs only permitted metadata",async t=>{
  const logs=[];t.mock.method(console,"warn",(...args)=>logs.push(args));
  const source={_id:sid,usuarioId:owner,activo:true,feedType:"inmoweb",feedUrlHash:"a"};
  const grant={_id:rid,usuarioId:owner,importSourceId:sid,enabled:true,provider:"inmoweb",sourceIdentityHash:"a"};
  const router=createAdminCrmRouter({simulationLimits:[],importLimits:[],
    UsuarioModel:{findOne:()=>q({_id:owner,activo:true,role:"user"}),exists:()=>q(true)},
    ImportSourceModel:{findOne:()=>q(source)},GrantModel:{findOne:()=>q(grant),exists:()=>q(true)},
    runSimulation:async()=>{throw Object.assign(new Error("SECRET"),{code:INMOWEB_UNAVAILABLE,status:503})}});
  const res=response();
  await handler(router,"/simulate")({params:{userId:owner},user:{id:rid},body:{}},res);
  assert.equal(res.statusCode,503);assert.equal(res.body.code,INMOWEB_UNAVAILABLE);
  assert.equal(res.body.errorCode,INMOWEB_UNAVAILABLE);assert.equal(res.body.error,INMOWEB_UNAVAILABLE_MESSAGE);
  assert.deepEqual(logs, [["[Admin CRM Simulation]",{phase:"run-simulation",provider:"inmoweb",safeCode:INMOWEB_UNAVAILABLE,status:503}]]);
});
test("profile simulation retains functional code and semantic status",async t=>{
  t.mock.method(console,"warn",()=>{});
  const router=createCrmImportRouter({simulateSync:async()=>{throw Object.assign(new Error("SECRET"),{code:INMOWEB_UNAVAILABLE,status:503})}});
  const res=response();
  await handler(router,"/sync/simulate")({body:{importSourceId:sid},user:{id:owner}},res);
  assert.equal(res.statusCode,503);assert.equal(res.body.errorCode,INMOWEB_UNAVAILABLE);
  assert.equal(res.body.error,INMOWEB_UNAVAILABLE_MESSAGE);
});
test("admin UI renders specific schedule message without retry",async()=>{
  const elements=new Map();let simulations=0;
  const document={getElementById(id){
    if(!elements.has(id))elements.set(id,{textContent:"",children:[],addEventListener(){},replaceChildren(){},showModal(){this.open=true},style:{}});
    return elements.get(id);
  }};
  const window={};
  vm.runInNewContext(fs.readFileSync(new URL("../public/js/admin-crm.js",import.meta.url),"utf8"),
    {window,document,adminToken:"synthetic",fetch:async path=>{
      if(path.endsWith("/source"))return {ok:true,json:async()=>({authorized:true,active:true,sourceConfigured:true})};
      simulations++;return {ok:false,status:503,json:async()=>({code:INMOWEB_UNAVAILABLE})};
    }});
  await window.abrirCrmDelegado(owner);
  await document.getElementById("crmDelegatedSimulate").onclick();
  assert.equal(document.getElementById("crmDelegatedStatus").textContent,INMOWEB_UNAVAILABLE_MESSAGE);
  assert.equal(simulations,1);
});

test("delegated GET forwards explicit review only on authorized run reads", async () => {
  const source={_id:sid,usuarioId:owner,activo:true,feedType:"inmoweb",feedUrlHash:"a"};
  const grant={_id:rid,usuarioId:owner,importSourceId:sid,enabled:true,provider:"inmoweb",sourceIdentityHash:"a"};
  let received;
  const router=createAdminCrmRouter({simulationLimits:[],importLimits:[],
    UsuarioModel:{findOne:()=>q({_id:owner,activo:true,role:"user"}),exists:()=>q(true)},
    ImportSourceModel:{findOne:()=>q(source)},GrantModel:{findOne:()=>q(grant),exists:()=>q(true)},
    ImportSyncRunModel:{findOne:filter=>{
      assert.equal(filter.usuarioId,owner);assert.equal(filter.importSourceId,sid);
      assert.equal(filter.actorAdminId,rid);assert.equal(filter.delegationId,rid);
      return q({_id:rid});
    }},
    runReader:{evaluate:async(...args)=>{received=args[4];return {newReviews:[]}}}});
  const query={externalId:"0001",review:"duplicates"};
  const req={params:{userId:owner,runId:rid},user:{id:rid},method:"GET",path:"/runs/"+rid,query};
  const validate=router.stack[1].handle;
  const res=response();res.set=()=>res;
  let passed=false;validate(req,res,()=>{passed=true});assert.equal(passed,true);
  await handler(router,"/runs/:runId")(req,res);
  assert.deepEqual(received,query);
  for(const mutation of [{...req,method:"POST",path:"/simulate"},{...req,query:{...query,usuarioId:"other"}}]){
    const rejected=response();rejected.set=()=>rejected;
    validate(mutation,rejected,()=>assert.fail("must reject"));
    assert.equal(rejected.statusCode,400);
  }
});
