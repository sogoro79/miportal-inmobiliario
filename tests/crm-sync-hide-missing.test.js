import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import express from "express";
import jwt from "jsonwebtoken";
import { Readable, Writable, PassThrough } from "node:stream";
import Usuario from "../models/Usuario.js";
import Propiedad from "../models/Propiedad.js";
import ImportSyncRun from "../models/ImportSyncRun.js";
import { createCrmImportRouter } from "../routes/crmImport.js";
import { createMissingHider } from "../utils/import/syncHideMissing.js";
import { buildSyncSnapshot } from "../utils/import/syncSnapshot.js";
import { prepareSyncPlan, snapshotDigest, runVersions, safeRunSummary, evaluateRunApplyEligibility, evaluateRunNewImportEligibility } from "../utils/import/syncPlan.js";
import { managedFingerprint } from "../utils/import/syncBaseline.js";
import { encryptFeedUrl } from "../utils/import/feedUrlCrypto.js";
import { capturePropertyContent } from "../utils/propertyContent.js";
import { aplicarLimitesPlanTrasTrial } from "../utils/trialPlanLimits.js";
import { propiedadCreateSchema, propiedadUpdateSchema } from "../utils/propertySchemas.js";

const U = "000000000000000000000001", S = "000000000000000000000002", R = "000000000000000000000003";
const env = { CRM_FEED_URL_KEY_V1: crypto.randomBytes(32).toString("base64") };
const feed = `<properties><property><id>PRESENT</id><title>Casa</title><price>1</price><operation>venta</operation><address>Direccion</address><bedrooms>2</bedrooms></property></properties>`;
function values(doc, path) {
  if (!path.length) return Array.isArray(doc) ? doc.flatMap(d => values(d, [])) : [doc];
  return Array.isArray(doc) ? doc.flatMap(d => values(d, path)) : values(doc?.[path[0]], path.slice(1));
}
const eq = (a,b) => a instanceof Date && b instanceof Date ? +a === +b : String(a) === String(b);
function matches(doc, filter) {
  return Boolean(doc) && Object.entries(filter).every(([key,v]) => {
    if (key === "$or") return v.some(f => matches(doc,f));
    const actual = values(doc,key.split("."));
    if (v && typeof v === "object" && !(v instanceof Date)) return Object.entries(v).every(([op,expected]) => {
      if (op === "$in") return actual.some(a => expected.some(e => eq(a,e)));
      if (op === "$gt") return actual.some(a => a > expected);
      if (op === "$exists") return actual.some(a => a !== undefined) === expected;
      if (op === "$lte") return actual.some(a => a <= expected);
      return false;
    });
    return v === null ? actual.some(a => a == null) : actual.some(a => eq(a,v));
  });
}
function set(doc,key,value) {
  const parts = key.split("."); let target = doc;
  for (const p of parts.slice(0,-1)) target = target[p] ||= {};
  target[parts.at(-1)] = structuredClone(value);
}
function update(doc, operation) {
  for (const [key,v] of Object.entries(operation.$set || {})) set(doc,key,v);
  for (const [key,v] of Object.entries(operation.$inc || {})) set(doc,key,(values(doc,key.split("."))[0] || 0) + v);
  for (const key of Object.keys(operation.$unset || {})) delete doc[key];
}
function harness(count = 1) {
  let clock = new Date(), xml = feed, tx, before = () => {}, pause, zeroAt, writes = 0, attempts = 0, retries = false, unknown;
  const snapshot = buildSyncSnapshot(xml);
  const state = { source: { _id: S, usuarioId: U, activo: true, feedType: "generic_xml", ...encryptFeedUrl("https://feeds.example/catalog.xml",env) },
    user: { _id: U, activo: true, plan: "vip" }, recs: [],
    props: Array.from({ length: count }, (_,i) => {
      const p = { _id: String(i + 10).padStart(24,"0"), usuarioId: U, importSourceId: S, source: "crm", externalId: `ABSENT-${i}`,
        titulo: "Casa", descripcion: "Descripcion", precio: 198000, direccion: "Direccion", habitaciones: 2,
        banos: 1, superficie: 72, imagenes: ["stored-image"], visiblePublicamente: true, syncEnabled: true,
        syncApplyFingerprintVersion: 1, contentRevision: 3, syncOverrides: {}, visitas: 7, contactos: 2 };
      p.syncApplyFingerprint = managedFingerprint(p); return p;
    }) };
  const plan = prepareSyncPlan(snapshot,state.props,{ usuarioId: U, importSourceId: S, reconciliations: [] });
  state.run = { _id: R, usuarioId: U, importSourceId: S, status: "simulated", snapshotComplete: true,
    sourceIdentityHash: state.source.feedUrlHash, snapshotDigest: snapshotDigest(snapshot), ...runVersions,
    expiresAt: new Date(+clock + 1200000), ...plan, planTruncated: false };
  const current = session => session && tx ? tx : state;
  const queries = [], propertyWrites = [];
  function query(fn) { let session; return { select() { return this; }, lean() { return this; },
    session(s) { session = s; return this; }, then(resolve,reject) { return Promise.resolve().then(() => structuredClone(fn(current(session)))).then(resolve,reject); } }; }
  const sources = {
    findOne(f) { return query(s => matches(s.source,f) ? s.source : null); },
    async findOneAndUpdate(f,u) { if (!matches(state.source,f)) return null; update(state.source,u); return structuredClone(state.source); },
    async updateOne(f,u,o = {}) { const s = current(o.session).source; if (!matches(s,f)) return { matchedCount: 0, modifiedCount: 0 };
      update(s,u); return { matchedCount: 1, modifiedCount: 1 }; }
  };
  const props = {
    find(f) { queries.push(f); return query(s => s.props.filter(p => matches(p,f))); },
    async updateOne(f,u,o) {
      assert.ok(o.session); propertyWrites.push({ f,u }); attempts++;
      if (attempts === zeroAt) return { modifiedCount: 0 };
      const p = current(o.session).props.find(p => matches(p,f));
      if (!p) return { modifiedCount: 0 }; update(p,u); writes++; return { modifiedCount: 1 };
    },
    async startSession() { return { async withTransaction(callback) {
      before(state); tx = structuredClone(state);
      try {
        await callback();
        if (retries) { tx = structuredClone(state); await callback(); }
        if (unknown === "before") throw Object.assign(new Error("unknown"),{ errorLabels: ["UnknownTransactionCommitResult"] });
        Object.assign(state,tx);
        if (unknown === "after") throw Object.assign(new Error("unknown"),{ errorLabels: ["UnknownTransactionCommitResult"] });
      } finally { tx = undefined; }
    }, async endSession() {} }; }
  };
  const runs = {
    findOne(f) { return query(s => matches(s.run,f) ? s.run : null); },
    async updateOne(f,u,o = {}) { const s = current(o.session); if (!matches(s.run,f)) return { modifiedCount: 0 };
      update(s.run,u); return { modifiedCount: 1 }; }
  };
  let fetches = 0;
  const deps = { PropiedadModel: props, ImportSourceModel: sources, ImportSyncRunModel: runs,
    UsuarioModel: { findOne: f => query(s => matches(s.user,f) ? s.user : null) },
    ReconciliationModel: { find: f => query(s => s.recs.filter(r => matches(r,f))) }, env, now: () => new Date(clock),
    fetchXml: async () => { fetches++; if (pause) await pause(); return { xml }; } };
  return { state, deps, queries, propertyWrites, hide: createMissingHider(deps),
    request: { usuarioId: U, runId: R, externalIds: state.props.map(p => p.externalId) },
    get writes() { return writes; }, get fetches() { return fetches; },
    before(fn) { before = fn; }, feed(value) { xml = value; }, advance(ms) { clock = new Date(+clock + ms); },
    pause(fn) { pause = fn; }, zero(n) { zeroAt = n; }, retry() { retries = true; }, unknown(where) { unknown = where; } };
}

