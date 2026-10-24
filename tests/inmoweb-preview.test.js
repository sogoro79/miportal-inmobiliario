import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import express from "express";
import http from "node:http";
import jwt from "jsonwebtoken";
import Usuario from "../models/Usuario.js";
import { createCrmImportRouter } from "../routes/crmImport.js";
import { analyzeFeedXml } from "../utils/importers/importerRegistry.js";
import { safeInmowebPreview, maskAnalysisFeedUrl, safeAnalysisErrorCode } from "../utils/import/inmowebPreview.js";
import { FeedSecurityError } from "../utils/import/feedSecurity.js";

const fixture = fs.readFileSync(new URL("./fixtures/crm/inmoweb-synthetic.xml", import.meta.url), "utf8");
const profile = fs.readFileSync(new URL("../public/perfil.html", import.meta.url), "utf8");
const renderer = fs.readFileSync(new URL("../public/js/crm-readonly-preview.js", import.meta.url), "utf8");
const userId = "507f1f77bcf86cd799439099";
const testUrl = "https://feed.inmoweb.es/?key=synthetic-preview-token";
const generic = '<properties><property><id>GEN-A</id><title>Casa ficticia</title><price>500</price><operation>sale</operation><address>Dirección ficticia</address><bedrooms>1</bedrooms></property></properties>';
const record = fixture.match(/<propiedad\b[\s\S]*?<\/propiedad>/)[0];
const preview = xml => safeInmowebPreview(analyzeFeedXml(xml, { feedType: "inmoweb" }));

