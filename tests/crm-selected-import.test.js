import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import http from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import mongoose from "mongoose";
import Propiedad from "../models/Propiedad.js";
import ImportSource from "../models/ImportSource.js";
import { createSelectedImporter, validateImportProperty, feedHash } from "../utils/import/selectedImport.js";
import { analyzeFeedXml } from "../utils/importers/importerRegistry.js";
import { fetchImportImage, detectImageMime, MAX_IMPORT_IMAGE_BYTES } from "../utils/import/imageFetcher.js";
import { defaultRequestOnce } from "../utils/import/feedFetcher.js";
import { getLimiteFotosPlan } from "../utils/planLimits.js";

const USER = "507f1f77bcf86cd799439099";
const OTHER = "507f1f77bcf86cd799439088";
const URL = "https://public.example/feed.xml?token=private";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZfkAAAAASUVORK5CYII=", "base64");
const fixtureXml = fs.readFileSync(new globalThis.URL("../public/test-feeds/homeclick24-crm-feed-prueba.xml", import.meta.url), "utf8");

function fixture({ plan = "lanzamiento_2026", count = 0, failCreate = false, failDownload = false, failUpload = false, active = true, downloadHook = async () => {} } = {}) {
  const users = new Map([USER, OTHER].map(id => [id, { _id: id, plan, planActivo: active, trialAccepted: true, activo: true }]));
  const sources = [];
  const properties = [];
  const downloaded = [];
  const uploaded = [];
  const deleted = [];
  const ImportSourceModel = {
    async findOne(filter) { return sources.find(item => item.usuarioId === filter.usuarioId) || null; },
    async create(data) { const source = { ...data, _id: String(sources.length + 1), activo: true }; sources.push(source); return source; },
    async findOneAndUpdate(filter, update) {
      const source = sources.find(item => item._id === filter._id);
      if (source.importLockUntil && source.importLockUntil > new Date()) return null;
      Object.assign(source, update.$set); return source;
    },
    async updateOne(filter, update) {
      const source = sources.find(item => item._id === filter._id && item.importLockToken === filter.importLockToken);
      if (source) { Object.assign(source, update.$set); for (const field of Object.keys(update.$unset || {})) delete source[field]; }
    }
  };
  const PropiedadModel = {
    async countDocuments(filter) { return count + properties.filter(item => item.usuarioId === filter.usuarioId).length; },
    async find(filter) { return properties.filter(item => item.usuarioId === filter.usuarioId && item.importSourceId === filter.importSourceId && (!filter.externalId || filter.externalId.$in.includes(item.externalId))); },
    async create(data) {
      if (failCreate) throw new Error("secret DB message");
      if (properties.some(item => item.usuarioId === data.usuarioId && item.importSourceId === data.importSourceId && item.externalId === data.externalId)) throw Object.assign(new Error(), { code: 11000 });
      const item = { ...data, _id: String(properties.length + 10) }; properties.push(item); return item;
    }
  };
  const run = createSelectedImporter({ PropiedadModel, ImportSourceModel, UsuarioModel: { findById: async id => users.get(id) },
    downloadImage: async url => { downloaded.push(url); if (failDownload) throw new Error("private image URL"); await downloadHook(); return PNG; },
    uploadImage: async buffer => { assert.equal(buffer, PNG); if (failUpload) throw new Error("Cloudinary secret"); const image = { url: `https://res.cloudinary.com/test/${uploaded.length}.png`, publicId: `propiedades/${uploaded.length}` }; uploaded.push(image); return image; },
    deleteImage: async id => { deleted.push(id); return { ok: true }; }
  });
  const analyzed = analyzeFeedXml(fixtureXml, { maxPhotos: Infinity });
  return { run, users, sources, properties, downloaded, uploaded, deleted, analyzed, PropiedadModel,
    input: { usuarioId: USER, feedUrl: URL, analyzed, selectedExternalIds: ["HC24-DEMO-001"] } };
}