test("valid atomic MISSING hide modifies only visibility, causal metadata and revision", async () => {
  const h = harness(2), before = structuredClone(h.state);
  const r = await h.hide(h.request);
  assert.equal(r.status,"completed"); assert.equal(r.countHidden,2); assert.equal(r.countAlreadyHidden,0);
  for (let i=0;i<2;i++) {
    const p = h.state.props[i]; assert.equal(p.visiblePublicamente,false); assert.equal(p.hiddenByMissingRunId,R);
    assert.ok(p.removedFromFeedAt instanceof Date); assert.equal(p.contentRevision,4);
    assert.deepEqual({ ...capturePropertyContent(p), visiblePublicamente: true },capturePropertyContent(before.props[i]));
    assert.deepEqual(p.imagenes,before.props[i].imagenes); assert.deepEqual(p.syncOverrides,{});
    assert.equal(p.syncApplyFingerprint,before.props[i].syncApplyFingerprint); assert.equal(p.visitas,7);
  }
  assert.deepEqual(h.state.user,before.user);
  assert.doesNotMatch(JSON.stringify(r), /operationId|propiedadId|importSourceId|Fingerprint|Revision|Evidence/);
  assert.deepEqual(safeRunSummary(h.state.run).missingHide.status,"completed");
});
test("same completed selection is read-only even after expiry; different selection is rejected", async () => {
  const h = harness(2), r = await h.hide(h.request), before = structuredClone(h.state), writes = h.writes, fetches = h.fetches;
  h.advance(3600000);
  assert.deepEqual(await h.hide({ ...h.request, externalIds: [...h.request.externalIds].reverse() }),r);
  assert.equal(h.writes,writes); assert.equal(h.fetches,fetches); assert.deepEqual(h.state,before);
  await assert.rejects(() => h.hide({ ...h.request, externalIds: ["ABSENT-0"] }),{ code: "MISSING_SELECTION_MISMATCH" });
});
for (const status of ["preparing","applying","indeterminate","failed"]) test(`${status} receipt blocks automatic retry`, async () => {
  const h = harness(); h.state.run.missingHide = { status, operationId: "old", selectedExternalIds: h.request.externalIds, results: [] };
  await assert.rejects(() => h.hide(h.request),{ code: status === "indeterminate" ? "MISSING_UNCONFIRMED" : status === "failed" ? "MISSING_OPERATION_BLOCKED" : "MISSING_IN_PROGRESS" });
  assert.equal(h.fetches,0); assert.equal(h.writes,0);
});
const runCases = [
  ["expired", h => h.advance(1200001), "MISSING_RUN_EXPIRED"],
  ["incomplete", h => { h.state.run.snapshotComplete = false; }, "MISSING_SNAPSHOT_INCOMPLETE"],
  ["truncated", h => { h.state.run.planTruncated = true; }, "MISSING_RUN_TRUNCATED"],
  ["UPDATE consumed run", h => { h.state.run.status = "applied"; }, "MISSING_OPERATION_BLOCKED"],
  ["NEW consumed run", h => { h.state.run.newImport = { status: "completed" }; }, "MISSING_OPERATION_BLOCKED"],
  ["legacy evidence", h => { delete h.state.run.plan.find(e => e.type === "MISSING").missingEvidence; }, "MISSING_RUN_CHANGED"],
  ["wrong evidence owner", h => { h.state.run.plan.find(e => e.type === "MISSING").missingEvidence.usuarioId = S; }, "MISSING_RUN_CHANGED"],
  ["wrong evidence source", h => { h.state.run.plan.find(e => e.type === "MISSING").missingEvidence.importSourceId = U; }, "MISSING_RUN_CHANGED"],
  ["unchecked reconciliation", h => { h.state.run.plan.find(e => e.type === "MISSING").missingEvidence.reconciliationChecked = false; }, "MISSING_RUN_CHANGED"],
  ["invalid baseline evidence", h => { h.state.run.plan.find(e => e.type === "MISSING").missingEvidence.expectedBaselineFingerprint = "bad"; }, "MISSING_RUN_CHANGED"],
  ["invalid baseline version", h => { h.state.run.plan.find(e => e.type === "MISSING").missingEvidence.baselineVersion = 2; }, "MISSING_RUN_CHANGED"],
  ["invalid content hash", h => { h.state.run.plan.find(e => e.type === "MISSING").missingEvidence.expectedContentFingerprint = "bad"; }, "MISSING_RUN_CHANGED"],
  ["foreign run", h => { h.state.run.usuarioId = S; }, "SYNC_RUN_NOT_FOUND"],
  ["foreign source", h => { h.state.source.usuarioId = S; }, "SYNC_SOURCE_NOT_FOUND"],
  ["inactive source", h => { h.state.source.activo = false; }, "SYNC_SOURCE_NOT_FOUND"],
  ["source hash changed", h => { h.state.source.feedUrlHash = "b".repeat(64); }, "MISSING_RUN_CHANGED"],
  ["inactive user", h => { h.state.user.activo = false; }, "MISSING_USER_INACTIVE"]
];
for (const [name,mutate,code] of runCases) test(`${name} blocks without property writes`, async () => {
  const h = harness(); mutate(h); const before = structuredClone(h.state.props);
  await assert.rejects(() => h.hide(h.request),{ code }); assert.equal(h.writes,0); assert.deepEqual(h.state.props,before);
});
for (const [name,mutate] of [
  ["deleted", s => { s.props=[]; }], ["owner", s => { s.props[0].usuarioId=S; }],
  ["source reassignment", s => { s.props[0].importSourceId=U; }], ["manual source", s => { s.props[0].source="manual"; }],
  ["externalId", s => { s.props[0].externalId="OTHER"; }], ["property ID", s => { s.props[0]._id=S; }],
  ["revision", s => { s.props[0].contentRevision++; }], ["visibility", s => { s.props[0].visiblePublicamente=false; }],
  ["override", s => { s.props[0].syncOverrides.descripcion=true; }],
  ["baseline", s => { s.props[0].syncApplyFingerprint="bad"; }], ["unenrolled", s => { s.props[0].syncEnabled=false; }],
  ["photos changed", s => { s.props[0].imagenes.push("different-image"); }],
  ["other missing cause", s => { s.props[0].removedFromFeedAt=new Date(); s.props[0].hiddenByMissingRunId=S; }]
]) test(`current property ${name} changed aborts atomically`, async () => {
  const h = harness(); h.before(mutate);
  await assert.rejects(() => h.hide(h.request),{ code:"MISSING_PROPERTY_CHANGED" });
  assert.equal(h.writes,0); assert.equal(h.state.run.missingHide.status,"failed");
  assert.ok(h.state.run.missingHide.results.every(r => r.status === "failed"));
});
test("pending reconciliation blocks regardless of journal state", async () => {
  const h = harness(); h.state.recs.push({ propiedadId:h.state.props[0]._id,state:"prepared" });
  await assert.rejects(() => h.hide(h.request),{ code:"MISSING_RECONCILIATION_PENDING" }); assert.equal(h.writes,0);
});
for (const [name,xml,code] of [
  ["changed digest",feed.replace("<price>1</price>","<price>2</price>"),"MISSING_FEED_CHANGED"],
  ["reappeared",feed.replace("PRESENT","ABSENT-0"),"MISSING_REAPPEARED"],
  ["empty/incomplete","<properties/>","MISSING_SNAPSHOT_INCOMPLETE"]
]) test(`${name} refetch blocks before operation intent`, async () => {
  const h = harness(); h.feed(xml); await assert.rejects(() => h.hide(h.request),{ code });
  assert.equal(h.state.run.missingHide,undefined); assert.equal(h.writes,0);
});
test("second property conditional write fails: rollback preserves first and receipt records failure", async () => {
  const h=harness(2), before=structuredClone(h.state.props); h.zero(2);
  await assert.rejects(() => h.hide(h.request),{ code:"MISSING_PROPERTY_CHANGED" }); assert.deepEqual(h.state.props,before);
  assert.equal(h.state.run.missingHide.status,"failed"); assert.equal(safeRunSummary(h.state.run).missingHide.countHidden,0);
});
test("transaction callback retry performs only database work and increments once", async () => {
  const h=harness(2); h.retry(); await h.hide(h.request);
  assert.equal(h.fetches,1); assert.ok(h.state.props.every(p => p.contentRevision===4));
});
test("already hidden by this exact run preserves revision and records already_hidden", async () => {
  const h=harness(); h.state.props[0].visiblePublicamente=false; h.state.props[0].hiddenByMissingRunId=R;
  h.state.props[0].removedFromFeedAt=new Date(); h.state.props[0].contentRevision++;
  const r=await h.hide(h.request); assert.equal(r.countAlreadyHidden,1); assert.equal(r.countHidden,0); assert.equal(h.writes,0);
});
for (const where of ["before","after"]) test(`unknown commit ${where}: no automatic retry or overwrite of confirmed receipt`, async () => {
  const h=harness(); h.unknown(where);
  await assert.rejects(() => h.hide(h.request),{ code:"MISSING_UNCONFIRMED",status:503 });
  assert.equal(h.state.run.missingHide.status,where==="after" ? "completed" : "indeterminate");
  assert.equal(h.state.props[0].visiblePublicamente,where==="before");
  const fetches=h.fetches;
  if(where==="after") assert.equal((await h.hide(h.request)).status,"completed");
  else await assert.rejects(() => h.hide(h.request),{ code:"MISSING_UNCONFIRMED" });
  assert.equal(h.fetches,fetches);
});
test("source lock prevents two hides and rejects lock lost before transaction", async () => {
  const h=harness(); let release, ready;
  const blocked=new Promise(resolve => { release=resolve; }), started=new Promise(resolve => { ready=resolve; });
  h.pause(async()=>{ ready(); await blocked; });
  const first=h.hide(h.request); await started;
  await assert.rejects(() => h.hide(h.request),{ code:"SYNC_SOURCE_BUSY" }); release(); await first;
  const lost=harness(); lost.before(s=>{ s.source.importLockToken="other"; });
  await assert.rejects(() => lost.hide(lost.request),{ code:"SYNC_SOURCE_BUSY" }); assert.equal(lost.writes,0);
});
test("hide receipt blocks later UPDATE and NEW, safe GET never leaks internal metadata", async () => {
  const h=harness(); await h.hide(h.request);
  assert.equal(evaluateRunApplyEligibility(h.state.run).applyEligible,false);
  assert.equal(evaluateRunNewImportEligibility(h.state.run).newImportEligible,false);
  const safe=safeRunSummary({ ...h.state.run, missingHide:{ ...h.state.run.missingHide, secret:"private", results:[{ externalId:"ABSENT-0",status:"hidden",propiedadId:S,hash:"secret" }] } });
  assert.doesNotMatch(JSON.stringify(safe),/operationId|missingEvidence|expectedContent|private|secret|propiedadId/);
});
test("reappearance simulation keeps hidden property, images and causal marker unchanged", async () => {
  const h=harness(); await h.hide(h.request);
  const before=structuredClone(h.state.props);
  const snapshot=buildSyncSnapshot(feed.replace("PRESENT","ABSENT-0"));
  const plan=prepareSyncPlan(snapshot,h.state.props,{usuarioId:U,importSourceId:S,reconciliations:[]});
  assert.equal(plan.missingCount,0);assert.equal(plan.newCount,0);
  assert.deepEqual(h.state.props,before);assert.equal(h.state.props[0].visiblePublicamente,false);
  assert.equal(h.state.props[0].hiddenByMissingRunId,R);
});

