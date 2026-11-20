import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { buildFeedSnapshot } from "../utils/importers/importerRegistry.js";
import { compareInmowebProperty, readInmowebComparisons } from "../utils/import/inmowebComparison.js";
import { createInmowebRunReader } from "../utils/import/inmowebRunView.js";
import { prepareSyncPlan, runVersions, snapshotDigest } from "../utils/import/syncPlan.js";
import { createSyncEnroller } from "../utils/import/syncEnroll.js";
import { encryptFeedUrl } from "../utils/import/feedUrlCrypto.js";
import { randomBytes } from "node:crypto";
import { createSyncApplier } from "../utils/import/syncApply.js";
import { createMissingHider } from "../utils/import/syncHideMissing.js";
import { createReappearedRestorer } from "../utils/import/syncRestoreReappeared.js";

const xml = fs.readFileSync(new URL("./fixtures/crm/inmoweb-synthetic.xml", import.meta.url), "utf8");
const snapshot = buildFeedSnapshot(xml, { feedType: "inmoweb" });
const record = snapshot.properties[0];
const property = { ...record.data, _id: "property", source: "crm", usuarioId: "507f1f77bcf86cd799439099", importSourceId: "source",
  contentRevision: 5, precio: 1 };
const source = { _id: "source", usuarioId: "507f1f77bcf86cd799439099", activo: true, feedType: "inmoweb", feedUrlHash: "a".repeat(64) };
const run = { _id: "507f1f77bcf86cd799439097", usuarioId: "507f1f77bcf86cd799439099", importSourceId: "source", feedType: "inmoweb",
  status: "simulated", snapshotComplete: false, newSnapshotComplete: true, providerNormalizationVersion: 1,
  sourceIdentityHash: source.feedUrlHash, snapshotDigest: snapshotDigest(snapshot), ...runVersions,
  expiresAt: new Date(Date.now()+1200000), ...prepareSyncPlan(snapshot, [property]) };
const find = rows => ({ find(filter) {
  assert.deepEqual(filter, { usuarioId: "507f1f77bcf86cd799439099", importSourceId: "source", source: "crm", externalId: { $in: ["0001"] } });
  return { lean: async () => rows };
} });

test("compara los quince campos, abrevia textos y solo cuenta las fotos", () => {
  const local = { ...property, titulo: "Título anterior", descripcion: "Descripción privada anterior",
    habitaciones: 5, banos: 4, superficie: 220, localidad: "Otra", provincia: "Otra",
    tipoOperacion: "alquiler", tipoInmueble: "chalet", terraza: false, piscina: false, garaje: false,
    periodicidadPrecio: "mes", imagenes: [] };
  const dto = compareInmowebProperty(local, record);
  assert.equal(dto.changes.length, 15);
  assert.equal(dto.uncertain, true);
  const fields = Object.fromEntries(dto.changes.map(c => [c.field,c]));
  assert.equal(fields.precio.crm.value, 210000);
  assert.equal(fields.imagenes.crm.value, 2);
  assert.equal(fields.descripcion.crm.kind, "text");
  assert.doesNotMatch(JSON.stringify(dto), /https?:|Descripción privada|Datos inventados/);
  assert.deepEqual(compareInmowebProperty({ ...record.data, imagenes: ["host-A","host-B"] }, record).changes, []);
});

test("una etiqueta XML omitida no vacía datos; cero, false, null y valores derivados son diferentes", () => {
  const modified = xml.replace("<banos>1</banos>", "<banos>0</banos>").replace("<dormitorios>2</dormitorios>", "")
    .replace("privado</caracteristica>", "no</caracteristica>").replace('<operacion id="1">','<operacion id="2">')
    .replace("Piso sintético","Texto largo ".repeat(30)).replace("<construida>90</construida>",'<construida xsi:nil="true"/>');
  const input = buildFeedSnapshot(modified,{feedType:"inmoweb"}).properties[0];
  const fields = Object.fromEntries(compareInmowebProperty({ ...property, banos: undefined },input).changes.map(c => [c.field,c]));
  assert.equal(fields.habitaciones, undefined);
  assert.equal(fields.banos.crm.value, 0);
  assert.equal(fields.banos.local.kind, "absent");
  assert.equal(fields.garaje.crm.value, false);
  assert.equal(fields.superficie.crm.kind, "null");
  assert.deepEqual(fields.periodicidadPrecio.crm, {kind:"unknown",derived:true});
  assert.equal(fields.titulo.crm.kind, "derived");
});

test("la simulación observa la revisión sin habilitar ningún escritor", () => {
  assert.equal(run.plan[0].expectedContentRevision, 5);
  assert.equal(run.plan[0].blocked,true);
  assert.equal(run.plan[0].enrollmentEligible,false);
  assert.equal(run.missingCount,0);
  assert.equal(prepareSyncPlan(snapshot,[{...property,externalId:"ausente"}]).missingCount,0);
});

for (const change of [{ contentRevision:6 },{ source:"manual" },{ usuarioId:"otro" },{ importSourceId:"otra" },{ _id:"sustituto" }]) {
  test("sin detalle para estado o identidad distinta "+JSON.stringify(change), async () => {
    const dto = await readInmowebComparisons(run,snapshot,find([{...property,...change}]));
    assert.deepEqual(dto,[{externalId:"0001",stale:true}]);
  });
}

