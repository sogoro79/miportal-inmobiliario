import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import express from "express";
import jwt from "jsonwebtoken";
import { Readable, Writable, PassThrough } from "node:stream";
import { XMLValidator } from "fast-xml-parser";
import Usuario from "../models/Usuario.js";
import ImportSyncRun from "../models/ImportSyncRun.js";
import { analyzeGenericXml } from "../utils/importers/genericXmlImporter.js";
import { buildSyncSnapshot } from "../utils/import/syncSnapshot.js";
import { compareSyncSnapshot } from "../utils/import/syncDiff.js";
import { prepareSyncPlan, safeRunSummary } from "../utils/import/syncPlan.js";
import { validateImportProperty } from "../utils/import/selectedImport.js";
import { buildPropiedadCreateData } from "../utils/propertyCreation.js";
import { capturePropertyContent } from "../utils/propertyContent.js";
import { managedFingerprint } from "../utils/import/syncBaseline.js";
import { encryptFeedUrl } from "../utils/import/feedUrlCrypto.js";
import { createSyncSimulator } from "../utils/import/syncSimulation.js";
import { createMissingHider } from "../utils/import/syncHideMissing.js";
import { createCrmImportRouter } from "../routes/crmImport.js";

const BASE_URL="https://www.homeclick24.com/test-sync-missing/homeclick24-missing-base.xml";
const E="SYNC-MISSING-TEST-001", CONTROL="SYNC-MISSING-CONTROL-001";
const base=fs.readFileSync(new URL("../public/test-sync-missing/homeclick24-missing-base.xml",import.meta.url),"utf8");
const absent=fs.readFileSync(new URL("../public/test-sync-missing/homeclick24-missing-empty.xml",import.meta.url),"utf8");
const U="000000000000000000000001",S="000000000000000000000002",P="000000000000000000000003",R="000000000000000000000004";
function enrolled() {
  const parsed=validateImportProperty(analyzeGenericXml(base)[0]);assert.deepEqual(parsed.errors,[]);
  const p={...buildPropiedadCreateData(parsed.data,{usuarioId:U,plan:"vip"}),_id:P,source:"crm",externalId:E,importSourceId:S,
    visiblePublicamente:true,syncEnabled:true,syncOverrides:{},contentRevision:0,syncApplyFingerprintVersion:1};
  p.syncApplyFingerprint=managedFingerprint(p);return p;
}
test("BASE is valid, exactly one publicable target, mapper and snapshot have same semantics",()=>{
  assert.equal(XMLValidator.validate(base),true);
  const snapshot=buildSyncSnapshot(base),mapped=analyzeGenericXml(base);
  assert.equal(snapshot.snapshotComplete,true);assert.equal(snapshot.properties.length,1);assert.equal(mapped.length,1);
  assert.equal(snapshot.properties[0].data.externalId,E);
  const p=enrolled();
  for(const [field,expected] of Object.entries({titulo:"Piso de prueba MISSING CRM en Rota",precio:214000,tipoOperacion:"venta",
    tipoInmueble:"piso",estado:"segunda_mano",habitaciones:3,banos:2,superficie:88,localidad:"Rota",provincia:"Cádiz",
    direccion:"Dirección de prueba MISSING",terraza:true,garaje:false,piscina:false})) {
    assert.equal(p[field],expected,field);assert.equal(snapshot.properties[0].data[field],expected,field);
  }
  assert.equal(compareSyncSnapshot(snapshot,[]).results[0].publishableByData,true);
  const baselinePlan=prepareSyncPlan(snapshot,[p],{usuarioId:U,importSourceId:S,reconciliations:[]});
  assert.equal(baselinePlan.plan[0].type,"UNCHANGED");assert.equal(baselinePlan.plan[0].linked,true);
  assert.deepEqual(mapped[0].fotos,[]);assert.deepEqual(p.imagenes,[]);assert.equal(p.videoUrl,"");
  assert.doesNotMatch(base,/[a-f0-9]{24}|https?:\/\/|@|usuarioId|userId|ownerId|importSourceId/i);
});
test("MISSING fixture uses one distinct control, not an incomplete literal empty feed",()=>{
  assert.equal(XMLValidator.validate(absent),true);
  const snapshot=buildSyncSnapshot(absent);
  assert.equal(snapshot.snapshotComplete,true);assert.equal(snapshot.properties.length,1);
  assert.equal(snapshot.properties[0].data.externalId,CONTROL);
  assert.ok(snapshot.properties.every(p=>p.data.externalId!==E));
  assert.deepEqual(analyzeGenericXml(absent)[0].fotos,[]);
  assert.equal(buildSyncSnapshot("<properties/>").snapshotComplete,false);
});
test("enrolled target absent from complete feed is MISSING and safely eligible",()=>{
  const snapshot=buildSyncSnapshot(absent),p=enrolled();
  const diff=compareSyncSnapshot(snapshot,[p]);
  assert.equal(diff.results.find(r=>r.externalId===E).type,"MISSING");
  assert.equal(diff.results.find(r=>r.externalId===E).protected,false);
  const plan=prepareSyncPlan(snapshot,[p],{usuarioId:U,importSourceId:S,reconciliations:[]});
  const missing=plan.plan.find(r=>r.externalId===E);
  assert.equal(missing.hideMissingEligible,true);assert.equal(missing.hideMissingBlockCode,null);assert.equal(missing.blocked,true);
  assert.equal(plan.newCount,1);assert.equal(plan.missingCount,1);
});