function http(app,path,{ method="POST",body,auth=true }={}) {
  return new Promise((resolve,reject)=>{
    const payload=body===undefined ? "" : JSON.stringify(body);
    const req=new Readable({ read(){ this.push(payload); this.push(null); } });
    Object.assign(req,{ method,url:path,originalUrl:path,complete:true,headers:{ "content-type":"application/json","content-length":String(Buffer.byteLength(payload)),
      ...(auth ? {authorization:`Bearer ${jwt.sign({id:U},"missing-test-secret")}`} : {}) },socket:new PassThrough() });
    req.socket.remoteAddress="127.0.0.1"; req.connection=req.socket;
    const chunks=[],headers={}; const res=new Writable({ write(c,e,cb){chunks.push(Buffer.from(c));cb();} });res.statusCode=200;
    res.setHeader=(k,v)=>headers[k.toLowerCase()]=v;res.getHeader=k=>headers[k.toLowerCase()];res.removeHeader=k=>delete headers[k.toLowerCase()];
    const end=res.end.bind(res);res.end=c=>{if(c)chunks.push(Buffer.from(c));end();resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString())});};
    app.handle(req,res,reject);
  });
}
test("HTTP auth/strict contract/GET lost-response recovery; only runId and externalIds accepted", async () => {
  const h=harness(), previous=Usuario.findById, secret=process.env.JWT_SECRET;
  Usuario.findById=async()=>h.state.user;process.env.JWT_SECRET="missing-test-secret";
  const app=express(),pass=(req,res,next)=>next();app.use(express.json());
  app.use("/api/crm-import",createCrmImportRouter({ ...h.deps,hideMissingSync:h.hide,
    hideMissingRateLimitMiddleware:pass,hideMissingUserRateLimitMiddleware:pass }));
  const path="/api/crm-import/sync/hide-missing", body={runId:R,externalIds:["ABSENT-0"]};
  try {
    assert.equal((await http(app,path,{body,auth:false})).status,401);
    for(const invalid of [{...body,propertyIds:[S]},{...body,sourceId:S},{...body,visiblePublicamente:false},{...body,bypass:true},
      {...body,usuarioId:U},{...body,externalIds:[]},{...body,externalIds:["ABSENT-0","ABSENT-0"]},
      {...body,externalIds:Array.from({length:11},(_,i)=>`ABSENT-${i}`)},{externalIds:["ABSENT-0"]}])
      assert.equal((await http(app,path,{body:invalid})).status,400);
    assert.equal((await http(app,path,{body:{...body,runId:S}})).status,404);
    assert.equal((await http(app,path,{body})).status,200);
    const recovered=await http(app,`/api/crm-import/sync/runs/${R}`,{method:"GET"});
    assert.equal(recovered.status,200);assert.equal(recovered.body.missingHide.status,"completed");
    assert.equal(recovered.body.missingHide.countHidden,1);
    assert.doesNotMatch(JSON.stringify(recovered.body),/operationId|missingEvidence|hiddenByMissingRunId|Fingerprint|contentRevision/);
    h.state.user.activo=false;assert.equal((await http(app,path,{body})).status,403);
  } finally { Usuario.findById=previous;if(secret===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=secret; }
});
test("marker is private, ignored by ordinary input schemas, and no forbidden side effects in service", () => {
  assert.equal(Propiedad.schema.path("hiddenByMissingRunId").options.select,false);
  assert.equal(new ImportSyncRun().missingHide,undefined);
  const base={titulo:"Casa",precio:1,tipoOperacion:"venta",direccion:"Direccion",habitaciones:2};
  assert.equal(propiedadCreateSchema.parse({...base,hiddenByMissingRunId:R}).hiddenByMissingRunId,undefined);
  assert.equal(propiedadUpdateSchema.parse({...base,hiddenByMissingRunId:R}).hiddenByMissingRunId,undefined);
  const code=fs.readFileSync(new URL("../utils/import/syncHideMissing.js",import.meta.url),"utf8");
  assert.doesNotMatch(code,/Cloudinary|deleteOne|deleteMany|findByIdAndDelete|Notificacion|Conversacion|Mensaje|enviarCorreo/i);
});

test("plan recovery keeps MISSING hidden, normal recovery intact, and stale read cannot republish", async () => {
  const oldFind=Propiedad.find,oldUpdate=Propiedad.updateOne;
  try {
    for(const race of [false,true]) {
      const normal={_id:S,usuarioId:U,visiblePublicamente:false,estadoComercial:"Disponible",updatedAt:new Date(),save:()=>assert.fail("normal recovery must be conditional")};
      const hidden={_id:R,usuarioId:U,visiblePublicamente:false,hiddenByMissingRunId:R,estadoComercial:"Disponible"};
      let selected=false,updates=0;
      Propiedad.find=()=>({select(fields){assert.match(fields,/hiddenByMissingRunId/);selected=true;return Promise.resolve([normal,hidden]);}});
      Propiedad.updateOne=async(f,u)=>{
        updates++; assert.equal(f.hiddenByMissingRunId,null);assert.equal(f._id,S);
        if(race){normal.hiddenByMissingRunId=R;return {matchedCount:0};}
        Object.assign(normal,u.$set);return {matchedCount:1};
      };
      const session = { withTransaction: async callback => callback(), endSession: async () => {} };
      const result=await aplicarLimitesPlanTrasTrial(U,{repararSiNoHayVisibles:true,
        UsuarioModel: { startSession: async () => session, updateOne: async () => ({ matchedCount: 1 }),
          findById: () => ({ session() { return Promise.resolve({ _id: U, plan: "gratis", activo: true }); } }) },
        PropiedadModel: { find: Propiedad.find, updateOne: Propiedad.updateOne,
          countDocuments: () => ({ session() { return Promise.resolve(0); } }) }
      });
      assert.equal(selected,true);assert.equal(updates,1);assert.equal(hidden.visiblePublicamente,false);
      assert.equal(normal.visiblePublicamente,!race);assert.equal(result.propiedadesRecuperadas,race?0:1);
    }
  } finally { Propiedad.find=oldFind;Propiedad.updateOne=oldUpdate; }
});
