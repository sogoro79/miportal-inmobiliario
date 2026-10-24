import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";
import Propiedad from "../models/Propiedad.js";
import { propiedadCreateSchema, propiedadUpdateSchema } from "../utils/propertySchemas.js";
import { buildPropiedadCreateData } from "../utils/propertyCreation.js";
import { formatearPrecioPropiedad, periodicidadEfectiva, especificacionPrecio, applyPricePeriodEdit, pricePeriodFilter, priceAlertFilter } from "../utils/pricePeriod.js";
import { capturePropertyContent, markManualContentChanges } from "../utils/propertyContent.js";
import { analyzeGenericXml } from "../utils/importers/genericXmlImporter.js";
import { buildSyncSnapshot, syncFingerprint } from "../utils/import/syncSnapshot.js";
import { managedFingerprint, managedChangedFields, SYNC_APPLY_V1_FIELDS } from "../utils/import/syncBaseline.js";
import { compareSyncSnapshot } from "../utils/import/syncDiff.js";

const base = { titulo: "Prueba", direccion: "Calle de prueba", precio: 1200, tipoOperacion: "alquiler", habitaciones: 2 };
const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
test("rental period controls remain reachable on desktop", () => {
  const html = read("public/alquiler.html");
  assert.match(html, /@media \(min-width: 769px\)[\s\S]*?aside\.filtros\s*\{\s*display: block/);
  assert.match(html, /<select id="f_periodicidad"/);
});
for (const [period, amount, expected] of [["mes",1200,"1.200 €/mes"],["semana",800,"800 €/semana"],["dia",120,"120 €/día"],
  ["temporada",2500,"2.500 €/temporada"],["desconocida",1200,"1.200 €"],[null,1200,"1.200 €"],[undefined,1200,"1.200 €/mes"]]) {
  test(`rental format ${period}: ${expected}`, () => assert.equal(formatearPrecioPropiedad(amount, "alquiler", period),expected));
}
test("sale is never periodic", () => {
  assert.equal(formatearPrecioPropiedad(180000,"venta","mes"),"180.000 €");
  assert.equal(buildPropiedadCreateData({...base,tipoOperacion:"venta"}).periodicidadPrecio,null);
  assert.equal(propiedadCreateSchema.safeParse({...base,tipoOperacion:"venta"}).success,true);
});
for(const period of ["mes","semana","dia","temporada","desconocida"]) test(`manual rental requires and persists ${period}`, () => {
  const parsed=propiedadCreateSchema.parse({...base,periodicidadPrecio:period});
  assert.equal(buildPropiedadCreateData(parsed).periodicidadPrecio,period);
});
test("new rental without explicit decision is rejected, invalid values too", () => {
  for(const period of [undefined,null,"","monthly","constructor"]) assert.equal(propiedadCreateSchema.safeParse({...base,periodicidadPrecio:period}).success,false);
});
test("partial edits preserve the persisted period and legacy absence", () => {
  for(const period of [undefined,"semana","desconocida"]) {
    const property={...base,...(period===undefined?{}:{periodicidadPrecio:period})};
    applyPricePeriodEdit(property,propiedadUpdateSchema.parse({descripcion:"Nueva"}));
    assert.equal(property.periodicidadPrecio,period);
  }
});
test("period edit is a single real CRM override/revision", () => {
  const property={...base,source:"crm",syncEnabled:true,contentRevision:3,periodicidadPrecio:"mes"};
  const before=capturePropertyContent(property);
  applyPricePeriodEdit(property,{periodicidadPrecio:"semana"});
  assert.deepEqual(markManualContentChanges(property,before),["periodicidadPrecio"]);
  assert.equal(property.contentRevision,4);
  assert.deepEqual(property.syncOverrides,{periodicidadPrecio:true});
});
test("new model writes cannot silently acquire legacy monthly fallback", async () => {
  const fresh=new Propiedad({...base});await fresh.validate();
  assert.equal(fresh.periodicidadPrecio,"desconocida");
  const legacy=Propiedad.hydrate({...base});await legacy.validate();
  assert.equal(legacy.periodicidadPrecio,undefined);
  assert.equal(periodicidadEfectiva(legacy),"mes");
});
for(const [period,unit]of[["mes","month"],["semana","week"],["dia","day"],["desconocida",null]]) test(`SEO ${period} does not invent a temporal unit`,()=>{
  const p={...base,periodicidadPrecio:period};const spec=especificacionPrecio(p);
  if(unit) assert.deepEqual(spec.referenceQuantity,{"@type":"QuantitativeValue",value:1,unitText:unit});
  else assert.equal(spec,undefined);
  const scripts=[];const ctx=vm.createContext({ URLSearchParams,window:{location:{search:""},addEventListener(){}},
    document:{addEventListener(){},querySelector:()=>null,getElementById:()=>null,createElement:()=>({}),head:{appendChild:s=>scripts.push(s)}},input:p });
  for(const file of ["public-location","precios","propiedad"])vm.runInContext(read(`public/js/${file}.js`),ctx);
  vm.runInContext('propiedad = input; fotos = []; actualizarSEO();',ctx);
  const schema=JSON.parse(scripts.find(s=>s.id==="schema-propiedad").textContent);
  assert.equal(schema.offers.price,1200);
  if(unit)assert.equal(schema.offers.priceSpecification.referenceQuantity.unitText,unit);
  else assert.equal(schema.offers.priceSpecification,undefined);
});

const xml = period => `<properties><property><id>A</id><title>Prueba</title><operation>rent</operation><price>1200</price><address>Calle</address><bedrooms>2</bedrooms>${period?`<periodicidadPrecio>${period}</periodicidadPrecio>`:""}</property></properties>`;
test("generic new imports without period explicitly remain unknown, not monthly",()=>{
  const p=analyzeGenericXml(xml())[0];assert.equal(p.periodicidadPrecio,"desconocida");
  assert.equal(buildPropiedadCreateData(p,{source:"crm"}).periodicidadPrecio,"desconocida");
  assert.equal(formatearPrecioPropiedad(p.precio,p.tipoOperacion,p.periodicidadPrecio),"1.200 €");
});
test("generic explicitly supplies a period; snapshot/fingerprint/diff detect changes",()=>{
  assert.equal(analyzeGenericXml(xml("semana"))[0].periodicidadPrecio,"semana");
  const a=buildSyncSnapshot(xml("mes")),b=buildSyncSnapshot(xml("semana"));
  assert.equal(b.snapshotComplete,true);
  assert.notEqual(syncFingerprint(a.properties[0].data),syncFingerprint(b.properties[0].data));
  const p={...a.properties[0].data,syncEnabled:true};
  assert.deepEqual(managedChangedFields(p,b.properties[0].data),["periodicidadPrecio"]);
  assert.notEqual(managedFingerprint(p),managedFingerprint(b.properties[0].data));
  assert.deepEqual(Object.keys(compareSyncSnapshot(b,[p]).results[0].changes),["periodicidadPrecio"]);
});
test("legacy snapshot and managed fingerprints remain byte-compatible when field absent",()=>{
  const data=buildSyncSnapshot(xml()).properties[0].data;
  assert.equal(Object.hasOwn(data,"periodicidadPrecio"),false);
  const fields=SYNC_APPLY_V1_FIELDS.filter(f=>f!=="periodicidadPrecio");
  const values=fields.map(f=>[f,data[f]===undefined?["absent"]:data[f]===null?["null"]:[typeof data[f],data[f]]]);
  const old=crypto.createHash("sha256").update(JSON.stringify({version:1,normalizationVersion:1,values})).digest("hex");
  assert.equal(managedFingerprint(data),old);
});
test("monthly query includes only explicit monthly and legacy absence",()=>{
  assert.deepEqual(pricePeriodFilter("mes"),{$or:[{periodicidadPrecio:"mes"},{periodicidadPrecio:{$exists:false}}]});
  assert.deepEqual(pricePeriodFilter("semana"),{periodicidadPrecio:"semana"});
  assert.notDeepEqual(pricePeriodFilter("desconocida"),pricePeriodFilter("mes"));
});
test("rental ordering filters period before numeric ordering",async()=>{
  const nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{value:"",innerHTML:"",textContent:""});return nodes.get(id);};
  node("f_periodicidad").value="semana";node("f_sort").value="precio_asc";
  const ctx=vm.createContext({URLSearchParams,window:{location:{pathname:"/alquiler"},addEventListener(){}},document:{addEventListener(){},getElementById:node},
    fetch:async()=>({ok:true,json:async()=>[{_id:"day",titulo:"D",precio:120,tipoOperacion:"alquiler",periodicidadPrecio:"dia"},{_id:"week",titulo:"S",precio:800,tipoOperacion:"alquiler",periodicidadPrecio:"semana"}]})});
  for(const file of["precios","public-location","filtros"])vm.runInContext(read(`public/js/${file}.js`),ctx);
  await ctx.cargarPropiedades();
  assert.match(node("lista").innerHTML,/800 €\/semana/);assert.doesNotMatch(node("lista").innerHTML,/120 €/);
});

test("budget alerts only match their own period; unknown cannot trigger monthly/weekly/daily",()=>{
  const accepts=(filter,alert)=>filter.$or?filter.$or.some(c=>accepts(c,alert)):
    Object.entries(filter).every(([k,v])=>k!=="periodicidadPrecio"||
      (v&&typeof v==="object"?(v.$exists===false?alert[k]===undefined:v.$type===10&&alert[k]===null):alert[k]===v));
  for(const period of["mes","semana","dia","temporada","desconocida"]){
    const filter=priceAlertFilter({...base,periodicidadPrecio:period});
    for(const other of["mes","semana","dia","temporada","desconocida"])assert.equal(accepts(filter,{periodicidadPrecio:other}),other===period);
    assert.equal(accepts(filter,{}),period==="mes");
  }
});
