import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { buildFeedSnapshot } from "../utils/importers/importerRegistry.js";
import { prepareSyncPlan, snapshotDigest, runVersions } from "../utils/import/syncPlan.js";
import { createInmowebRunReader } from "../utils/import/inmowebRunView.js";
import { readInmowebNewReviews, parseNewReviewQuery } from "../utils/import/inmowebNewReview.js";
import { duplicateCandidates } from "../utils/audit/inmowebDuplicateMatcher.js";

const xml = fs.readFileSync(new URL("./fixtures/crm/inmoweb-synthetic.xml", import.meta.url), "utf8");
const snapshot = buildFeedSnapshot(xml, { feedType: "inmoweb" });
const data = snapshot.properties[0].data;
const owner = "507f1f77bcf86cd799439099", sourceId = "507f1f77bcf86cd799439098";
const q = value => ({ select() { return this; }, lean() { return Promise.resolve(value); } });
function setup({ delegated = false, portfolio } = {}) {
  let time = Date.now(), reads = 0, snapshotReads = 0;
  const source = { _id: sourceId, usuarioId: owner, activo: true, feedType: "inmoweb", feedUrlHash: "a".repeat(64) };
  const run = { ...runVersions, ...prepareSyncPlan(snapshot, []), _id: "507f1f77bcf86cd799439097",
    usuarioId: owner, importSourceId: sourceId, sourceIdentityHash: source.feedUrlHash,
    status: "simulated", feedType: "inmoweb", snapshotComplete: false, newSnapshotComplete: true,
    providerNormalizationVersion: 1, snapshotDigest: snapshotDigest(snapshot), expiresAt: new Date(time + 1200000),
    ...(delegated ? { actorAdminId: "admin", delegationId: "grant" } : {}) };
  const properties = portfolio || [{ ...data, _id: "manual", usuarioId: owner, source: "manual", visiblePublicamente: false }];
  const state = { validGrant: true };
  const delegation = delegated ? { actorAdminId: "admin", id: "grant", async assert() {
    if (!state.validGrant) throw new Error("revoked");
  } } : undefined;
  const evidence = { snapshot, expiresAt: new Date(time + 300000), fetchedAt: new Date(time) };
  const model = { find(filter) {
    reads++; assert.deepEqual(filter, { usuarioId: owner });
    return q(properties);
  } };
  const options = { now: () => new Date(time), env: { INMOWEB_NEW_ENABLED: "true", INMOWEB_NEW_ALLOWED_EXTERNAL_IDS: data.externalId },
    PropiedadModel: model, ImportSourceModel: { findOne: () => q(source) },
    ImportSyncRunModel: { findOne: () => q(run) },
    providerSnapshots: { async readPersisted() { snapshotReads++; return evidence; } } };
  return { run, source, properties, delegation, state, model, options, evidence,
    advance: ms => { time += ms; }, reads: () => reads, snapshotReads: () => snapshotReads,
    evaluate: (review = "duplicates") => createInmowebRunReader(options).evaluate(run, owner, source, delegation,
      review ? { externalId: data.externalId, review } : undefined) };
}
test("NEW ficha from bound evidence, manual hidden candidate, no writes or URLs", async () => {
  const h = setup(), before = structuredClone([h.run,h.properties]);
  const dto = await h.evaluate();
  const review = dto.newReviews[0];
  assert.equal(review.fields.externalId, data.externalId);
  assert.equal(review.fields.precio, data.precio);
  assert.equal(review.fields.fotos, 2);
  assert.equal(review.candidates.length, 1);
  assert.ok(review.candidates[0].evidence.includes("mismo precio"));
  assert.deepEqual(review.candidates[0].contradictions, []);
  assert.doesNotMatch(JSON.stringify(dto.newReviews), /https?:|<properties|descripcion|usuarioId|importSourceId|_id|encryptedSnapshot/);
  assert.deepEqual([h.run,h.properties], before);
  assert.equal(h.snapshotReads(),1);
});
test("all owner's sources are searched, foreign tenant excluded, max three", async () => {
  const portfolio = Array.from({length:5},(_,i)=>({...data,_id:String(i),usuarioId:owner,
    source:i===0?"manual":"crm",importSourceId:i===1?"other-source":sourceId,visiblePublicamente:i%2===0}));
  portfolio.unshift({...data,_id:"foreign",usuarioId:"foreign-owner",referencia:"FOREIGN"});
  const h=setup({portfolio});
  const reviews=await readInmowebNewReviews(h.run,snapshot,h.model,{externalId:data.externalId,review:"duplicates"});
  assert.equal(reviews[0].candidates.length,3);
  assert.doesNotMatch(JSON.stringify(reviews),/FOREIGN/);
  const same=duplicateCandidates(data,[portfolio[2]],"other-source")[0];
  const other=duplicateCandidates(data,[portfolio[2]],sourceId)[0];
  assert.equal(same.score-other.score,1);
  assert.ok(!other.evidence.includes("misma referencia normalizada"));
});
test("contradictions are separate readable evidence; no automatic verdict", () => {
  const candidates=duplicateCandidates(data,[{...data,_id:"1",localidad:"Otra",tipoOperacion:"alquiler",
    superficie:900,habitaciones:8,piscina:false}],sourceId);
  assert.ok(candidates[0].contradictions.includes("Localidad distinta"));
  assert.ok(candidates[0].contradictions.includes("Operación distinta"));
  assert.ok(candidates[0].contradictions.includes("Superficie construida distinta"));
  assert.doesNotMatch(JSON.stringify(candidates),/SEGURAMENTE|clasificacion|rank|_id/);
  assert.deepEqual(duplicateCandidates(data,[],sourceId),[]);
});
test("unknown and absent ficha fields do not become false or zero", async () => {
  const h=setup(), snap=structuredClone(snapshot);
  snap.properties[0].reviewUnknown=["garaje","piscina"];
  snap.properties[0].reviewAbsent.push("habitaciones");
  snap.properties[0].data.terraza=false;
  snap.properties[0].data.banos=0;
  const fields=(await readInmowebNewReviews(h.run,snap,h.model,{externalId:data.externalId,review:"ficha"}))[0].fields;
  assert.equal(fields.garaje,undefined); assert.equal(fields.piscina,undefined);
  assert.equal(fields.habitaciones,undefined); assert.equal(fields.terraza,false); assert.equal(fields.banos,0);
});
test("expired run never reads snapshot or portfolio", async () => {
  const h=setup();h.advance(1200001);
  assert.equal((await h.evaluate()).newReviews,undefined);
  assert.equal(h.reads(),0);assert.equal(h.snapshotReads(),0);
});
test("expired snapshot never exposes ficha; no refetch capability", async () => {
  const h=setup();h.advance(300001);
  assert.equal((await h.evaluate()).newReviews,undefined);assert.equal(h.reads(),0);
});
test("delegation revoked initially or during portfolio read blocks new review", async () => {
  const h=setup({delegated:true});h.state.validGrant=false;
  assert.equal((await h.evaluate()).newReviews,undefined);assert.equal(h.reads(),0);
  h.state.validGrant=true;
  h.model.find=()=>{h.state.validGrant=false;return q(h.properties);};
  assert.equal((await h.evaluate()).newReviews,undefined);
});
for(const kind of ["source","run","digest","version","expiry"]) {
  test("revalidates "+kind+" after portfolio read",async()=>{
    const h=setup();
    h.model.find=()=>{
      if(kind==="source") h.options.ImportSourceModel.findOne=()=>q({...h.source,feedUrlHash:"b".repeat(64)});
      if(kind==="run") h.options.ImportSyncRunModel.findOne=()=>q({...h.run,status:"failed"});
      if(kind==="digest") h.options.ImportSyncRunModel.findOne=()=>q({...h.run,snapshotDigest:"b".repeat(64)});
      if(kind==="version") h.options.ImportSyncRunModel.findOne=()=>q({...h.run,normalizationVersion:999});
      if(kind==="expiry") h.advance(300001);
      return q(h.properties);
    };
    assert.equal((await h.evaluate()).newReviews,undefined);
  });
}
test("review cannot change NEW selection, eligibility, or other action contracts",async()=>{
  const h=setup();
  const reviewed=await h.evaluate();
  h.model.find=()=>{throw new Error("portfolio unavailable");};
  const unavailable=await h.evaluate();
  const {newReviews,...rest}=reviewed;
  assert.deepEqual(rest,unavailable);
  assert.equal(reviewed.newImportEligible,true);
  assert.deepEqual(reviewed.results.map(r=>r.externalId),[data.externalId]);
});
test("generic_xml has no new review or extra reads",async()=>{
  const h=setup();h.run.feedType="generic_xml";
  assert.equal((await h.evaluate()).newReviews,undefined);
  assert.equal(h.reads(),0);assert.equal(h.snapshotReads(),0);
});
test("safe titles never leak credentials, HTML or photo URLs",async()=>{
  const h=setup();
  h.properties[0].titulo="Casa <b>privada</b> Bearer SECRET https://example.test/?token=SECRET";
  const dto=await h.evaluate();
  assert.doesNotMatch(JSON.stringify(dto.newReviews),/SECRET|https:|<b>|token=/);
});
test("shared UI rereads, expires, never posts or changes selection",async()=>{
  const h=setup(), dto=await h.evaluate();
  function element(tag){return {tag,children:[],setAttribute(){},append(child){this.children.push(child);},
    replaceChildren(){this.children=[];}};}
  const window={},timers=[];
  vm.runInNewContext(fs.readFileSync(new URL("../public/js/inmoweb-comparison.js",import.meta.url),"utf8"),
    {window,document:{createElement:element},setTimeout(fn){timers.push(fn);}});
  const root=element("div");let reads=0; const requests=[];
  window.renderInmowebNewReview(root,dto,data.externalId,async request=>{reads++;requests.push(request);return dto;});
  const flatten=n=>[n,...n.children.flatMap(flatten)];
  const buttons=flatten(root).filter(n=>n.tag==="button");
  assert.deepEqual(buttons.map(b=>b.textContent),["Ver ficha","Revisar posibles duplicados"]);
  await buttons[0].onclick();assert.equal(reads,1);
  assert.match(flatten(root).map(n=>n.textContent).join(" "),/Número de fotos: 2/);
  await buttons[1].onclick();assert.equal(reads,2);
  assert.deepEqual(JSON.parse(JSON.stringify(requests)),[
    {externalId:data.externalId,review:"ficha"},{externalId:data.externalId,review:"duplicates"}]);
  assert.match(flatten(root).map(n=>n.textContent).join(" "),/Posibles coincidencias/);
  assert.equal(flatten(root).some(n=>["input","img"].includes(n.tag)),false);
  timers[0]();
  assert.match(flatten(root).map(n=>n.textContent).join(" "),/Revisión no disponible. Vuelve a simular./);
  dto.newReviews=undefined;
  await buttons[0].onclick();
  assert.match(flatten(root).map(n=>n.textContent).join(" "),/Revisión no disponible/);
});