test("selección crea solo anuncios elegidos y persiste identidad CRM y datos originales", async () => {
  const f = fixture();
  const result = await f.run({ ...f.input, selectedExternalIds: ["HC24-DEMO-002"] });
  assert.equal(result.imported, 1);
  assert.equal(f.properties.length, 1);
  const p = f.properties[0];
  assert.equal(p.source, "crm"); assert.equal(p.externalId, "HC24-DEMO-002"); assert.equal(p.usuarioId, USER);
  assert.equal(p.importSourceId, f.sources[0]._id); assert.ok(p.importedAt instanceof Date); assert.ok(p.lastImportedAt instanceof Date);
  assert.equal(p.precio, 1650); assert.equal(p.localidad, "Rota"); assert.equal(p.provincia, "Cádiz"); assert.equal(p.codigoPostal, "11520");
  assert.equal(p.tipoInmueble, "casa_campo"); assert.equal(p.visiblePublicamente, true);
  assert.equal(p.imagenes.length, 5); assert.equal(f.downloaded.length, 5);
  assert.equal(f.sources[0].feedUrlHash, feedHash(URL)); assert.ok(!JSON.stringify(f.sources).includes("private"));
  assert.equal(f.sources[0].importLockToken, undefined);
});

test("reimportación es idempotente y otro propietario puede importar misma referencia", async () => {
  const f = fixture(); await f.run(f.input);
  const downloads = f.downloaded.length;
  const second = await f.run(f.input);
  assert.equal(second.imported, 0); assert.equal(second.results[0].reason, "duplicate"); assert.equal(f.downloaded.length, downloads);
  const third = await f.run({ ...f.input, usuarioId: OTHER });
  assert.equal(third.imported, 1); assert.equal(f.properties.length, 2);
});

test("no se importa parcialmente una selección que excede cupo", async () => {
  const f = fixture({ count: 8 });
  await assert.rejects(() => f.run({ ...f.input, selectedExternalIds: f.analyzed.properties.map(p => p.externalId) }), /permite importar 2.*seleccionado 4/);
  assert.equal(f.properties.length, 0); assert.equal(f.downloaded.length, 0); assert.equal(f.sources[0].importLockToken, undefined);
});

for (const [plan, count, allowed] of [["gratis", 1, 7], ["basico", 2, 10], ["destacado", 3, 15], ["lanzamiento_2026", 9, 20], ["vip", 300, 75], ["vip_trial", 300, 75]]) {
  test(`importación respeta cupo y fotos del plan ${plan}`, async () => {
    const f = fixture({ plan, count });
    f.analyzed.properties[0].fotos = Array.from({ length: 75 }, (_, i) => `https://cdn.example/${i}.jpg`);
    const result = await f.run(f.input);
    assert.equal(result.imported, 1); assert.equal(f.downloaded.length, allowed); assert.equal(f.properties[0].imagenes.length, allowed);
    assert.equal(allowed, Math.min(75, getLimiteFotosPlan(plan)));
    if (plan === "gratis") assert.ok(f.properties[0].fechaExpiracion > new Date());
    else assert.equal(f.properties[0].fechaExpiracion, null);
  });
}

test("sin plan activo o sin cupo no descarga ni crea", async () => {
  for (const options of [{ plan: "basico", active: false }, { count: 10 }]) {
    const f = fixture(options);
    await assert.rejects(() => f.run(f.input)); assert.equal(f.downloaded.length, 0); assert.equal(f.properties.length, 0);
  }
});

test("selección desconocida, referencia repetida y datos inválidos no se crean", async () => {
  const f = fixture();
  await assert.rejects(() => f.run({ ...f.input, selectedExternalIds: ["inventado"] }), /selección/);
  assert.match(validateImportProperty({ ...f.analyzed.properties[0], externalId: "" }).errors.join(" "), /referencia externa ausente/);
  f.analyzed.properties[0].titulo = "";
  const result = await f.run(f.input);
  assert.equal(result.results[0].reason, "invalid_data"); assert.equal(f.downloaded.length, 0);
  f.analyzed.properties.push(f.analyzed.properties[1]);
  const duplicate = await f.run({ ...f.input, selectedExternalIds: ["HC24-DEMO-002"] });
  assert.match(duplicate.results[0].errors[0], /repetida/);
});

test("fallo de una creación limpia Cloudinary y conserva las otras importaciones", async () => {
  const f = fixture();
  const original = f.PropiedadModel.create;
  f.PropiedadModel.create = async data => { if (data.externalId === "HC24-DEMO-001") throw new Error("secret"); return original(data); };
  const result = await f.run({ ...f.input, selectedExternalIds: ["HC24-DEMO-001", "HC24-DEMO-002"] });
  assert.equal(result.imported, 1); assert.equal(result.skipped, 1); assert.equal(f.deleted.length, 3);
  assert.equal(f.properties[0].externalId, "HC24-DEMO-002"); assert.ok(!JSON.stringify(result).includes("secret"));
});