const eq=(a,b)=>a instanceof Date&&b instanceof Date ? +a===+b : String(a)===String(b);
function matches(doc,filter) {
  return Boolean(doc)&&Object.entries(filter).every(([k,v])=>{
    if(k==="$or")return v.some(f=>matches(doc,f));
    const actual=k.split(".").reduce((p,key)=>p?.[key],doc);
    if(v&&typeof v==="object"&&!(v instanceof Date))return Object.entries(v).every(([op,e])=>
      op==="$in"?e.some(value=>eq(actual,value)):op==="$gt"?actual>e:op==="$lte"?actual<=e:op==="$exists"?(actual!==undefined)===e:false);
    return v===null?actual==null:eq(actual,v);
  });
}
function update(doc,op) {
  for(const [key,value] of Object.entries(op.$set||{})) {
    const parts=key.split(".");let target=doc;
    for(const p of parts.slice(0,-1))target=target[p]||={};target[parts.at(-1)]=structuredClone(value);
  }
  for(const [k,v] of Object.entries(op.$inc||{}))doc[k]=(doc[k]||0)+v;
  for(const k of Object.keys(op.$unset||{}))delete doc[k];
}
function harness() {
  const env={CRM_FEED_URL_KEY_V1:crypto.randomBytes(32).toString("base64")};
  const state={source:{_id:S,usuarioId:U,activo:true,feedType:"generic_xml",...encryptFeedUrl(BASE_URL,env)},property:enrolled(),user:{_id:U,activo:true}};
  let tx,propertyWrites=0,fetches=0;
  const current=session=>session?tx:state;
  function query(fn){let session;return{select(){return this;},lean(){return this;},limit(){return this;},session(s){session=s;return this;},
    then(resolve,reject){return Promise.resolve().then(()=>structuredClone(fn(current(session)))).then(resolve,reject);}};}
  const sources={findOne:f=>query(s=>matches(s.source,f)?s.source:null),
    async findOneAndUpdate(f,op){if(!matches(state.source,f))return null;update(state.source,op);return structuredClone(state.source);},
    async updateOne(f,op,o={}){const s=current(o.session);if(!matches(s.source,f))return{matchedCount:0};update(s.source,op);return{matchedCount:1};}};
  const properties={find:f=>query(s=>matches(s.property,f)?[s.property]:[]),
    async updateOne(f,op,o){assert.ok(o.session);const s=current(o.session);if(!matches(s.property,f))return{modifiedCount:0};
      propertyWrites++;update(s.property,op);return{modifiedCount:1};},
    async startSession(){return{async withTransaction(fn){tx=structuredClone(state);try{await fn();Object.assign(state,tx);}finally{tx=undefined;}},async endSession(){}};}};
  const runs={async create(data){assert.equal(new ImportSyncRun({_id:R,...data}).validateSync(),undefined);
      state.run={_id:R,...data};return state.run;},
    findOne:f=>query(s=>matches(s.run,f)?s.run:null),
    async updateOne(f,op,o={}){const s=current(o.session);if(!matches(s.run,f))return{modifiedCount:0};update(s.run,op);return{modifiedCount:1};}};
  const deps={env,ImportSourceModel:sources,PropiedadModel:properties,ImportSyncRunModel:runs,
    UsuarioModel:{findOne:f=>query(s=>matches(s.user,f)?s.user:null)},ReconciliationModel:{find:()=>query(()=>[])},
    fetchXml:async url=>{assert.equal(url,BASE_URL);fetches++;return{xml:absent};}};
  return{state,deps,simulate:createSyncSimulator(deps),hide:createMissingHider(deps),get writes(){return propertyWrites;},get fetches(){return fetches;}};
}
function http(app,path,{method="POST",body,auth=true}={}) {
  return new Promise((resolve,reject)=>{
    const payload=body===undefined?"":JSON.stringify(body),req=new Readable({read(){this.push(payload);this.push(null);}});
    Object.assign(req,{method,url:path,originalUrl:path,complete:true,headers:{"content-type":"application/json","content-length":String(Buffer.byteLength(payload)),
      ...(auth?{authorization:`Bearer ${jwt.sign({id:U},"controlled-missing-test")}`}:{})},socket:new PassThrough()});
    req.socket.remoteAddress="127.0.0.1";req.connection=req.socket;
    const chunks=[],headers={},res=new Writable({write(c,e,cb){chunks.push(Buffer.from(c));cb();}});res.statusCode=200;
    res.setHeader=(k,v)=>headers[k.toLowerCase()]=v;res.getHeader=k=>headers[k.toLowerCase()];res.removeHeader=k=>delete headers[k.toLowerCase()];
    const end=res.end.bind(res);res.end=c=>{if(c)chunks.push(Buffer.from(c));end();resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString())});};
    app.handle(req,res,reject);
  });
}
test("controlled complete simulator -> HTTP hide -> replay -> safe GET, no deletes or content changes",async()=>{
  const h=harness(),before=structuredClone(h.state.property),secret=process.env.JWT_SECRET,old=Usuario.findById;
  process.env.JWT_SECRET="controlled-missing-test";Usuario.findById=async()=>h.state.user;
  const app=express(),pass=(req,res,next)=>next();app.use(express.json());
  app.use("/api/crm-import",createCrmImportRouter({...h.deps,simulateSync:h.simulate,hideMissingSync:h.hide,
    rateLimitMiddleware:pass,userRateLimitMiddleware:pass,hideMissingRateLimitMiddleware:pass,hideMissingUserRateLimitMiddleware:pass}));
  try {
    const simulated=await http(app,"/api/crm-import/sync/simulate",{body:{importSourceId:S}});
    assert.equal(simulated.status,200);
    const entry=simulated.body.results.find(r=>r.externalId===E);
    assert.equal(entry.type,"MISSING");assert.equal(entry.hideMissingEligible,true);assert.equal(entry.hideMissingBlockCode,null);
    assert.equal(h.writes,0);
    const body={runId:R,externalIds:[E]},path="/api/crm-import/sync/hide-missing";
    const hidden=await http(app,path,{body});assert.equal(hidden.status,200);assert.equal(hidden.body.status,"completed");assert.equal(hidden.body.countHidden,1);
    const p=h.state.property;assert.equal(p._id,P);assert.equal(p.visiblePublicamente,false);assert.equal(p.hiddenByMissingRunId,R);
    assert.ok(p.removedFromFeedAt instanceof Date);assert.equal(p.contentRevision,before.contentRevision+1);
    assert.deepEqual({...capturePropertyContent(p),visiblePublicamente:true},capturePropertyContent(before));assert.deepEqual(p.imagenes,[]);
    const persisted=structuredClone(h.state),writes=h.writes,fetches=h.fetches;
    assert.deepEqual(await http(app,path,{body}),hidden);assert.equal(h.writes,writes);assert.equal(h.fetches,fetches);assert.deepEqual(h.state,persisted);
    const receipt=await http(app,`/api/crm-import/sync/runs/${R}`,{method:"GET"});assert.equal(receipt.status,200);
    assert.equal(receipt.body.missingHide.status,"completed");assert.equal(receipt.body.missingHide.countHidden,1);
    assert.deepEqual(receipt.body.missingHide,JSON.parse(JSON.stringify(safeRunSummary(h.state.run).missingHide)));
    assert.doesNotMatch(JSON.stringify(receipt.body),/missingEvidence|Fingerprint|expectedContent|operationId|hiddenByMissingRunId|feedUrlHash/);
  } finally {Usuario.findById=old;if(secret===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=secret;}
});