test("nine NEW review scores only the requested externalId using one portfolio query", async () => {
  const h = setup();
  const records = Array.from({ length: 9 }, (_, index) => ({
    ...structuredClone(snapshot.properties[0]), data: { ...data, externalId: String(index) }
  }));
  const reviewRun = { ...h.run, plan: records.map(record => ({ type: "NEW", externalId: record.data.externalId })) };
  let queries = 0;
  const model = { find(filter) {
    queries++;
    assert.deepEqual(filter, { usuarioId: owner });
    return { select(projection) {
      assert.ok(projection.includes("descripcion"));
      assert.ok(projection.includes("imagenes"));
      assert.doesNotMatch(projection, /password|email|telefono|syncOverrides/);
      return { lean: async () => h.properties };
    } };
  } };
  const reviews = await readInmowebNewReviews(reviewRun, { ...snapshot, properties: records }, model, {externalId:"0",review:"duplicates"});
  assert.equal(queries, 1);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].externalId,"0");
  assert.ok(reviews.every(review => review.candidates.length <= 3));
});


test("ordinary nine-NEW run view never queries portfolio or scores legacy candidates", async () => {
  const h=setup({portfolio:[{usuarioId:owner,imagenes:{legacy:true}}]});
  const records=Array.from({length:9},(_,i)=>({...structuredClone(snapshot.properties[0]),data:{...data,externalId:String(i)}}));
  h.evidence.snapshot={...snapshot,properties:records,total:9,snapshotCount:9};
  Object.assign(h.run,prepareSyncPlan(h.evidence.snapshot,[]),{snapshotDigest:snapshotDigest(h.evidence.snapshot)});
  const dto=await h.evaluate(null);
  assert.equal(dto.results.filter(r=>r.type==="NEW").length,9);
  assert.equal(dto.newReviews,undefined);assert.equal(h.reads(),0);
});
test("ficha needs no portfolio and non-NEW externalId is not reviewed",async()=>{
  const h=setup();
  const dto=await h.evaluate("ficha");
  assert.equal(dto.newReviews[0].fields.externalId,data.externalId);
  assert.equal(dto.newReviews[0].candidates,undefined);assert.equal(h.reads(),0);
  const result=await createInmowebRunReader(h.options).evaluate(h.run,owner,h.source,undefined,
    {externalId:"not-in-run",review:"duplicates"});
  assert.equal(result.newReviews,undefined);assert.equal(h.reads(),0);
});
test("strict read-only query accepts only one NEW/action request",()=>{
  assert.equal(parseNewReviewQuery({}),undefined);
  for(const query of [{review:"duplicates"},{externalId:"1",review:"write"},
    {externalId:["1"],review:"ficha"},{externalId:"1",review:"ficha",usuarioId:owner}])
    assert.equal(parseNewReviewQuery(query),null);
  assert.deepEqual(parseNewReviewQuery({externalId:"1",review:"ficha"}),{externalId:"1",review:"ficha"});
});
test("legacy images string or object cannot cancel valid candidates",()=>{
  for(const imagenes of ["legacy",{legacy:true}]) {
    const candidates=duplicateCandidates(data,[{...data,_id:"legacy",imagenes},{...data,_id:"valid"}],sourceId);
    assert.equal(candidates.length,2);
  }
});
test("one broken candidate is isolated and incomplete review is distinguishable",async()=>{
  const h=setup();
  h.properties.unshift({...data,_id:"broken",usuarioId:owner,titulo:{toString(){throw Error("unsafe")}}});
  const dto=await h.evaluate();
  assert.equal(dto.newReviews[0].candidates.length,1);
  assert.equal(dto.newReviews[0].incomplete,true);
});