test("el lector autorizado revalida delegación y vencimiento después de leer; ningún refetch", async () => {
  const now = Date.now();
  let time = now, reads = 0, validGrant = true;
  const PropiedadModel = find([property]);
  const delegated = {...run,actorAdminId:"admin",delegationId:"grant"};
  const grant = { id:"grant",actorAdminId:"admin", async assert(){if (!validGrant) throw Error("revocada");} };
  const reader = createInmowebRunReader({now:()=>new Date(time),PropiedadModel,
    providerSnapshots:{async readPersisted(){reads++;return {snapshot,expiresAt:new Date(now+300000)};}}});
  assert.equal((await reader.evaluate(delegated,"507f1f77bcf86cd799439099",source,grant)).comparisons[0].changes[0].field,"precio");
  validGrant=false;
  assert.equal((await reader.evaluate(delegated,"507f1f77bcf86cd799439099",source,grant)).comparisons,undefined);
  assert.equal(reads,1);
  validGrant=true;
  time+=300001;
  assert.equal((await reader.evaluate(delegated,"507f1f77bcf86cd799439099",source,grant)).comparisons,undefined);
  time=now;
  PropiedadModel.find=()=>({lean:async()=>{validGrant=false;return [property];}});
  await assert.rejects(reader.evaluate(delegated,"507f1f77bcf86cd799439099",source,grant),/revocada/);
});

for(const [factory,code] of [[createSyncApplier,"INMOWEB_ACTION_DISABLED"],[createMissingHider,"MISSING_RUN_CHANGED"],
  [createReappearedRestorer,"REAPPEARED_SOURCE_CHANGED"]]) {
  test("llamada directa al escritor rechazada: "+code,async()=>{
    const model = value => ({findOne:async()=>value});
    const execute = factory({ImportSyncRunModel:model(run),ImportSourceModel:model(source),UsuarioModel:model({activo:true})});
    await assert.rejects(execute({usuarioId:"507f1f77bcf86cd799439099",runId:"507f1f77bcf86cd799439097",externalIds:["0001"]}),{code});
  });
}

test("componente compartido abre detalle con nueva lectura y sin acciones de escritura",async()=>{
  function element(tag){return {tag,children:[],append(child){this.children.push(child);},replaceChildren(){this.children=[];}};}
  const window={};
  vm.runInNewContext(fs.readFileSync(new URL("../public/js/inmoweb-comparison.js",import.meta.url),"utf8"),
    {window,document:{createElement:element},setTimeout(){}});
  const dto={...run,snapshotExpiresAt:run.expiresAt,comparisons:await readInmowebComparisons(run,snapshot,find([property]))};
  const output=element("div");
  let reads=0;
  window.renderInmowebComparisons(output,dto,async()=>{reads++;return dto;});
  function flatten(node){return [node,...node.children.flatMap(flatten)];}
  const buttons=flatten(output).filter(n=>n.tag==="button");
  assert.deepEqual(buttons.map(b=>b.textContent),["Ver diferencias"]);
  assert.ok(!flatten(output).some(n=>n.tag==="input"));
  await buttons[0].onclick();
  assert.equal(reads,1);
  const text=flatten(output).map(n=>n.textContent).join(" ");
  assert.match(text,/origen sin determinar/);
  assert.match(text,/HomeClick24:.*CRM:/);
  assert.match(text,/No evaluable/);
  assert.match(text,/No accionable/);
});

test("no se reconstruye una revisión legacy ni se comparan dos coincidencias ambiguas", async () => {
  const legacy = {...run, plan: run.plan.map(({expectedContentRevision, ...entry}) => entry)};
  assert.deepEqual(await readInmowebComparisons(legacy,snapshot,find([property])),[{externalId:"0001",unavailable:true}]);
  assert.deepEqual(await readInmowebComparisons(run,snapshot,find([property,property])),[{externalId:"0001",stale:true}]);
  const absent = compareInmowebProperty({...record.data, imagenes:["host-A"]},
    buildFeedSnapshot(xml.replace(/<imagenes>[\s\S]*?<\/imagenes>/,""),{feedType:"inmoweb"}).properties[0]);
  assert.deepEqual(absent.changes,[]);
});

test("la revisión no habilita enroll ni permite pedir una nueva descarga al intentarlo", async () => {
  const env = { CRM_FEED_URL_KEY_V1: randomBytes(32).toString("base64") };
  const configured = {...source, ...encryptFeedUrl("https://example.test/fixture",env)};
  const enroll = createSyncEnroller({ env, ImportSourceModel:{findOne:async()=>configured},
    fetchXml:async()=>assert.fail("refetch inesperado") });
  await assert.rejects(enroll({usuarioId:source.usuarioId,importSourceId:source._id,
    externalIds:[property.externalId]}), {code:"SYNC_SOURCE_NOT_CONFIGURED"});
});

test("el texto de presentación no entrega etiquetas, URL ni credenciales incrustadas", () => {
  const local = {...property,titulo:"<b>Casa</b> https://example.test/?token=abc Bearer privado"};
  const review = compareInmowebProperty(local,record);
  assert.doesNotMatch(JSON.stringify(review),/https:|<b>|token=abc|privado/);
});