test("fallos de fotos y Cloudinary generan avisos seguros sin abortar el inmueble", async () => {
  for (const options of [{ failDownload: true }, { failUpload: true }]) {
    const f = fixture(options); const result = await f.run(f.input);
    assert.equal(result.imported, 1); assert.equal(f.properties[0].imagenes.length, 0); assert.equal(result.results[0].warnings.length, 3);
    assert.ok(!JSON.stringify(result).includes("secret"));
  }
});

test("fuente única y bloqueo rechazan importación simultánea", async () => {
  const f = fixture(); await f.run(f.input);
  await assert.rejects(() => f.run({ ...f.input, feedUrl: "https://other.example/feed.xml" }), /una fuente/);
  f.sources[0].importLockUntil = new Date(Date.now() + 60000);
  await assert.rejects(() => f.run(f.input), /curso/);
});

test("dos importaciones concurrentes del mismo usuario no consumen cupo simultáneamente", async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ downloadHook: async () => { entered(); await gate; } });
  const first = f.run(f.input);
  await started;
  await assert.rejects(() => f.run(f.input), /curso/);
  release();
  assert.equal((await first).imported, 1);
  assert.equal(f.properties.length, 1);
});

test("cambio de permisos durante descarga aborta y limpia imágenes", async () => {
  const f = fixture({ downloadHook: async () => { f.users.get(USER).planActivo = false; } });
  const result = await f.run(f.input);
  assert.equal(result.imported, 0); assert.equal(f.properties.length, 0); assert.equal(f.deleted.length, 3);
});

test("colisión del índice único limpia subidas y devuelve duplicate", async () => {
  const f = fixture();
  f.PropiedadModel.create = async () => { throw Object.assign(new Error("secret"), { code: 11000 }); };
  const result = await f.run(f.input);
  assert.equal(result.results[0].reason, "duplicate"); assert.equal(f.deleted.length, 3);
});

test("índice único parcial compatible excluye anuncios manuales y documentos legacy", () => {
  const [fields, options] = Propiedad.schema.indexes().find(([, opts]) => opts.unique);
  assert.deepEqual(fields, { usuarioId: 1, importSourceId: 1, externalId: 1 });
  assert.equal(options.partialFilterExpression.source, "crm");
  assert.deepEqual(options.partialFilterExpression.importSourceId, { $type: "objectId" });
  assert.deepEqual(options.partialFilterExpression.externalId, { $type: "string" });
  const p = new Propiedad({ titulo: "Manual", direccion: "Chipiona", precio: 1, tipoOperacion: "venta" });
  assert.equal(p.source, "manual"); assert.equal(p.importSourceId, undefined); assert.equal(p.validateSync(), undefined);
  const source = new ImportSource({ usuarioId: new mongoose.Types.ObjectId(USER), feedType: "generic_xml", feedUrlHash: feedHash(URL), feedUrlMasked: "https://public.example/...?..." });
  assert.equal(source.validateSync(), undefined);
});

test("imágenes bloquean privadas y detectan MIME real JPEG, PNG y WebP", async () => {
  await assert.rejects(() => fetchImportImage("http://127.0.0.1/image.png"), error => error.code === "PRIVATE_IP");
  await assert.rejects(() => fetchImportImage("https://mixed.example/a.png", { lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }] }), error => error.code === "PRIVATE_IP");
  const options = { lookup: async () => [{ address: "93.184.216.34", family: 4 }], requestOnce: async () => ({ statusCode: 200, headers: { "content-type": "image/png" }, body: PNG }) };
  assert.equal(await fetchImportImage("https://public.example/a.png", options), PNG);
  assert.equal(detectImageMime(Buffer.from([255, 216, 255, 224])), "image/jpeg");
  assert.equal(detectImageMime(Buffer.from("RIFF0000WEBP")), "image/webp");
  for (const [headers, body] of [[{ "content-type": "text/html" }, PNG], [{ "content-type": "image/png" }, Buffer.from("broken")], [{ "content-type": "image/jpeg" }, PNG]]) {
    await assert.rejects(() => fetchImportImage("https://public.example/a", { ...options, requestOnce: async () => ({ statusCode: 200, headers, body }) }), error => error.code === "IMAGE_INVALID");
  }
});