async function withApp(xml, callback, { failure } = {}) {
  const user = { _id: userId, plan: "gratis", activo: true };
  const previous = Usuario.findById;
  const secret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "inmoweb-preview-test-secret";
  Usuario.findById = async () => user;
  const effects = { writes: 0, sourceReads: 0, imports: 0, fetches: 0 };
  const noWrite = async () => { effects.writes++; throw Error("Unexpected write"); };
  const app = express(); app.use(express.json());
  const next = (req, res, fn) => fn();
  app.use("/api/crm-import", createCrmImportRouter({
    UsuarioModel: { findById: async () => user },
    PropiedadModel: { countDocuments: async () => 0, find: async () => [], create: noWrite, updateOne: noWrite },
    ImportSourceModel: { findOne: async () => { effects.sourceReads++; return null; }, create: noWrite, updateOne: noWrite, init: noWrite },
    fetchFeedXml: async url => { assert.equal(url, testUrl); effects.fetches++; if (failure) throw failure; return { xml }; },
    importSelected: async () => { effects.imports++; throw Error("Import forbidden"); },
    rateLimitMiddleware: next, userRateLimitMiddleware: next,
    importRateLimitMiddleware: next, importUserRateLimitMiddleware: next
  }));
  const server = http.createServer(app);
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const request = async (body, path = "analyze", authenticated = true) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/crm-import/${path}`, {
        method: "POST", headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: `Bearer ${jwt.sign({ id: userId }, process.env.JWT_SECRET)}` } : {}) },
        body: JSON.stringify(body)
      });
      return { status: response.status, body: await response.json() };
    };
    await callback(request, effects);
    assert.equal(effects.writes, 0);
    assert.equal(effects.imports, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    Usuario.findById = previous;
    if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret;
  }
}

for (const feedType of ["inmoweb", "auto"]) test(`HTTP preview ${feedType} is opt-in, canonical and read-only`, async () => {
  await withApp(fixture, async (request, effects) => {
    const response = await request({ feedUrl: testUrl, feedType });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, preview(fixture));
    assert.equal(response.body.previewOnly, true);
    assert.equal(response.body.snapshotComplete, false);
    assert.equal(response.body.importEnabled, false);
    assert.equal(response.body.syncEnabled, false);
    assert.equal(effects.sourceReads, 0);
    const p = response.body.properties[0];
    assert.equal(p.externalId, "0001"); assert.equal(p.referencia, "SYNTHETIC-REF-A");
    assert.equal(p.fotosDisponibles, 2); assert.equal(p.fotosImportables, 0);
    for (const key of ["metadata", "descripcion", "imagenes", "fotos", "fingerprint", "importSourceId"]) assert.equal(Object.hasOwn(p, key), false);
  });
});

test("auth and strict analysis contract remain enforced", async () => {
  await withApp(fixture, async request => {
    assert.equal((await request({ feedUrl: testUrl, feedType: "inmoweb" }, "analyze", false)).status, 401);
    for (const extra of [{ ownerId: userId }, { usuarioId: userId }, { feedType: "unknown" }, { selectedExternalIds: ["0001"] }]) {
      assert.equal((await request({ feedUrl: testUrl, ...extra })).status, 400);
    }
  });
});

test("generic default and explicit/auto generic preserve existing response", async () => {
  await withApp(generic, async request => {
    const implicit = await request({ feedUrl: testUrl });
    assert.equal(implicit.status, 200);
    assert.equal(implicit.body.feedType, "generic_xml");
    assert.equal(Object.hasOwn(implicit.body, "previewOnly"), false);
    assert.deepEqual((await request({ feedUrl: testUrl, feedType: "generic_xml" })).body, implicit.body);
    assert.deepEqual((await request({ feedUrl: testUrl, feedType: "auto" })).body, implicit.body);
  });
});

test("InmoWeb is not activated implicitly, nor accepted by Phase 2 import", async () => {
  await withApp(fixture, async (request, effects) => {
    assert.equal((await request({ feedUrl: testUrl })).status, 400);
    assert.equal((await request({ feedUrl: testUrl, feedType: "inmoweb", selectedExternalIds: ["0001"] }, "import")).status, 400);
    assert.equal((await request({ feedUrl: testUrl, selectedExternalIds: ["0001"] }, "import")).status, 400);
    assert.equal(effects.imports, 0);
    assert.equal(effects.sourceReads, 0);
  });
});

test("multiple properties retain canonical identity and safe issues", async () => {
  const xml = `<properties>${record}${record.replace('id="0001"', 'id="0002"')}</properties>`;
  await withApp(xml, async request => {
    const { body } = await request({ feedUrl: testUrl, feedType: "inmoweb" });
    assert.equal(body.total, 2);
    assert.deepEqual(body.properties.map(p => p.externalId), ["0001", "0002"]);
    assert.ok(body.properties.every(p => p.publishableByData && p.precisionUbicacion === "aproximada"));
    assert.ok(body.properties.every(p => p.futureNewEligible === true && p.futureNewStatus === "eligible"));
    assert.equal(body.importEnabled, false);
    assert.equal(body.syncEnabled, false);
    assert.ok(body.properties.every(p => !p.issues.some(i => i.code === "INMOWEB_ADDRESS_MISSING")));
  });
});

for (const [from, to, code, severity] of [
  ['<operacion id="1">', '<operacion id="2">', 'INMOWEB_RENT_PERIOD_UNKNOWN', 'warning'],
  ['>210000</precio>', '>1</precio>', 'INMOWEB_PRICE_REVIEW_REQUIRED', 'warning'],
  ['<estado id="SM"/>', '<estado/>', 'INMOWEB_CONDITION_UNKNOWN', 'warning'],
  ['<familia id="24">', '<familia id="999">', 'INMOWEB_UNSUPPORTED_FAMILY', 'blocking'],
  ['<operacion id="1">', '<operacion id="6">', 'INMOWEB_UNSUPPORTED_OPERATION', 'blocking'],
  ['divisa="EUR"', 'divisa="USD"', 'INMOWEB_UNSUPPORTED_CURRENCY', 'blocking'],
  ['<dormitorios>2</dormitorios>', '<dormitorios/>', 'INMOWEB_BEDROOMS_UNKNOWN', 'blocking'],
  ['<longitud>-6.2</longitud>', '', 'INMOWEB_INVALID_COORDINATES', 'warning'],
  ['https://images.example.test/main.jpg', 'file:///invalid', 'INMOWEB_IMAGE_URL_REJECTED', 'warning']
]) test(`preview issue ${code} has explicit severity and safe message`, () => {
  const p = preview(fixture.replace(from, to)).properties[0];
  const issue = p.issues.find(i => i.code === code);
  assert.equal(issue.severity, severity);
  assert.ok(issue.message.length > 10);
  assert.ok((severity === "blocking" ? p.errors : p.warnings).includes(issue.message));
});

test("63 photos survive HTTP preview with no image URLs or metadata exposure", async () => {
  const xml = fixture.replace(/<imagenes>[\s\S]*?<\/imagenes>/, `<imagenes>${Array.from({ length: 63 }, (_, i) => `<imagen url="https://images.example.test/${i}.jpg"/>`).join('')}</imagenes>`);
  await withApp(xml, async request => {
    const { body } = await request({ feedUrl: testUrl, feedType: "inmoweb" });
    assert.equal(body.properties[0].fotosDisponibles, 63);
    assert.doesNotMatch(JSON.stringify(body), /images\.example|metadata|traducciones/);
  });
});

for (const xml of ["<properties>", "<properties/>", "<properties></properties>", '<properties><propiedadSimilar id="A"/></properties>', '<wrapper><properties><propiedad id="A"/></properties></wrapper>']) {
  test(`invalid/empty/lookalike XML rejects safely: ${xml}`, async () => {
    await withApp(xml, async request => {
      const response = await request({ feedUrl: testUrl, feedType: "inmoweb" });
      assert.equal(response.status, 400);
      assert.doesNotMatch(JSON.stringify(response.body), /synthetic-preview-token|stack|metadata/);
    });
  });
}

test("masked URL and logs never contain a credential or arbitrary error code/message", async () => {
  assert.equal(maskAnalysisFeedUrl(testUrl), "https://feed.inmoweb.es/?key=********");
  assert.equal(maskAnalysisFeedUrl("https://generic.example.test/secret/path?token=synthetic"), "https://generic.example.test/...?...");
  assert.equal(safeAnalysisErrorCode({ code: "synthetic-preview-token" }), "ANALYSIS_FAILED");
  const previous = console.warn, logs = [];
  console.warn = (...args) => logs.push(args);
  try {
    await withApp(fixture, async request => {
      assert.equal((await request({ feedUrl: testUrl, feedType: "inmoweb" })).status, 500);
    }, { failure: Object.assign(new Error(testUrl), { code: "synthetic-preview-token" }) });
    assert.ok(JSON.stringify(logs).includes("key=********"));
    assert.doesNotMatch(JSON.stringify(logs), /synthetic-preview-token/);
  } finally { console.warn = previous; }
});

test("SSRF failure is propagated without bypasses or writes", async () => {
  await withApp(fixture, async request => {
    assert.equal((await request({ feedUrl: testUrl, feedType: "inmoweb" })).status, 400);
  }, { failure: new FeedSecurityError("Red privada no permitida.", "PRIVATE_IP") });
});

test("preview sanitizes inline contacts/links and hides private fields", () => {
  const analyzed = analyzeFeedXml(fixture, { feedType: "inmoweb" });
  Object.assign(analyzed.properties[0], { titulo: 'Casa <b>prueba</b> pro@example.test +34 600 111 222 https://example.test/?token=synthetic', telefono: "private", propietario: "private" });
  const serialized = JSON.stringify(safeInmowebPreview(analyzed));
  assert.doesNotMatch(serialized, /pro@example|600 111|token=synthetic|<b>|propietario|telefono|private/);
});

test("UI renders read-only data without monthly assumptions, unsafe HTML or checkboxes", () => {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(new URL('../public/js/precios.js', import.meta.url), 'utf8'), ctx);
  vm.runInNewContext(renderer, ctx);
  const data = preview(fixture.replace('<operacion id="1">', '<operacion id="2">'));
  data.properties[0].titulo = '<script>unsafe()</script>';
  const html = ctx.window.HomeClickCrmReadOnlyPreview.rows(data);
  assert.match(html, /Periodicidad desconocida/);
  assert.match(html, /EUR/); assert.doesNotMatch(html, /€\/mes|<input|<script>/);
  assert.match(html, /&lt;script&gt;/); assert.match(html, /Aviso:/);
  assert.match(ctx.window.HomeClickCrmReadOnlyPreview.summary(data), /No se pueden importar ni sincronizar/);
});

test("profile refuses import even if a read-only preview button is externally enabled", async () => {
  let posts = 0;
  const ctx = vm.createContext({ crmPreviewData: { previewOnly: true }, crmImportBusy: false,
    document: { querySelectorAll: () => [], getElementById: () => ({ disabled: false }) },
    fetch: async () => { posts++; throw Error("Unexpected POST"); } });
  vm.runInContext(profile.slice(profile.indexOf("async function importarSeleccionadosCrm"), profile.indexOf("async function analizarFeedCrm")), ctx);
  await ctx.importarSeleccionadosCrm();
  assert.equal(posts, 0);
});

test("actual profile rendering hides import controls and restores the generic preview", () => {
  const nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: "", textContent: "", style: {}, disabled: false, hidden: false, value: "", addEventListener() {} });
    return nodes.get(id);
  };
  const ctx = vm.createContext({ window: {}, crmPreviewData: null, crmImportBusy: false, crmAnalyzedUrl: "",
    document: { getElementById: element, querySelectorAll: () => [] },
    textoImportacionCupo: () => "Plan genérico", escaparHtml: value => String(value), formatearPrecioCrm: () => "10 €"
  });
  vm.runInContext(fs.readFileSync(new URL('../public/js/precios.js', import.meta.url), 'utf8'), ctx);
  vm.runInContext(renderer, ctx);
  vm.runInContext(profile.slice(profile.indexOf("function actualizarSeleccionCrm"), profile.indexOf("function lineasResumenCrm")), ctx);
  ctx.renderizarPreviewCrm(preview(fixture));
  assert.equal(element("btnImportCrm").hidden, true);
  assert.equal(element("btnImportCrm").disabled, true);
  assert.doesNotMatch(element("crmImportPreview").innerHTML, /<input/);
  assert.match(element("crmSelectedCount").textContent, /Solo análisis/);
  ctx.renderizarPreviewCrm({ feedType: "generic_xml", puedePublicarAhora: true, cupoDisponible: 10, properties: [{ externalId: "GEN", titulo: "Prueba", errors: [] }] });
  assert.equal(element("btnImportCrm").hidden, false);
  assert.match(element("crmImportPreview").innerHTML, /type="checkbox"/);
  assert.match(element("crmImportSummary").innerHTML, /Plan genérico/);
});

test("profile preserves generic default, hides URL, loads renderer and all inline scripts parse", () => {
  assert.match(profile, /<option value="generic_xml">XML genérico/);
  assert.match(profile, /type="password" id="crmFeedUrl"/);
  assert.match(profile, /crm-readonly-preview\.js\?v=5/);
  for (const [, attrs, source] of profile.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (!/\bsrc=/.test(attrs)) new vm.Script(source);
  }
});