test("descarga binaria rechaza redirects privados, tamaño excesivo y timeout", async () => {
  const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
  await assert.rejects(() => fetchImportImage("https://public.example/a", { lookup, requestOnce: async () => ({ statusCode: 302, headers: { location: "http://127.0.0.1/image.png" } }) }), error => error.code === "PRIVATE_IP");
  await assert.rejects(() => fetchImportImage("https://public.example/a", { lookup, requestOnce: async () => ({ statusCode: 200, headers: {}, body: Buffer.alloc(MAX_IMPORT_IMAGE_BYTES + 1) }) }), error => error.code === "FEED_TOO_LARGE");
  const original = http.request;
  try {
    http.request = (_url, _options, callback) => {
      const req = new EventEmitter(); req.end = () => {
        const res = new PassThrough(); res.statusCode = 200; res.headers = {}; callback(res);
        res.write(Buffer.alloc(64)); res.write(Buffer.alloc(64));
      };
      req.destroy = error => setImmediate(() => req.emit("error", error)); return req;
    };
    await assert.rejects(() => defaultRequestOnce(new globalThis.URL("http://public.example/a"), { binary: true, maxBytes: 80 }), error => error.code === "FEED_TOO_LARGE");
    http.request = () => { const req = new EventEmitter(); req.end = () => {}; req.destroy = error => setImmediate(() => req.emit("error", error)); return req; };
    await assert.rejects(() => defaultRequestOnce(new globalThis.URL("http://public.example/a"), { binary: true, timeoutMs: 10 }), error => error.code === "FEED_TIMEOUT");
  } finally { http.request = original; }
});

test("scripts inline de perfil compilan tras añadir selección CRM", () => {
  const html = fs.readFileSync(new globalThis.URL("../public/perfil.html", import.meta.url), "utf8");
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/.test(match[1]) || /application\/ld\+json/.test(match[1])) continue;
    new vm.Script(match[2]);
  }
  assert.match(html, /selectedExternalIds/); assert.match(html, /Ya importado/);
});

test("selección frontend bloquea cupo excedido y copia solo referencias seleccionadas al endpoint", async () => {
  const html = fs.readFileSync(new globalThis.URL("../public/perfil.html", import.meta.url), "utf8");
  const section = html.slice(html.indexOf("function formatearPrecioCrm"), html.indexOf("async function analizarFeedCrm"));
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, { value: "", textContent: "", innerHTML: "", disabled: false, style: {}, addEventListener() {} });
    return elements.get(id);
  };
  let selected = [];
  let sent;
  const context = vm.createContext({ token: "test-token", Set,
    escaparHtml: text => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
    document: { getElementById: get, querySelectorAll: () => selected },
    fetch: async (url, options) => { sent = { url, ...options }; return { ok: true, json: async () => ({ imported: 1, skipped: 0, results: [{ externalId: "REF1", status: "imported" }] }) }; }
  });
  vm.runInContext(section, context);
  get("crmFeedUrl").value = "https://example.com/feed.xml";
  vm.runInContext('crmAnalyzedUrl = "https://example.com/feed.xml"; renderizarPreviewCrm({total:1,limiteAnuncios:2,cupoDisponible:1,anunciosActuales:1,puedePublicarAhora:true,properties:[{externalId:"REF1",titulo:"Casa",errors:[],warnings:[]}]});', context);
  assert.equal(get("btnImportCrm").disabled, true);
  selected = [{ value: "REF1" }, { value: "REF2" }]; vm.runInContext("actualizarSeleccionCrm()", context);
  assert.equal(get("btnImportCrm").disabled, true);
  selected = [{ value: "REF1" }]; vm.runInContext("actualizarSeleccionCrm()", context);
  assert.equal(get("btnImportCrm").disabled, false);
  await vm.runInContext("importarSeleccionadosCrm()", context);
  assert.equal(sent.url, "/api/crm-import/import");
  assert.deepEqual(JSON.parse(sent.body), { feedUrl: "https://example.com/feed.xml", selectedExternalIds: ["REF1"] });
  assert.match(get("crmImportResults").innerHTML, /Importación completada/);
  assert.match(get("crmImportResults").innerHTML, /Ver mis propiedades/);
  assert.match(get("crmImportPreview").innerHTML, /Ya importado/);
});
