import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import jwt from "jsonwebtoken";
import { PassThrough, Readable, Writable } from "stream";
import { v2 as cloudinary } from "cloudinary";
import Propiedad from "../models/Propiedad.js";
import Usuario from "../models/Usuario.js";
import Alerta from "../models/Alerta.js";
import Notificacion from "../models/Notificacion.js";
import ImportReconciliation from "../models/ImportReconciliation.js";
import { recordManualPublicationUncertainty } from "../utils/manualPublicationReconciliation.js";
import { getSeoZoneContext } from "../utils/seoZones.js";
import { capturePropertyContent } from "../utils/propertyContent.js";
import { getLimiteFotosPlan } from "../utils/planLimits.js";

function registerCapacityHttpTests() {
for (const mode of ["normal", "admin"]) for (const available of [true, false]) {
  test(`PUT ${mode} incorporación al cupo ${available ? "con hueco" : "sin hueco"} usa fence y respuesta segura`, async () => {
    const owner = "507f1f77bcf86cd799439099", admin = "507f1f77bcf86cd799439012", propertyId = "507f1f77bcf86cd799439088";
    const savedMethods = { userFind: Usuario.findById, userUpdate: Usuario.updateOne, session: Usuario.startSession,
      propertyFind: Propiedad.findById, propertyOne: Propiedad.findOne, propertyUpdate: Propiedad.updateOne, count: Propiedad.countDocuments };
    const stored = { _id: propertyId, usuarioId: owner, titulo: "Casa", precio: 100000, direccion: "Chipiona",
      tipoOperacion: "venta", habitaciones: 2, banos: 1, imagenes: [], contentRevision: 0,
      visiblePublicamente: mode === "normal", estadoComercial: mode === "normal" ? "Vendido" : "Disponible" };
    const property = Propiedad.hydrate(stored), events = []; let version = 0, writes = 0;
    const query = value => ({ select() { return this; }, lean() { return this; }, session() { return this; },
      then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
    Usuario.findById = id => query({ _id: String(id), activo: true, plan: "gratis", planActivo: false, role: String(id) === admin ? "admin" : "user" });
    Usuario.startSession = async () => ({ async withTransaction(callback) {
      const before = version; try { await callback(); } catch (error) { version = before; throw error; }
    }, async endSession() {} });
    Usuario.updateOne = async (filter, op, options) => {
      assert.equal(String(filter._id), owner); assert.ok(options.session); assert.equal(op.$inc.publicationVersion, 1);
      version++; events.push("fence"); return { matchedCount: 1 };
    };
    Propiedad.findById = () => query(property);
    Propiedad.findOne = () => query({ ...stored });
    Propiedad.countDocuments = () => { events.push("count"); return query(available ? 1 : 2); };
    Propiedad.updateOne = async (filter, op, options) => {
      assert.equal(String(filter._id), propertyId); assert.ok(options.session); writes++;
      Object.assign(stored, op.$set); stored.contentRevision += op.$inc?.contentRevision || 0;
      return { matchedCount: 1 };
    };
    const token = jwt.sign({ id: mode === "admin" ? admin : owner, ...(mode === "admin" ? { role: "admin" } : {}) }, "test-secret");
    try {
      const response = await request(`${mode === "admin" ? "/admin" : ""}/propiedades/${propertyId}`, {
        method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json",
          "X-Forwarded-For": mode === "admin" ? "203.0.113.231" : "203.0.113.230" },
        body: mode === "admin" ? { visiblePublicamente: true } : { estadoComercial: "Disponible" }
      });
      assert.equal(response.status, available ? 200 : 403, response.text);
      assert.deepEqual(events, ["fence", "count"]);
      assert.equal(writes, available ? 1 : 0); assert.equal(version, available ? 1 : 0);
      if (!available) {
        assert.equal(JSON.parse(response.text).code, "PUBLICATION_PLAN_LIMIT");
        assert.doesNotMatch(response.text, /publicationVersion|WriteConflict|Mongo|stack/);
      }
    } finally {
      Usuario.findById = savedMethods.userFind; Usuario.updateOne = savedMethods.userUpdate; Usuario.startSession = savedMethods.session;
      Propiedad.findById = savedMethods.propertyFind; Propiedad.findOne = savedMethods.propertyOne;
      Propiedad.updateOne = savedMethods.propertyUpdate; Propiedad.countDocuments = savedMethods.count;
    }
  });
}
}

process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret";
process.env.RESEND_API_KEY = "re_test";
process.env.STRIPE_SECRET_KEY = "sk_test_123";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";

const { default: app } = await import("../server.js");
const { default: authRoutes } = await import("../routes/auth.js");
const { default: propiedadesRoutes } = await import("../routes/propiedades.js");
registerCapacityHttpTests();

function normalizeHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
}

function createReq(path, { method = "GET", headers = {}, body, rawBody } = {}) {
  const payload = rawBody !== undefined
    ? rawBody
    : (body === undefined ? "" : JSON.stringify(body));
  const normalizedHeaders = normalizeHeaders(headers);
  if (payload && !normalizedHeaders["content-length"]) {
    normalizedHeaders["content-length"] = String(Buffer.byteLength(payload));
  }
  const req = new Readable({
    read() {
      this.push(payload);
      this.push(null);
    }
  });
  req.method = method;
  req.url = path;
  req.originalUrl = path;
  req.headers = normalizedHeaders;
  req.complete = true;
  req.socket = new PassThrough();
  req.socket.remoteAddress = req.headers["x-forwarded-for"] || "127.0.0.1";
  req.connection = req.socket;
  return req;
}

function createRes(resolve) {
  const chunks = [];
  const headers = new Map();
  const res = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      callback();
    }
  });
  res.statusCode = 200;
  res.setHeader = (name, value) => headers.set(String(name).toLowerCase(), String(value));
  res.getHeader = name => headers.get(String(name).toLowerCase());
  res.getHeaders = () => Object.fromEntries(headers);
  res.removeHeader = name => headers.delete(String(name).toLowerCase());
  res.writeHead = (statusCode, reasonOrHeaders, maybeHeaders) => {
    res.statusCode = statusCode;
    const nextHeaders = typeof reasonOrHeaders === "object" ? reasonOrHeaders : maybeHeaders;
    Object.entries(nextHeaders || {}).forEach(([name, value]) => res.setHeader(name, value));
    return res;
  };
  res.sendFile = filePath => {
    fs.readFile(filePath, (error, data) => {
      if (error) {
        res.statusCode = 500;
        res.end("Error leyendo archivo");
        return;
      }
      res.end(data);
    });
    return res;
  };
  const originalEnd = res.end.bind(res);
  res.end = (chunk, encoding, callback) => {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    originalEnd(undefined, encoding, callback);
    resolve({
      status: res.statusCode,
      headers: {
        get(name) {
          return headers.get(String(name).toLowerCase()) || null;
        }
      },
      text: Buffer.concat(chunks).toString("utf8")
    });
    return res;
  };
  return res;
}

function request(path, options) {
  return new Promise((resolve, reject) => {
    const req = createReq(path, options);
    const res = createRes(resolve);
    app.handle(req, res, reject);
  });
}

function countOccurrences(text, pattern) {
  return (text.match(pattern) || []).length;
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractPageHeaderIntro(html = "") {
  return html.match(/<p class="page-header-intro"[^>]*>([\s\S]*?)<\/p>/i)?.[1]?.replace(/\s+/g, " ").trim() || "";
}

function getFieldValue(item, path) {
  return String(path).split(".").reduce((value, key) => value?.[key], item);
}

function matchesMongoCondition(value, condition) {
  if (condition && typeof condition === "object" && !Array.isArray(condition)) {
    if ("$regex" in condition) {
      return new RegExp(condition.$regex, condition.$options || "").test(String(value || ""));
    }
    if ("$exists" in condition) {
      return condition.$exists ? value !== undefined : value === undefined;
    }
    if ("$type" in condition && condition.$type === 10) return value === null;
    if ("$ne" in condition) {
      return value !== condition.$ne;
    }
    if ("$nin" in condition) {
      return !condition.$nin.includes(value);
    }
    if ("$in" in condition) {
      return condition.$in.includes(value);
    }
    if ("$gt" in condition) {
      return value !== undefined && value !== null && value > condition.$gt;
    }
    if ("$gte" in condition || "$lte" in condition) return typeof value === "number" &&
      (!("$gte" in condition) || value >= condition.$gte) && (!("$lte" in condition) || value <= condition.$lte);
    if ("$not" in condition) {
      return !matchesMongoCondition(value, condition.$not);
    }
  }

  return value === condition;
}

function matchesMongoFilter(item, filter = {}) {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === "$and") return condition.every(part => matchesMongoFilter(item, part));
    if (key === "$or") return condition.some(part => matchesMongoFilter(item, part));
    return matchesMongoCondition(getFieldValue(item, key), condition);
  });
}

function createMultipartBody({ fields = {}, files = [] } = {}) {
  const boundary = `----homeclick24-test-${Math.random().toString(16).slice(2)}`;
  const chunks = [];
  const push = value => chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value));

  for (const [name, value] of Object.entries(fields)) {
    push(`--${boundary}\r\n`);
    push(`Content-Disposition: form-data; name="${name}"\r\n\r\n`);
    push(String(value));
    push("\r\n");
  }

  for (const file of files) {
    push(`--${boundary}\r\n`);
    push(`Content-Disposition: form-data; name="${file.name || "imagenes"}"; filename="${file.filename || "foto.jpg"}"\r\n`);
    push(`Content-Type: ${file.contentType || "image/jpeg"}\r\n\r\n`);
    push(file.content || "imagen");
    push("\r\n");
  }

  push(`--${boundary}--\r\n`);
  return { boundary, body: Buffer.concat(chunks) };
}

function mockCloudinaryUpload({ destroyed = [], uploadedPrefix = "uploaded", onDestroy = () => {}, failDestroy = false } = {}) {
  const previousUploadStream = cloudinary.uploader.upload_stream;
  const previousDestroy = cloudinary.uploader.destroy;
  let uploadCount = 0;

  cloudinary.uploader.upload_stream = (...args) => {
    const callback = args.find(arg => typeof arg === "function");
    const current = uploadCount += 1;
    return new Writable({
      write(chunk, encoding, done) {
        done();
      },
      final(done) {
        callback(null, {
          secure_url: `https://res.cloudinary.com/demo/image/upload/v1700000000/miportal_inmobiliario/${uploadedPrefix}-${current}.jpg`,
          bytes: 123,
          public_id: `miportal_inmobiliario/${uploadedPrefix}-${current}`
        });
        done();
      }
    });
  };

  cloudinary.uploader.destroy = async publicId => {
    onDestroy(publicId);
    destroyed.push(publicId);
    if (failDestroy) throw new Error("cloudinary unavailable");
    return { result: "ok" };
  };

  const restore = () => {
    cloudinary.uploader.upload_stream = previousUploadStream;
    cloudinary.uploader.destroy = previousDestroy;
  };
  restore.getUploadCount = () => uploadCount;
  return restore;
}

function authHeaderFor(userId = "507f1f77bcf86cd799439099") {
  return { Authorization: `Bearer ${jwt.sign({ id: userId }, "test-secret")}` };
}

test("Express oculta X-Powered-By y Helmet añade cabeceras conservadoras", async () => {
  const response = await request("/robots.txt");

  assert.equal(response.headers.get("x-powered-by"), null);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.match(response.headers.get("strict-transport-security") || "", /max-age=15552000/);
  assert.equal(response.headers.get("content-security-policy"), null);
});

test("CORS de producción permite origen autorizado y rechaza origen no autorizado", async () => {
  const allowed = await request("/robots.txt", {
    headers: { Origin: "https://www.homeclick24.com" }
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://www.homeclick24.com");

  const rejected = await request("/robots.txt", {
    headers: { Origin: "https://evil.example" }
  });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.get("access-control-allow-origin"), null);
  assert.doesNotMatch(rejected.text, /secret|token|password/i);

  const similarOrigin = await request("/robots.txt", {
    headers: { Origin: "https://www.homeclick24.com.evil.example" }
  });
  assert.equal(similarOrigin.status, 403);
  assert.equal(similarOrigin.headers.get("access-control-allow-origin"), null);
});

test("CORS preflight permite origen autorizado y rechaza origen no autorizado", async () => {
  const allowed = await request("/auth/login", {
    method: "OPTIONS",
    headers: {
      Origin: "https://www.homeclick24.com",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "Authorization, Content-Type"
    }
  });

  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://www.homeclick24.com");
  assert.match(allowed.headers.get("access-control-allow-methods") || "", /POST/);
  assert.match(allowed.headers.get("access-control-allow-headers") || "", /Authorization/);
  assert.match(allowed.headers.get("access-control-allow-headers") || "", /Content-Type/);

  const rejected = await request("/auth/login", {
    method: "OPTIONS",
    headers: {
      Origin: "https://www.homeclick24.com.evil.example",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "Authorization, Content-Type"
    }
  });

  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.get("access-control-allow-origin"), null);
});

test("peticiones sin Origin siguen funcionando y Stripe webhook conserva raw body", async () => {
  const robots = await request("/robots.txt");
  assert.equal(robots.status, 200);

  const webhook = await request("/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: { type: "checkout.session.completed" }
  });
  assert.equal(webhook.status, 400);
  assert.match(webhook.text, /Webhook Error:/);
  assert.doesNotMatch(webhook.text, /invalid raw body/);
});

test("ruta SEO pública lee HTML con fs disponible", async () => {
  const response = await request("/comprar/cadiz");

  assert.equal(response.status, 200);
  assert.match(response.text, /https:\/\/www\.homeclick24\.com\/comprar\/cadiz/);
  assert.doesNotMatch(response.text, /Error generando propiedad|fs is not defined/i);
});

test("landing local de alquiler entrega SEO de Chipiona en el HTML inicial", async () => {
  const response = await request("/alquiler/chipiona");
  const context = getSeoZoneContext({ operacionPath: "alquiler", slug: "chipiona" });

  assert.equal(response.status, 200);
  assert.match(response.text, new RegExp(escapeRegExp(`<title>${context.title}</title>`)));
  assert.match(response.text, new RegExp(escapeRegExp(`<meta name="description" content="${context.description}">`)));
  assert.match(response.text, new RegExp(escapeRegExp(`<link rel="canonical" href="${context.canonical}">`)));
  assert.match(response.text, new RegExp(escapeRegExp(`<meta property="og:title" content="${context.title}">`)));
  assert.match(response.text, new RegExp(escapeRegExp(`<meta property="og:description" content="${context.description}">`)));
  assert.match(response.text, new RegExp(escapeRegExp(`<meta property="og:url" content="${context.canonical}">`)));
  assert.match(response.text, new RegExp(escapeRegExp(`<h1>${context.h1}</h1>`)));
  assert.equal(extractPageHeaderIntro(response.text), context.intro);
  assert.match(response.text, new RegExp(escapeRegExp(context.localContent)));
  assert.equal(countOccurrences(response.text, /rel="canonical"/g), 1);
  assert.doesNotMatch(response.text, /<link rel="canonical" href="https:\/\/www\.homeclick24\.com\/alquiler">/);
});

test("landing local de alquiler de Sanlúcar entrega override SEO en el HTML inicial", async () => {
  const response = await request("/alquiler/sanlucar-de-barrameda");
  const context = getSeoZoneContext({ operacionPath: "alquiler", slug: "sanlucar-de-barrameda" });

  assert.equal(response.status, 200);
  assert.equal(context.title, "Casas y pisos en alquiler en Sanlúcar de Barrameda | HomeClick24");
  assert.equal(context.description, "Consulta casas, pisos y viviendas en alquiler en Sanlúcar de Barrameda. Filtra por precio, habitaciones y características y contacta en HomeClick24.");
  assert.equal(context.canonical, "https://www.homeclick24.com/alquiler/sanlucar-de-barrameda");
  assert.equal(context.h1, "Casas y pisos en alquiler en Sanlúcar de Barrameda");
  assert.equal(context.intro, "Explora viviendas en alquiler en Sanlúcar de Barrameda, compara casas y pisos disponibles y usa los filtros por precio, habitaciones y características antes de contactar.");
  assert.match(response.text, new RegExp(escapeRegExp(`<title>${context.title}</title>`)));
  assert.match(response.text, new RegExp(escapeRegExp(`<meta name="description" content="${context.description}">`)));
  assert.match(response.text, new RegExp(escapeRegExp(`<link rel="canonical" href="${context.canonical}">`)));
  assert.match(response.text, new RegExp(escapeRegExp(`<h1>${context.h1}</h1>`)));
  assert.equal(extractPageHeaderIntro(response.text), context.intro);
  assert.match(response.text, new RegExp(escapeRegExp(`<meta property="og:title" content="${context.title}">`)));
  assert.match(response.text, new RegExp(escapeRegExp(`<meta property="og:description" content="${context.description}">`)));
  assert.match(response.text, new RegExp(escapeRegExp(`<meta property="og:url" content="${context.canonical}">`)));
  assert.match(response.text, new RegExp(escapeRegExp(`<meta name="twitter:title" content="${context.title}">`)));
  assert.match(response.text, new RegExp(escapeRegExp(`<meta name="twitter:description" content="${context.description}">`)));
  assert.match(response.text, /<script id="seo-zone-context" type="application\/json">/);
  assert.equal(countOccurrences(response.text, /rel="canonical"/g), 1);
  assert.doesNotMatch(response.text, /<link rel="canonical" href="https:\/\/www\.homeclick24\.com\/alquiler">/);
});

test("landing local de compra entrega SEO de Chipiona en el HTML inicial", async () => {
  const response = await request("/comprar/chipiona");
  const context = getSeoZoneContext({ operacionPath: "comprar", slug: "chipiona" });

  assert.equal(response.status, 200);
  assert.match(response.text, new RegExp(escapeRegExp(`<title>${context.title}</title>`)));
  assert.match(response.text, new RegExp(escapeRegExp(`<meta name="description" content="${context.description}">`)));
  assert.match(response.text, new RegExp(escapeRegExp(`<link rel="canonical" href="${context.canonical}">`)));
  assert.match(response.text, new RegExp(escapeRegExp(`<meta property="og:title" content="${context.title}">`)));
  assert.match(response.text, new RegExp(escapeRegExp(`<meta property="og:description" content="${context.description}">`)));
  assert.match(response.text, new RegExp(escapeRegExp(`<h1>${context.h1}</h1>`)));
  assert.equal(extractPageHeaderIntro(response.text), context.intro);
  assert.match(response.text, new RegExp(escapeRegExp(context.localContent)));
  assert.equal(countOccurrences(response.text, /rel="canonical"/g), 1);
  assert.doesNotMatch(response.text, /<link rel="canonical" href="https:\/\/www\.homeclick24\.com\/comprar">/);
});

test("landing de compra en Cádiz usa SEO específico sin afectar Chipiona", async () => {
  const cadiz = await request("/comprar/cadiz");
  const chipiona = await request("/comprar/chipiona");
  const context = getSeoZoneContext({ operacionPath: "comprar", slug: "cadiz" });

  assert.equal(cadiz.status, 200);
  assert.equal(context.title, "Casas y viviendas en venta en Cádiz | HomeClick24");
  assert.equal(context.description, "Compra casas, pisos y viviendas en Cádiz capital. Consulta anuncios reales de particulares, agentes y agencias en el portal inmobiliario HomeClick24.");
  assert.equal(context.h1, "Pisos y casas en venta en Cádiz");
  assert.equal(context.canonical, "https://www.homeclick24.com/comprar/cadiz");
  assert.match(cadiz.text, new RegExp(escapeRegExp(`<title>${context.title}</title>`)));
  assert.match(cadiz.text, new RegExp(escapeRegExp(`<meta name="description" content="${context.description}">`)));
  assert.match(cadiz.text, new RegExp(escapeRegExp(`<h1>${context.h1}</h1>`)));
  assert.match(cadiz.text, new RegExp(escapeRegExp(`<link rel="canonical" href="${context.canonical}">`)));
  assert.match(cadiz.text, /Comprar vivienda en Cádiz capital/);
  assert.match(cadiz.text, /casas en venta en Cádiz/);
  assert.match(cadiz.text, /portal inmobiliario/);
  assert.match(cadiz.text, /href="\/comprar"/);
  assert.match(cadiz.text, /href="\/alquiler\/cadiz"/);
  assert.match(cadiz.text, /href="\/publicar\.html"/);
  assert.match(cadiz.text, /Actualmente no hay inmuebles disponibles en venta en Cádiz capital/);

  assert.equal(chipiona.status, 200);
  assert.doesNotMatch(chipiona.text, /Comprar vivienda en Cádiz capital/);
  assert.doesNotMatch(chipiona.text, /Actualmente no hay inmuebles disponibles en venta en Cádiz capital/);
  assert.doesNotMatch(chipiona.text, /Compra casas, pisos y viviendas en Cádiz capital/);
});

test("SEO local se genera de forma genérica para otra zona configurada", async () => {
  const response = await request("/alquiler/rota");
  const context = getSeoZoneContext({ operacionPath: "alquiler", slug: "rota" });

  assert.equal(response.status, 200);
  assert.match(response.text, new RegExp(escapeRegExp(`<title>${context.title}</title>`)));
  assert.match(response.text, new RegExp(escapeRegExp(`<h1>${context.h1}</h1>`)));
  assert.match(response.text, new RegExp(escapeRegExp(context.localContent)));
});

test("override SEO de Sanlúcar alquiler no afecta Sanlúcar compra", async () => {
  const response = await request("/comprar/sanlucar-de-barrameda");
  const context = getSeoZoneContext({ operacionPath: "comprar", slug: "sanlucar-de-barrameda" });

  assert.equal(response.status, 200);
  assert.equal(context.title, "Pisos y casas en venta en Sanlúcar de Barrameda | HomeClick24");
  assert.equal(context.h1, "Pisos y casas en venta en Sanlúcar de Barrameda");
  assert.match(response.text, new RegExp(escapeRegExp(`<title>${context.title}</title>`)));
  assert.match(response.text, new RegExp(escapeRegExp(`<h1>${context.h1}</h1>`)));
  assert.doesNotMatch(response.text, /Casas y pisos en alquiler en Sanlúcar de Barrameda/);
});

test("filtro zona separa Cádiz capital de otros municipios de la provincia", async () => {
  const previousFind = Propiedad.find;
  const propiedades = [
    {
      _id: "chipiona-legacy",
      titulo: "Casa en Chipiona",
      direccion: "Avenida de Regla, Chipiona, Cádiz, Andalucía, España",
      tipoOperacion: "venta"
    },
    {
      _id: "rota-legacy",
      titulo: "Casa en Rota",
      direccion: "Calle Mina, Rota, Cádiz, Andalucía, España",
      tipoOperacion: "venta"
    },
    {
      _id: "sanlucar-legacy",
      titulo: "Piso en Sanlúcar",
      direccion: "Avenida Rocío Jurado, Sanlúcar de Barrameda, Cádiz, Andalucía, España",
      tipoOperacion: "venta"
    },
    {
      _id: "puerto-legacy",
      titulo: "Casa en El Puerto",
      direccion: "Calle Larga, El Puerto de Santa María, Cádiz, Andalucía, España",
      tipoOperacion: "venta"
    },
    {
      _id: "jerez-legacy",
      titulo: "Piso en Jerez",
      direccion: "Calle Honda, Jerez de la Frontera, Cádiz, Andalucía, España",
      tipoOperacion: "venta"
    },
    {
      _id: "cadiz-capital-legacy",
      titulo: "Piso en Cádiz capital",
      direccion: "Calle Ancha, Cádiz, Andalucía, España",
      tipoOperacion: "venta"
    },
    {
      _id: "cadiz-estructurada",
      titulo: "Oportunidad en Chipiona mencionada en el título",
      direccion: "Calle Sacramento, Cádiz, Andalucía, España",
      localidad: "Cádiz",
      provincia: "Cádiz",
      tipoOperacion: "venta"
    },
    {
      _id: "chipiona-estructurada",
      titulo: "Casa anunciada también para Cádiz",
      direccion: "Calle larga, Cádiz, Andalucía, España",
      localidad: "Chipiona",
      provincia: "Cádiz",
      tipoOperacion: "venta"
    }
  ];

  Propiedad.find = filtro => ({
    sort: () => ({
      lean: () => Promise.resolve(propiedades.filter(propiedad => matchesMongoFilter(propiedad, filtro)))
    })
  });

  try {
    const chipiona = await request("/propiedades?tipo=venta&zona=chipiona");
    const cadiz = await request("/propiedades?tipo=venta&zona=cadiz");

    assert.equal(chipiona.status, 200);
    assert.equal(cadiz.status, 200);

    const chipionaIds = JSON.parse(chipiona.text).map(propiedad => propiedad._id);
    const cadizIds = JSON.parse(cadiz.text).map(propiedad => propiedad._id);

    assert.deepEqual(new Set(chipionaIds), new Set(["chipiona-legacy", "chipiona-estructurada"]));
    assert.deepEqual(new Set(cadizIds), new Set(["cadiz-capital-legacy", "cadiz-estructurada"]));
    assert.equal(cadizIds.includes("chipiona-legacy"), false);
    assert.equal(cadizIds.includes("rota-legacy"), false);
    assert.equal(cadizIds.includes("sanlucar-legacy"), false);
    assert.equal(cadizIds.includes("puerto-legacy"), false);
    assert.equal(cadizIds.includes("jerez-legacy"), false);
  } finally {
    Propiedad.find = previousFind;
  }
});

test("landings generales de compra y alquiler mantienen SEO general", async () => {
  const alquiler = await request("/alquiler");
  const comprar = await request("/comprar");

  assert.equal(alquiler.status, 200);
  assert.match(alquiler.text, /<title>Pisos y Casas en Alquiler en España — Alquilar Vivienda \| HomeClick24<\/title>/);
  assert.match(alquiler.text, /<link rel="canonical" href="https:\/\/www\.homeclick24\.com\/alquiler">/);
  assert.match(alquiler.text, /<h1>Viviendas en alquiler<\/h1>/);
  assert.doesNotMatch(alquiler.text, /id="seo-zone-context"/);

  assert.equal(comprar.status, 200);
  assert.match(comprar.text, /<title>Pisos y Casas en Venta en España — Comprar Vivienda \| HomeClick24<\/title>/);
  assert.match(comprar.text, /<link rel="canonical" href="https:\/\/www\.homeclick24\.com\/comprar">/);
  assert.match(comprar.text, /<h1>Viviendas en venta<\/h1>/);
  assert.doesNotMatch(comprar.text, /id="seo-zone-context"/);
});

test("home usa raíz canónica y /index.html redirige a /", async () => {
  const home = await request("/");
  const legacy = await request("/index.html");

  assert.equal(home.status, 200);
  assert.match(home.text, /<link rel="canonical" href="https:\/\/www\.homeclick24\.com\/">/);
  assert.equal(legacy.status, 301);
  assert.equal(legacy.headers.get("location"), "/");
});

test("URLs SEO locales antiguas redirigen 301 a rutas limpias", async () => {
  const redirects = [
    ["/venta-chipiona.html", "/comprar/chipiona"],
    ["/venta-el-puerto-de-santa-maria.html", "/comprar/el-puerto-de-santa-maria"],
    ["/alquiler-chipiona.html", "/alquiler/chipiona"],
    ["/alquiler-rota.html", "/alquiler/rota"]
  ];

  for (const [legacyUrl, canonicalUrl] of redirects) {
    const response = await request(legacyUrl);

    assert.equal(response.status, 301);
    assert.equal(response.headers.get("location"), canonicalUrl);
  }
});

test("publicar sigue disponible pero queda fuera del índice", async () => {
  const response = await request("/publicar");

  assert.equal(response.status, 200);
  assert.match(response.text, /<meta name="robots" content="noindex, follow">/);
  assert.match(response.text, /<link rel="canonical" href="https:\/\/www\.homeclick24\.com\/publicar">/);
  assert.match(response.text, /if \(!token\)[\s\S]*redirigirLoginPublicar\(\)/);
});

test("contacto usa URL limpia con canonical y redirección legacy", async () => {
  const limpia = await request("/contacto");
  const legacy = await request("/contacto.html");

  assert.equal(limpia.status, 200);
  assert.match(limpia.text, /<title>Contacto — HomeClick24<\/title>/);
  assert.match(limpia.text, /<link rel="canonical" href="https:\/\/www\.homeclick24\.com\/contacto">/);
  assert.match(limpia.text, /<meta property="og:url" content="https:\/\/www\.homeclick24\.com\/contacto">/);
  assert.doesNotMatch(limpia.text, /https:\/\/www\.homeclick24\.com\/contacto\.html/);

  assert.equal(legacy.status, 301);
  assert.equal(legacy.headers.get("location"), "/contacto");
});

test("detalle público de propiedad genera HTML sin fallar por fs", async () => {
  const previousFindOne = Propiedad.findOne;
  const id = "507f1f77bcf86cd799439099";
  Propiedad.findOne = () => ({
    lean: () => Promise.resolve({
      _id: id,
      titulo: "Casa Test",
      direccion: "Calle Test",
      precio: 123000,
      descripcion: "Detalle de prueba",
      imagenes: []
    })
  });

  try {
    const response = await request(`/propiedad/casa-test-${id}`);

    assert.equal(response.status, 200);
    assert.match(response.text, /Casa Test/);
    assert.match(response.text, new RegExp(`https://www\\.homeclick24\\.com/propiedad/casa-test-${id}`));
    assert.doesNotMatch(response.text, /Error generando propiedad|fs is not defined/i);
  } finally {
    Propiedad.findOne = previousFindOne;
  }
});

test("URL legacy de propiedad existente redirige 301 a la canónica", async () => {
  const previousFindOne = Propiedad.findOne;
  const id = "507f1f77bcf86cd799439100";
  Propiedad.findOne = () => ({
    lean: () => Promise.resolve({
      _id: id,
      titulo: "Ático junto al mar",
      visiblePublicamente: true
    })
  });

  try {
    const response = await request(`/propiedad?id=${id}`);

    assert.equal(response.status, 301);
    assert.equal(response.headers.get("location"), `/propiedad/atico-junto-al-mar-${id}`);
  } finally {
    Propiedad.findOne = previousFindOne;
  }
});

test("URL legacy propiedad.html existente redirige 301 a la canónica", async () => {
  const previousFindOne = Propiedad.findOne;
  const id = "507f1f77bcf86cd799439104";
  Propiedad.findOne = () => ({
    lean: () => Promise.resolve({
      _id: id,
      titulo: "Piso luminoso en el centro",
      visiblePublicamente: true
    })
  });

  try {
    const response = await request(`/propiedad.html?id=${id}`);

    assert.equal(response.status, 301);
    assert.equal(response.headers.get("location"), `/propiedad/piso-luminoso-en-el-centro-${id}`);
  } finally {
    Propiedad.findOne = previousFindOne;
  }
});

test("fallback SEO mínimo propiedad-ID resuelve por ID y redirige a la canónica real", async () => {
  const previousFindOne = Propiedad.findOne;
  const id = "507f1f77bcf86cd799439103";
  Propiedad.findOne = () => ({
    lean: () => Promise.resolve({
      _id: id,
      titulo: "Chalet familiar en Costa Ballena",
      visiblePublicamente: true
    })
  });

  try {
    const response = await request(`/propiedad/propiedad-${id}`);

    assert.equal(response.status, 301);
    assert.equal(response.headers.get("location"), `/propiedad/chalet-familiar-en-costa-ballena-${id}`);
  } finally {
    Propiedad.findOne = previousFindOne;
  }
});

test("URL legacy propiedad.html inexistente mantiene 404 sin redirigir a comprar", async () => {
  const previousFindOne = Propiedad.findOne;
  const id = "507f1f77bcf86cd799439105";
  Propiedad.findOne = () => ({
    lean: () => Promise.resolve(null)
  });

  try {
    const response = await request(`/propiedad.html?id=${id}`);

    assert.equal(response.status, 404);
    assert.equal(response.headers.get("location"), null);
  } finally {
    Propiedad.findOne = previousFindOne;
  }
});

test("URL legacy propiedad.html sin id o con id inválido devuelve 404", async () => {
  const previousFindOne = Propiedad.findOne;
  let consultas = 0;
  Propiedad.findOne = () => {
    consultas += 1;
    return {
      lean: () => Promise.resolve(null)
    };
  };

  try {
    const sinId = await request("/propiedad.html");
    const invalida = await request("/propiedad.html?id=no-es-un-objectid");

    assert.equal(sinId.status, 404);
    assert.equal(sinId.headers.get("location"), null);
    assert.equal(invalida.status, 404);
    assert.equal(invalida.headers.get("location"), null);
    assert.equal(consultas, 0);
  } finally {
    Propiedad.findOne = previousFindOne;
  }
});

test("URL legacy propiedad.html aplica filtros de pública y no caducada", async () => {
  const previousFindOne = Propiedad.findOne;
  const id = "507f1f77bcf86cd799439106";
  let filtroRecibido = null;
  Propiedad.findOne = filtro => {
    filtroRecibido = filtro;
    return {
      lean: () => Promise.resolve(null)
    };
  };

  try {
    const response = await request(`/propiedad.html?id=${id}`);

    assert.equal(response.status, 404);
    assert.equal(response.headers.get("location"), null);
    assert.deepEqual(filtroRecibido?._id, id);
    assert.deepEqual(filtroRecibido?.visiblePublicamente, { $ne: false });
    assert.ok(Array.isArray(filtroRecibido?.$or));
    assert.ok(filtroRecibido.$or.some(cond => cond.fechaExpiracion?.$exists === false));
    assert.ok(filtroRecibido.$or.some(cond => cond.fechaExpiracion === null));
    assert.ok(filtroRecibido.$or.some(cond => cond.fechaExpiracion?.$gt instanceof Date));
  } finally {
    Propiedad.findOne = previousFindOne;
  }
});

test("URL legacy de propiedad inexistente mantiene 404 sin redirección genérica", async () => {
  const previousFindOne = Propiedad.findOne;
  const id = "507f1f77bcf86cd799439101";
  Propiedad.findOne = () => ({
    lean: () => Promise.resolve(null)
  });

  try {
    const response = await request(`/propiedad?id=${id}`);

    assert.equal(response.status, 404);
    assert.equal(response.headers.get("location"), null);
  } finally {
    Propiedad.findOne = previousFindOne;
  }
});

test("sitemap publica propiedades con URLs limpias y sin formato legacy", async () => {
  const previousFind = Propiedad.find;
  const id = "507f1f77bcf86cd799439102";
  Propiedad.find = () => ({
    lean: () => Promise.resolve([{
      _id: id,
      titulo: "Casa familiar en Rota",
      updatedAt: new Date("2026-01-15T00:00:00.000Z")
    }])
  });

  try {
    const response = await request("/sitemap.xml");

    assert.equal(response.status, 200);
    assert.match(response.text, new RegExp(`/propiedad/casa-familiar-en-rota-${id}`));
    assert.equal(countOccurrences(response.text, /https:\/\/www\.homeclick24\.com\/alquiler\/chipiona/g), 1);
    assert.equal(countOccurrences(response.text, /https:\/\/www\.homeclick24\.com\/comprar\/chipiona/g), 1);
    assert.equal(countOccurrences(response.text, /https:\/\/www\.homeclick24\.com\/contacto/g), 1);
    assert.doesNotMatch(response.text, /\/index\.html/);
    assert.doesNotMatch(response.text, /https:\/\/www\.homeclick24\.com\/publicar/);
    assert.doesNotMatch(response.text, /\/alquiler-chipiona\.html/);
    assert.doesNotMatch(response.text, /\/venta-chipiona\.html/);
    assert.doesNotMatch(response.text, /\/contacto\.html/);
    assert.doesNotMatch(response.text, /\/propiedad\?id=/);
    assert.doesNotMatch(response.text, /\/propiedad\.html\?id=/);
  } finally {
    Propiedad.find = previousFind;
  }
});

test("GET /propiedades/mias/:id carga edición solo para propietario sin tocar Cloudinary", async () => {
  const previousFindByIdUsuario = Usuario.findById;
  const previousFindByIdPropiedad = Propiedad.findById;
  const previousDestroy = cloudinary.uploader.destroy;
  const destroyed = [];
  const imagenes = [
    "https://res.cloudinary.com/demo/image/upload/v1700000000/miportal_inmobiliario/original-a.jpg",
    "https://res.cloudinary.com/demo/image/upload/v1700000000/miportal_inmobiliario/original-b.webp"
  ];
  const propiedad = {
    _id: "507f1f77bcf86cd799439088",
    usuarioId: "507f1f77bcf86cd799439099",
    titulo: "Casa editable",
    referencia: "REF-1",
    direccion: "Calle Editar 1",
    precio: 180000,
    descripcion: "Descripción editable",
    tipoOperacion: "venta",
    habitaciones: 3,
    banos: 2,
    superficie: 90,
    tipoInmueble: "piso",
    estado: "segunda_mano",
    estadoComercial: "Disponible",
    certificadoEnergetico: "C",
    lat: 36.77,
    lng: -6.35,
    imagenes
  };

  Usuario.findById = id => Promise.resolve({
    _id: { toString: () => String(id) },
    activo: true,
    plan: "gratis",
    planActivo: true
  });
  Propiedad.findById = () => Promise.resolve(propiedad);
  cloudinary.uploader.destroy = async publicId => {
    destroyed.push(publicId);
    return { result: "ok" };
  };

  try {
    const propia = await request("/propiedades/mias/507f1f77bcf86cd799439088", {
      headers: authHeaderFor("507f1f77bcf86cd799439099")
    });
    const data = JSON.parse(propia.text);

    assert.equal(propia.status, 200);
    assert.equal(data.titulo, "Casa editable");
    assert.equal(data.direccion, "Calle Editar 1");
    assert.equal(data.precio, 180000);
    assert.equal(data.lat, 36.77);
    assert.equal(data.lng, -6.35);
    assert.deepEqual(data.imagenes, imagenes);
    assert.deepEqual(destroyed, []);

    const ajena = await request("/propiedades/mias/507f1f77bcf86cd799439088", {
      headers: authHeaderFor("507f1f77bcf86cd799439077")
    });

    assert.equal(ajena.status, 403);
  } finally {
    Usuario.findById = previousFindByIdUsuario;
    Propiedad.findById = previousFindByIdPropiedad;
    cloudinary.uploader.destroy = previousDestroy;
  }
});

test("POST /propiedades limpia nueva imagen si falla validación tras subida", async () => {
  const previousFindById = Usuario.findById;
  const destroyed = [];
  const restoreCloudinary = mockCloudinaryUpload({ destroyed });
  Usuario.findById = () => Promise.resolve({
    _id: { toString: () => "507f1f77bcf86cd799439099" },
    activo: true,
    plan: "gratis",
    planActivo: true
  });
  const multipart = createMultipartBody({
    fields: { titulo: "Casa" },
    files: [{ content: "jpg" }]
  });

  try {
    const response = await request("/propiedades", {
      method: "POST",
      headers: {
        ...authHeaderFor(),
        "Content-Type": `multipart/form-data; boundary=${multipart.boundary}`,
        "X-Forwarded-For": "203.0.113.80"
      },
      rawBody: multipart.body
    });

    assert.equal(response.status, 400);
    assert.deepEqual(destroyed, ["miportal_inmobiliario/uploaded-1"]);
    assert.doesNotMatch(response.text, /CLOUDINARY|api_secret|stack|secret/i);
  } finally {
    Usuario.findById = previousFindById;
    restoreCloudinary();
  }
});

test("POST /propiedades guarda localidad provincia y codigoPostal", async () => {
  const previousFindByIdUsuario = Usuario.findById;
  const previousCountDocuments = Propiedad.countDocuments;
  const previousCreate = Propiedad.create;
  const previousStartSession = Usuario.startSession;
  const previousUpdateUsuario = Usuario.updateOne;
  const previousAlertaFind = Alerta.find;
  const previousNotificacionCreate = Notificacion.create;
  let createdPayload = null;

  Usuario.findById = () => Promise.resolve({
    _id: { toString: () => "507f1f77bcf86cd799439099" },
    activo: true,
    plan: "gratis",
    planActivo: true
  });
  Propiedad.countDocuments = async () => 0;
  Usuario.startSession = async () => ({ withTransaction: async action => action(), endSession: async () => {} });
  Usuario.updateOne = async () => ({ matchedCount: 1 });
  Propiedad.create = async payload => {
    createdPayload = payload[0];
    return [{
      _id: { toString: () => "507f1f77bcf86cd799439088" },
      ...payload[0]
    }];
  };
  Alerta.find = async () => [];
  Notificacion.create = async () => ({});

  const multipart = createMultipartBody({
    fields: {
      titulo: "Casa en Chipiona",
      direccion: "Avenida de Regla, Chipiona, Cádiz",
      localidad: "Chipiona",
      provincia: "Cádiz",
      codigoPostal: "11550",
      precio: "100000",
      tipoOperacion: "venta",
      habitaciones: "2"
    }
  });

  try {
    const response = await request("/propiedades", {
      method: "POST",
      headers: {
        ...authHeaderFor(),
        "Content-Type": `multipart/form-data; boundary=${multipart.boundary}`,
        "X-Forwarded-For": "203.0.113.98"
      },
      rawBody: multipart.body
    });

    assert.equal(response.status, 201);
    assert.equal(createdPayload.localidad, "Chipiona");
    assert.equal(createdPayload.provincia, "Cádiz");
    assert.equal(createdPayload.codigoPostal, "11550");
  } finally {
    Usuario.findById = previousFindByIdUsuario;
    Propiedad.countDocuments = previousCountDocuments;
    Propiedad.create = previousCreate;
    Usuario.startSession = previousStartSession;
    Usuario.updateOne = previousUpdateUsuario;
    Alerta.find = previousAlertaFind;
    Notificacion.create = previousNotificacionCreate;
  }
});

for (const mode of ["failed", "stored", "unknown", "reconciliation_failed", "normal"]) {
  test(`POST /propiedades reconciliación manual: ${mode}`, async () => {
    const replacements = [];
    const replace = (object, key, value) => { replacements.push([object, key, object[key]]); object[key] = value; };
    const destroyed = [];
    const restoreCloudinary = mockCloudinaryUpload({ destroyed, uploadedPrefix: `manual-${mode}` });
    const records = [];
    const logs = [];
    let attempted;
    replace(Usuario, "findById", async () => ({ _id: "507f1f77bcf86cd799439099", plan: "gratis", planActivo: true, activo: true }));
    replace(Usuario, "startSession", async () => ({ withTransaction: async action => action(), endSession: async () => {} }));
    replace(Usuario, "updateOne", async () => ({ matchedCount: 1 }));
    replace(Propiedad, "countDocuments", async () => 0);
    replace(Propiedad, "create", async documents => {
      attempted = documents[0];
      if (mode !== "normal") throw new Error("sensitive MongoDB credentials");
      return documents;
    });
    replace(Propiedad, "findById", async id => {
      assert.equal(String(id), String(attempted._id));
      if (["unknown", "reconciliation_failed"].includes(mode)) throw new Error("sensitive connection details");
      return mode === "stored" ? attempted : null;
    });
    replace(ImportReconciliation, "init", async () => {});
    replace(ImportReconciliation, "updateOne", async (filter, update, options) => {
      if (mode === "reconciliation_failed") throw new Error("secret reconciliation failure");
      assert.equal(options.upsert, true);
      assert.equal(String(filter.propiedadId), String(attempted._id));
      records.push(update.$setOnInsert);
    });
    replace(Alerta, "find", async () => []);
    replace(Notificacion, "create", async () => ({}));
    replace(console, "warn", (...args) => logs.push(args));
    replace(console, "error", (...args) => logs.push(args));
    const multipart = createMultipartBody({ fields: {
      titulo: "Prueba manual", direccion: "Chipiona", precio: "100000", tipoOperacion: "venta", habitaciones: "2"
    }, files: [{ field: "imagenes", filename: "foto.jpg", contentType: "image/jpeg", content: "fake image" }] });
    try {
      const response = await request("/propiedades", { method: "POST", headers: {
        ...authHeaderFor(), "Content-Type": `multipart/form-data; boundary=${multipart.boundary}`,
        "X-Forwarded-For": `203.0.113.${180 + ["failed", "stored", "unknown", "reconciliation_failed", "normal"].indexOf(mode)}`
      }, rawBody: multipart.body });
      assert.ok(attempted._id);
      assert.equal(restoreCloudinary.getUploadCount(), 1);
      if (mode === "failed") {
        assert.equal(response.status, 500); assert.equal(destroyed.length, 1); assert.equal(records.length, 0);
      } else if (["stored", "normal"].includes(mode)) {
        assert.equal(response.status, 201); assert.equal(destroyed.length, 0); assert.equal(records.length, 0);
        assert.equal(JSON.parse(response.text)._id, String(attempted._id));
      } else {
        assert.equal(response.status, 503); assert.equal(destroyed.length, 0);
        assert.match(JSON.parse(response.text).error, /No se pudo confirmar la publicación/);
        assert.doesNotMatch(response.text, /sensitive|secret|MongoDB|reconciliación|_id/);
        assert.doesNotMatch(JSON.stringify(logs), /sensitive|secret|credentials|connection details/);
        if (mode === "unknown") {
          assert.equal(records.length, 1);
          assert.equal(records[0].usuarioId, "507f1f77bcf86cd799439099");
          assert.equal(String(records[0].propiedadId), String(attempted._id));
          assert.equal(records[0].source, "manual"); assert.equal(records[0].state, "unknown");
          assert.equal(records[0].externalId, String(attempted._id));
          assert.deepEqual(records[0].publicIds, ["miportal_inmobiliario/manual-unknown-1"]);
          assert.equal(records[0].reasonCode, "PERSISTENCE_UNCONFIRMED");
          assert.ok(records[0].createdAt instanceof Date);
          assert.doesNotMatch(JSON.stringify(records), /https:|sensitive|secret/);
        } else {
          assert.equal(records.length, 0);
          assert.ok(JSON.stringify(logs).includes("RECONCILIATION_RECORD_FAILED"));
        }
      }
    } finally {
      for (const [object, key, original] of replacements.reverse()) object[key] = original;
      restoreCloudinary();
    }
  });
}

test("reconciliación manual admite varias publicaciones sin cambiar índices CRM", () => {
  const user = "507f1f77bcf86cd799439099";
  const records = ["507f1f77bcf86cd799439088", "507f1f77bcf86cd799439077"].map(id => new ImportReconciliation({
    usuarioId: user, propiedadId: id, source: "manual", externalId: id, publicIds: [], state: "unknown"
  }));
  for (const record of records) assert.equal(record.validateSync(), undefined);
  assert.notEqual(records[0].externalId, records[1].externalId);
  const crm = new ImportReconciliation({ usuarioId: user, propiedadId: records[0].propiedadId, externalId: "CRM-1" });
  assert.equal(crm.source, "crm"); assert.ok(crm.validateSync().errors.importSourceId);
  assert.deepEqual(ImportReconciliation.schema.indexes().find(([fields]) => fields.externalId)[0], { usuarioId: 1, importSourceId: 1, externalId: 1 });
});

test("reconciliación manual guarda solo identificadores y códigos seguros de forma idempotente", async () => {
  const records = new Map(); const logs = [];
  const input = {
    usuarioId: "507f1f77bcf86cd799439099", propertyId: "507f1f77bcf86cd799439088",
    files: [{ public_id: "miportal_inmobiliario/test-manual", path: "https://res.cloudinary.com/demo/image/upload/v1/miportal_inmobiliario/test-manual.jpg?signature=secret#private" }],
    error: { cause: { message: "sensitive credentials", hasErrorLabel: label => label === "UnknownTransactionCommitResult" } }
  };
  const dependencies = {
    ReconciliationModel: { init: async () => {}, updateOne: async (filter, update, options) => {
      assert.equal(options.upsert, true);
      if (!records.has(String(filter.propiedadId))) records.set(String(filter.propiedadId), update.$setOnInsert);
    } }, logger: { warn: (...args) => logs.push(args), error: (...args) => logs.push(args) }
  };
  assert.equal(await recordManualPublicationUncertainty(input, dependencies), true);
  assert.equal(await recordManualPublicationUncertainty(input, dependencies), true);
  assert.equal(records.size, 1);
  const record = [...records.values()][0];
  assert.deepEqual(record.publicIds, ["miportal_inmobiliario/test-manual"]);
  assert.equal(record.reasonCode, "UNKNOWN_TRANSACTION_COMMIT_RESULT");
  assert.doesNotMatch(JSON.stringify([record, logs]), /https:|signature|secret|private|sensitive|credentials/);
});

test("PUT /propiedades/:id comprueba ownership antes de subir archivos", async () => {
  const previousFindByIdUsuario = Usuario.findById;
  const previousFindByIdPropiedad = Propiedad.findById;
  const destroyed = [];
  const restoreCloudinary = mockCloudinaryUpload({ destroyed });
  Usuario.findById = () => Promise.resolve({
    _id: { toString: () => "507f1f77bcf86cd799439099" },
    activo: true,
    plan: "gratis",
    planActivo: true
  });
  Propiedad.findById = () => Promise.resolve({
    _id: "507f1f77bcf86cd799439088",
    usuarioId: "507f1f77bcf86cd799439077",
    imagenes: []
  });
  const multipart = createMultipartBody({
    fields: { titulo: "Casa editada" },
    files: [{ content: "jpg" }]
  });

  try {
    const response = await request("/propiedades/507f1f77bcf86cd799439088", {
      method: "PUT",
      headers: {
        ...authHeaderFor(),
        "Content-Type": `multipart/form-data; boundary=${multipart.boundary}`,
        "X-Forwarded-For": "203.0.113.81"
      },
      rawBody: multipart.body
    });

    assert.equal(response.status, 403);
    assert.equal(restoreCloudinary.getUploadCount(), 0);
    assert.deepEqual(destroyed, []);
  } finally {
    Usuario.findById = previousFindByIdUsuario;
    Propiedad.findById = previousFindByIdPropiedad;
    restoreCloudinary();
  }
});

test("PUT conserva imágenes si imagenesExistentes está ausente", async () => {
  const previousFindByIdUsuario = Usuario.findById;
  const previousFindByIdPropiedad = Propiedad.findById;
  const originalImages = [
    "https://res.cloudinary.com/demo/image/upload/v1/miportal_inmobiliario/original-a.jpg"
  ];
  const propiedad = {
    _id: "507f1f77bcf86cd799439088",
    usuarioId: "507f1f77bcf86cd799439099",
    imagenes: [...originalImages],
    save: async () => propiedad
  };
  Usuario.findById = () => Promise.resolve({
    _id: { toString: () => "507f1f77bcf86cd799439099" },
    activo: true,
    plan: "gratis",
    planActivo: true
  });
  Propiedad.findById = () => Promise.resolve(propiedad);
  const multipart = createMultipartBody({
    fields: {
      titulo: "Casa",
      direccion: "Calle Test",
      precio: "100000",
      tipoOperacion: "venta",
      habitaciones: "2"
    }
  });

  try {
    const response = await request("/propiedades/507f1f77bcf86cd799439088", {
      method: "PUT",
      headers: {
        ...authHeaderFor(),
        "Content-Type": `multipart/form-data; boundary=${multipart.boundary}`,
        "X-Forwarded-For": "203.0.113.82"
      },
      rawBody: multipart.body
    });

    assert.equal(response.status, 200);
    assert.deepEqual(propiedad.imagenes, originalImages);
  } finally {
    Usuario.findById = previousFindByIdUsuario;
    Propiedad.findById = previousFindByIdPropiedad;
  }
});

test("visitas y estadísticas de redes no incrementan contentRevision", async () => {
  const previousUpdate = Propiedad.findByIdAndUpdate;
  const previousUser = Usuario.findById;
  const updates = [];
  const propiedad = { _id: "507f1f77bcf86cd799439088", contentRevision: 7, imagenes: [], visiblePublicamente: true };
  Propiedad.findByIdAndUpdate = async (id, update) => { updates.push(update); return propiedad; };
  Usuario.findById = async () => ({ _id: "507f1f77bcf86cd799439012", activo: true, role: "admin" });
  try {
    assert.equal((await request("/propiedades/507f1f77bcf86cd799439088")).status, 200);
    const token = jwt.sign({ id: "507f1f77bcf86cd799439012", role: "admin" }, "test-secret");
    assert.equal((await request("/admin/propiedades/507f1f77bcf86cd799439088/redes-publicado", {
      method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: {}
    })).status, 200);
    assert.equal(updates.length, 2);
    assert.equal(updates[0].$inc.visitas, 1);
    assert.equal(updates[1].$inc.redesPublicadoCount, 1);
    assert.equal(propiedad.contentRevision, 7);
    assert.doesNotMatch(JSON.stringify(updates), /contentRevision|syncOverrides/);
  } finally { Propiedad.findByIdAndUpdate = previousUpdate; Usuario.findById = previousUser; }
});

for (const [name, originalRooms, fields, expectedRooms, overrides, certificate = ""] of [
  ["omite habitaciones y conserva valor", 3, { descripcion: "Descripcion editada" }, 3, { descripcion: true }],
  ["actualiza habitaciones positivas a cero", 3, { habitaciones: "0" }, 0, { habitaciones: true }],
  ["edita solo descripcion CRM de estudio sin overrides adicionales", 0,
    { descripcion: "Descripcion editada", habitaciones: "0" }, 0, { descripcion: true }],
  ["conserva certificado valido omitido al editar descripcion", 0,
    { descripcion: "Descripcion editada", habitaciones: "0" }, 0, { descripcion: true }, "C"]
]) {
  test(`PUT /propiedades/:id ${name}`, async () => {
    const previousUser = Usuario.findById;
    const previousProperty = Propiedad.findById;
    let saves = 0;
    const propiedad = {
      _id: "507f1f77bcf86cd799439088", usuarioId: "507f1f77bcf86cd799439099",
      titulo: "Estudio de prueba", direccion: "Calle Test, Cadiz", precio: 130000,
      descripcion: "Descripcion original", tipoOperacion: "venta", tipoInmueble: "estudio",
      habitaciones: originalRooms, banos: 1, superficie: 40, imagenes: [],
      certificadoEnergetico: certificate,
      source: "crm", externalId: "REF-STUDIO", importSourceId: "507f1f77bcf86cd799439077",
      syncEnabled: true, syncFingerprint: "unchanged-baseline", syncFingerprintVersion: 1,
      syncOverrides: {}, contentRevision: 4,
      save: async () => { saves++; return propiedad; }
    };
    const before = capturePropertyContent(propiedad);
    Usuario.findById = () => Promise.resolve({
      _id: { toString: () => propiedad.usuarioId }, activo: true, plan: "gratis", planActivo: true
    });
    Propiedad.findById = () => Promise.resolve(propiedad);
    const multipart = createMultipartBody({ fields });
    try {
      const response = await request(`/propiedades/${propiedad._id}`, {
        method: "PUT", headers: { ...authHeaderFor(),
          "Content-Type": `multipart/form-data; boundary=${multipart.boundary}`,
          "X-Forwarded-For": "203.0.113.210"
        }, rawBody: multipart.body
      });
      assert.equal(response.status, 200, response.text);
      assert.equal(propiedad.habitaciones, expectedRooms);
      assert.equal(propiedad.certificadoEnergetico, certificate);
      assert.equal(propiedad.contentRevision, 5);
      assert.equal(saves, 1);
      assert.deepEqual(propiedad.syncOverrides, overrides);
      assert.equal(propiedad.syncFingerprint, "unchanged-baseline");
      assert.equal(propiedad.syncFingerprintVersion, 1);
      const after = capturePropertyContent(propiedad);
      for (const field of Object.keys(before)) if (!Object.hasOwn(overrides, field)) assert.deepEqual(after[field], before[field], field);
    } finally {
      Usuario.findById = previousUser;
      Propiedad.findById = previousProperty;
    }
  });
}

test("PUT /propiedades/:id conserva geografía estructurada cuando se omite", async () => {
  const previousFindByIdUsuario = Usuario.findById;
  const previousFindByIdPropiedad = Propiedad.findById;
  const propiedad = {
    _id: "507f1f77bcf86cd799439088",
    usuarioId: "507f1f77bcf86cd799439099",
    titulo: "Casa",
    direccion: "Calle Test",
    localidad: "Chipiona",
    provincia: "Cádiz",
    codigoPostal: "11550",
    imagenes: [],
    source: "crm",
    syncEnabled: true,
    contentRevision: 4,
    save: async () => propiedad
  };
  Usuario.findById = () => Promise.resolve({
    _id: { toString: () => "507f1f77bcf86cd799439099" },
    activo: true,
    plan: "gratis",
    planActivo: true
  });
  Propiedad.findById = () => Promise.resolve(propiedad);
  const multipart = createMultipartBody({
    fields: {
      titulo: "Casa editada",
      direccion: "Calle Test editada",
      precio: "100000",
      tipoOperacion: "venta",
      habitaciones: "2"
    }
  });

  try {
    const response = await request("/propiedades/507f1f77bcf86cd799439088", {
      method: "PUT",
      headers: {
        ...authHeaderFor(),
        "Content-Type": `multipart/form-data; boundary=${multipart.boundary}`,
        "X-Forwarded-For": "203.0.113.99"
      },
      rawBody: multipart.body
    });

    assert.equal(response.status, 200);
    assert.equal(propiedad.localidad, "Chipiona");
    assert.equal(propiedad.provincia, "Cádiz");
    assert.equal(propiedad.codigoPostal, "11550");
    assert.equal(propiedad.contentRevision, 5);
    assert.equal(propiedad.syncOverrides.titulo, true);
    assert.equal(propiedad.syncOverrides.localidad, undefined);
  } finally {
    Usuario.findById = previousFindByIdUsuario;
    Propiedad.findById = previousFindByIdPropiedad;
  }
});

test("PUT /propiedades/:id actualiza geografía estructurada cuando se envía", async () => {
  const previousFindByIdUsuario = Usuario.findById;
  const previousFindByIdPropiedad = Propiedad.findById;
  const propiedad = {
    _id: "507f1f77bcf86cd799439088",
    usuarioId: "507f1f77bcf86cd799439099",
    titulo: "Casa",
    direccion: "Calle Test",
    localidad: "Chipiona",
    provincia: "Cádiz",
    codigoPostal: "11550",
    imagenes: [],
    save: async () => propiedad
  };
  Usuario.findById = () => Promise.resolve({
    _id: { toString: () => "507f1f77bcf86cd799439099" },
    activo: true,
    plan: "gratis",
    planActivo: true
  });
  Propiedad.findById = () => Promise.resolve(propiedad);
  const multipart = createMultipartBody({
    fields: {
      titulo: "Casa editada",
      direccion: "Calle Ancha, Cádiz",
      localidad: "Cádiz",
      provincia: "Cádiz",
      codigoPostal: "11001",
      precio: "100000",
      tipoOperacion: "venta",
      habitaciones: "2"
    }
  });

  try {
    const response = await request("/propiedades/507f1f77bcf86cd799439088", {
      method: "PUT",
      headers: {
        ...authHeaderFor(),
        "Content-Type": `multipart/form-data; boundary=${multipart.boundary}`,
        "X-Forwarded-For": "203.0.113.100"
      },
      rawBody: multipart.body
    });

    assert.equal(response.status, 200);
    assert.equal(propiedad.localidad, "Cádiz");
    assert.equal(propiedad.provincia, "Cádiz");
    assert.equal(propiedad.codigoPostal, "11001");
  } finally {
    Usuario.findById = previousFindByIdUsuario;
    Propiedad.findById = previousFindByIdPropiedad;
  }
});

test("PUT con URL ajena devuelve 400, limpia nuevas y no guarda", async () => {
  const previousFindByIdUsuario = Usuario.findById;
  const previousFindByIdPropiedad = Propiedad.findById;
  const destroyed = [];
  const restoreCloudinary = mockCloudinaryUpload({ destroyed });
  let saved = false;
  const propiedad = {
    _id: "507f1f77bcf86cd799439088",
    usuarioId: "507f1f77bcf86cd799439099",
    imagenes: ["https://res.cloudinary.com/demo/image/upload/v1/miportal_inmobiliario/original-a.jpg"],
    save: async () => {
      saved = true;
    }
  };
  Usuario.findById = () => Promise.resolve({
    _id: { toString: () => "507f1f77bcf86cd799439099" },
    activo: true,
    plan: "gratis",
    planActivo: true
  });
  Propiedad.findById = () => Promise.resolve(propiedad);
  const multipart = createMultipartBody({
    fields: {
      titulo: "Casa",
      direccion: "Calle Test",
      precio: "100000",
      tipoOperacion: "venta",
      habitaciones: "2",
      imagenesExistentes: JSON.stringify(["https://res.cloudinary.com/demo/image/upload/v1/miportal_inmobiliario/ajena.jpg"])
    },
    files: [{ content: "jpg" }]
  });

  try {
    const response = await request("/propiedades/507f1f77bcf86cd799439088", {
      method: "PUT",
      headers: {
        ...authHeaderFor(),
        "Content-Type": `multipart/form-data; boundary=${multipart.boundary}`,
        "X-Forwarded-For": "203.0.113.83"
      },
      rawBody: multipart.body
    });

    assert.equal(response.status, 400);
    assert.equal(saved, false);
    assert.deepEqual(destroyed, ["miportal_inmobiliario/uploaded-1"]);
  } finally {
    Usuario.findById = previousFindByIdUsuario;
    Propiedad.findById = previousFindByIdPropiedad;
    restoreCloudinary();
  }
});

test("PUT limpia nuevas si save falla y no elimina originales retiradas", async () => {
  const previousFindByIdUsuario = Usuario.findById;
  const previousFindByIdPropiedad = Propiedad.findById;
  const destroyed = [];
  const restoreCloudinary = mockCloudinaryUpload({ destroyed });
  const originalA = "https://res.cloudinary.com/demo/image/upload/v1/miportal_inmobiliario/original-a.jpg";
  const originalB = "https://res.cloudinary.com/demo/image/upload/v1/miportal_inmobiliario/original-b.jpg";
  Usuario.findById = () => Promise.resolve({
    _id: { toString: () => "507f1f77bcf86cd799439099" },
    activo: true,
    plan: "gratis",
    planActivo: true
  });
  Propiedad.findById = () => Promise.resolve({
    _id: "507f1f77bcf86cd799439088",
    usuarioId: "507f1f77bcf86cd799439099",
    imagenes: [originalA, originalB],
    save: async () => {
      throw new Error("db unavailable");
    }
  });
  const multipart = createMultipartBody({
    fields: {
      titulo: "Casa",
      direccion: "Calle Test",
      precio: "100000",
      tipoOperacion: "venta",
      habitaciones: "2",
      imagenesExistentes: JSON.stringify([originalA])
    },
    files: [{ content: "jpg" }]
  });

  try {
    const response = await request("/propiedades/507f1f77bcf86cd799439088", {
      method: "PUT",
      headers: {
        ...authHeaderFor(),
        "Content-Type": `multipart/form-data; boundary=${multipart.boundary}`,
        "X-Forwarded-For": "203.0.113.84"
      },
      rawBody: multipart.body
    });

    assert.equal(response.status, 500);
    assert.deepEqual(destroyed, ["miportal_inmobiliario/uploaded-1"]);
  } finally {
    Usuario.findById = previousFindByIdUsuario;
    Propiedad.findById = previousFindByIdPropiedad;
    restoreCloudinary();
  }
});

test("PUT exitoso destruye solo originales retiradas", async () => {
  const previousFindByIdUsuario = Usuario.findById;
  const previousFindByIdPropiedad = Propiedad.findById;
  const destroyed = [];
  const restoreCloudinary = mockCloudinaryUpload({ destroyed });
  const originalA = "https://res.cloudinary.com/demo/image/upload/v1/miportal_inmobiliario/original-a.jpg";
  const originalB = "https://res.cloudinary.com/demo/image/upload/v1/miportal_inmobiliario/original-b.jpg";
  const propiedad = {
    _id: "507f1f77bcf86cd799439088",
    usuarioId: "507f1f77bcf86cd799439099",
    imagenes: [originalA, originalB],
    save: async () => propiedad
  };
  Usuario.findById = () => Promise.resolve({
    _id: { toString: () => "507f1f77bcf86cd799439099" },
    activo: true,
    plan: "gratis",
    planActivo: true
  });
  Propiedad.findById = () => Promise.resolve(propiedad);
  const multipart = createMultipartBody({
    fields: {
      titulo: "Casa",
      direccion: "Calle Test",
      precio: "100000",
      tipoOperacion: "venta",
      habitaciones: "2",
      imagenesExistentes: JSON.stringify([originalA])
    }
  });

  try {
    const response = await request("/propiedades/507f1f77bcf86cd799439088", {
      method: "PUT",
      headers: {
        ...authHeaderFor(),
        "Content-Type": `multipart/form-data; boundary=${multipart.boundary}`,
        "X-Forwarded-For": "203.0.113.85"
      },
      rawBody: multipart.body
    });

    assert.equal(response.status, 200);
    assert.deepEqual(destroyed, ["miportal_inmobiliario/original-b"]);
    assert.deepEqual(propiedad.imagenes, [originalA]);
  } finally {
    Usuario.findById = previousFindByIdUsuario;
    Propiedad.findById = previousFindByIdPropiedad;
    restoreCloudinary();
  }
});

test("DELETE propio usa solo imágenes guardadas en MongoDB", async () => {
  const previousFindByIdUsuario = Usuario.findById;
  const previousFindByIdPropiedad = Propiedad.findById;
  const previousFindByIdAndDelete = Propiedad.findByIdAndDelete;
  const destroyed = [];
  const operations = [];
  const restoreCloudinary = mockCloudinaryUpload({
    destroyed,
    onDestroy: () => operations.push("destroy")
  });
  let deletedId = null;
  Usuario.findById = () => Promise.resolve({
    _id: { toString: () => "507f1f77bcf86cd799439099" },
    activo: true,
    plan: "gratis",
    planActivo: true
  });
  Propiedad.findById = () => Promise.resolve({
    _id: "507f1f77bcf86cd799439088",
    usuarioId: "507f1f77bcf86cd799439099",
    imagenes: [
      "https://res.cloudinary.com/demo/image/upload/v1/miportal_inmobiliario/original-a.jpg",
      "https://example.com/no-cloudinary.jpg"
    ]
  });
  Propiedad.findByIdAndDelete = async id => {
    operations.push("mongo-delete");
    deletedId = id;
  };

  try {
    const response = await request("/propiedades/507f1f77bcf86cd799439088?imagen=https://res.cloudinary.com/demo/image/upload/v1/miportal_inmobiliario/ajena.jpg", {
      method: "DELETE",
      headers: {
        ...authHeaderFor(),
        "X-Forwarded-For": "203.0.113.86"
      }
    });

    assert.equal(response.status, 200);
    assert.equal(deletedId, "507f1f77bcf86cd799439088");
    assert.deepEqual(destroyed, ["miportal_inmobiliario/original-a"]);
    assert.deepEqual(operations, ["mongo-delete", "destroy"]);
  } finally {
    Usuario.findById = previousFindByIdUsuario;
    Propiedad.findById = previousFindByIdPropiedad;
    Propiedad.findByIdAndDelete = previousFindByIdAndDelete;
    restoreCloudinary();
  }
});

test("DELETE propio no llama a Cloudinary si falla MongoDB", async () => {
  const previousFindByIdUsuario = Usuario.findById;
  const previousFindByIdPropiedad = Propiedad.findById;
  const previousFindByIdAndDelete = Propiedad.findByIdAndDelete;
  const destroyed = [];
  const restoreCloudinary = mockCloudinaryUpload({ destroyed });
  Usuario.findById = () => Promise.resolve({
    _id: { toString: () => "507f1f77bcf86cd799439099" },
    activo: true,
    plan: "gratis",
    planActivo: true
  });
  Propiedad.findById = () => Promise.resolve({
    _id: "507f1f77bcf86cd799439088",
    usuarioId: "507f1f77bcf86cd799439099",
    imagenes: ["https://res.cloudinary.com/demo/image/upload/v1/miportal_inmobiliario/original-a.jpg"]
  });
  Propiedad.findByIdAndDelete = async () => {
    throw new Error("mongo unavailable");
  };

  try {
    const response = await request("/propiedades/507f1f77bcf86cd799439088", {
      method: "DELETE",
      headers: {
        ...authHeaderFor(),
        "X-Forwarded-For": "203.0.113.93"
      }
    });

    assert.equal(response.status, 500);
    assert.deepEqual(destroyed, []);
  } finally {
    Usuario.findById = previousFindByIdUsuario;
    Propiedad.findById = previousFindByIdPropiedad;
    Propiedad.findByIdAndDelete = previousFindByIdAndDelete;
    restoreCloudinary();
  }
});

test("DELETE propio responde éxito aunque falle Cloudinary tras borrar MongoDB", async () => {
  const previousFindByIdUsuario = Usuario.findById;
  const previousFindByIdPropiedad = Propiedad.findById;
  const previousFindByIdAndDelete = Propiedad.findByIdAndDelete;
  const destroyed = [];
  let mongoDeleted = false;
  const restoreCloudinary = mockCloudinaryUpload({ destroyed, failDestroy: true });
  Usuario.findById = () => Promise.resolve({
    _id: { toString: () => "507f1f77bcf86cd799439099" },
    activo: true,
    plan: "gratis",
    planActivo: true
  });
  Propiedad.findById = () => Promise.resolve({
    _id: "507f1f77bcf86cd799439088",
    usuarioId: "507f1f77bcf86cd799439099",
    imagenes: ["https://res.cloudinary.com/demo/image/upload/v1/miportal_inmobiliario/original-a.jpg"]
  });
  Propiedad.findByIdAndDelete = async () => {
    mongoDeleted = true;
  };

  try {
    const response = await request("/propiedades/507f1f77bcf86cd799439088", {
      method: "DELETE",
      headers: {
        ...authHeaderFor(),
        "X-Forwarded-For": "203.0.113.94"
      }
    });

    assert.equal(response.status, 200);
    assert.equal(mongoDeleted, true);
    assert.deepEqual(destroyed, ["miportal_inmobiliario/original-a"]);
    assert.deepEqual(JSON.parse(response.text), { ok: true });
  } finally {
    Usuario.findById = previousFindByIdUsuario;
    Propiedad.findById = previousFindByIdPropiedad;
    Propiedad.findByIdAndDelete = previousFindByIdAndDelete;
    restoreCloudinary();
  }
});

test("DELETE admin limpia Cloudinary con imágenes guardadas en MongoDB", async () => {
  const previousFindByIdUsuario = Usuario.findById;
  const previousFindByIdPropiedad = Propiedad.findById;
  const previousFindByIdAndDelete = Propiedad.findByIdAndDelete;
  const destroyed = [];
  const operations = [];
  const restoreCloudinary = mockCloudinaryUpload({
    destroyed,
    onDestroy: () => operations.push("destroy")
  });
  Usuario.findById = () => Promise.resolve({
    _id: { toString: () => "507f1f77bcf86cd799439012" },
    activo: true,
    role: "admin"
  });
  Propiedad.findById = () => Promise.resolve({
    _id: "507f1f77bcf86cd799439088",
    imagenes: ["https://res.cloudinary.com/demo/image/upload/v1/miportal_inmobiliario/admin-a.png"]
  });
  Propiedad.findByIdAndDelete = async () => {
    operations.push("mongo-delete");
  };
  const adminToken = jwt.sign({ id: "507f1f77bcf86cd799439012", role: "admin" }, "test-secret");

  try {
    const response = await request("/admin/propiedades/507f1f77bcf86cd799439088", {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "X-Forwarded-For": "203.0.113.87"
      }
    });

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.text), { ok: true });
    assert.deepEqual(destroyed, ["miportal_inmobiliario/admin-a"]);
    assert.deepEqual(operations, ["mongo-delete", "destroy"]);
  } finally {
    Usuario.findById = previousFindByIdUsuario;
    Propiedad.findById = previousFindByIdPropiedad;
    Propiedad.findByIdAndDelete = previousFindByIdAndDelete;
    restoreCloudinary();
  }
});

for (const scenario of [
  { name: "conflicto de revisión", error: Object.assign(new Error("Detalle de revisión interno"), { code: "PROPERTY_REVISION_CONFLICT", status: 409 }),
    status: 409, body: { error: "El anuncio ha cambiado. Recarga la ficha antes de guardar." } },
  { name: "cupo controlado", error: Object.assign(new Error("Has alcanzado el límite de anuncios de tu plan."), { code: "PUBLICATION_PLAN_LIMIT", status: 403 }),
    status: 403, body: { code: "PUBLICATION_PLAN_LIMIT", error: "Has alcanzado el límite de anuncios de tu plan." } },
  { name: "error inesperado", error: Object.assign(new Error("Mongo E11000 private-database.internal secret-detail"), { code: 11000,
    stack: "private-stack-trace" }), status: 500, body: { error: "No se pudo completar la operación." } }
]) test(`PUT admin ${scenario.name} mantiene status y no expone detalles internos`, async () => {
  const previousUserFind = Usuario.findById, previousPropertyFind = Propiedad.findById, previousLog = console.error;
  const logs = [];
  Usuario.findById = () => Promise.resolve({ _id: "507f1f77bcf86cd799439012", activo: true, role: "admin" });
  Propiedad.findById = () => Promise.resolve({ _id: "507f1f77bcf86cd799439088", contentRevision: 0,
    titulo: "Casa", tipoInmueble: "piso", save: async () => { throw scenario.error; } });
  console.error = (...args) => logs.push(args);
  const token = jwt.sign({ id: "507f1f77bcf86cd799439012", role: "admin" }, "test-secret");
  try {
    const result = await request("/admin/propiedades/507f1f77bcf86cd799439088", {
      method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: { descripcion: "Descripción editada" }
    });
    assert.equal(result.status, scenario.status);
    assert.deepEqual(JSON.parse(result.text), scenario.body);
    assert.doesNotMatch(result.text, /Mongo|E11000|private-|secret-detail|stack|Detalle de revisión interno/);
    assert.ok(logs.some(args => args[0] === "Error editando propiedad desde admin:" && args[1].error === scenario.error.message));
  } finally { Usuario.findById = previousUserFind; Propiedad.findById = previousPropertyFind; console.error = previousLog; }
});

test("PUT /admin/propiedades/:id conserva geografía estructurada cuando se omite", async () => {
  const previousFindByIdUsuario = Usuario.findById;
  const previousFindByIdPropiedad = Propiedad.findById;
  const propiedad = {
    _id: "507f1f77bcf86cd799439088",
    localidad: "Chipiona",
    provincia: "Cádiz",
    codigoPostal: "11550",
    tipoInmueble: "piso",
    source: "crm",
    syncEnabled: true,
    contentRevision: 2,
    save: async () => propiedad
  };
  Usuario.findById = () => Promise.resolve({
    _id: { toString: () => "507f1f77bcf86cd799439012" },
    activo: true,
    role: "admin"
  });
  Propiedad.findById = () => Promise.resolve(propiedad);
  const adminToken = jwt.sign({ id: "507f1f77bcf86cd799439012", role: "admin" }, "test-secret");

  try {
    const response = await request("/admin/propiedades/507f1f77bcf86cd799439088", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
        "X-Forwarded-For": "203.0.113.101"
      },
      body: {
        titulo: "Casa admin",
        direccion: "Calle Test editada"
      }
    });

    assert.equal(response.status, 200);
    assert.equal(propiedad.localidad, "Chipiona");
    assert.equal(propiedad.provincia, "Cádiz");
    assert.equal(propiedad.codigoPostal, "11550");
    assert.equal(propiedad.contentRevision, 3);
    assert.equal(propiedad.syncOverrides.titulo, true);
    assert.equal(propiedad.syncOverrides.localidad, undefined);
  } finally {
    Usuario.findById = previousFindByIdUsuario;
    Propiedad.findById = previousFindByIdPropiedad;
  }
});

test("PUT /admin/propiedades/:id actualiza geografía estructurada cuando se envía", async () => {
  const previousFindByIdUsuario = Usuario.findById;
  const previousFindByIdPropiedad = Propiedad.findById;
  const propiedad = {
    _id: "507f1f77bcf86cd799439088",
    localidad: "Chipiona",
    provincia: "Cádiz",
    codigoPostal: "11550",
    tipoInmueble: "piso",
    save: async () => propiedad
  };
  Usuario.findById = () => Promise.resolve({
    _id: { toString: () => "507f1f77bcf86cd799439012" },
    activo: true,
    role: "admin"
  });
  Propiedad.findById = () => Promise.resolve(propiedad);
  const adminToken = jwt.sign({ id: "507f1f77bcf86cd799439012", role: "admin" }, "test-secret");

  try {
    const response = await request("/admin/propiedades/507f1f77bcf86cd799439088", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
        "X-Forwarded-For": "203.0.113.102"
      },
      body: {
        localidad: "Cádiz",
        provincia: "Cádiz",
        codigoPostal: "11001"
      }
    });

    assert.equal(response.status, 200);
    assert.equal(propiedad.localidad, "Cádiz");
    assert.equal(propiedad.provincia, "Cádiz");
    assert.equal(propiedad.codigoPostal, "11001");
  } finally {
    Usuario.findById = previousFindByIdUsuario;
    Propiedad.findById = previousFindByIdPropiedad;
  }
});

test("DELETE admin no llama a Cloudinary si falla MongoDB", async () => {
  const previousFindByIdUsuario = Usuario.findById;
  const previousFindByIdPropiedad = Propiedad.findById;
  const previousFindByIdAndDelete = Propiedad.findByIdAndDelete;
  const destroyed = [];
  const restoreCloudinary = mockCloudinaryUpload({ destroyed });
  Usuario.findById = () => Promise.resolve({
    _id: { toString: () => "507f1f77bcf86cd799439012" },
    activo: true,
    role: "admin"
  });
  Propiedad.findById = () => Promise.resolve({
    _id: "507f1f77bcf86cd799439088",
    imagenes: ["https://res.cloudinary.com/demo/image/upload/v1/miportal_inmobiliario/admin-a.png"]
  });
  Propiedad.findByIdAndDelete = async () => {
    throw new Error("mongo unavailable");
  };
  const adminToken = jwt.sign({ id: "507f1f77bcf86cd799439012", role: "admin" }, "test-secret");

  try {
    const response = await request("/admin/propiedades/507f1f77bcf86cd799439088", {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "X-Forwarded-For": "203.0.113.95"
      }
    });

    assert.equal(response.status, 500);
    assert.deepEqual(destroyed, []);
  } finally {
    Usuario.findById = previousFindByIdUsuario;
    Propiedad.findById = previousFindByIdPropiedad;
    Propiedad.findByIdAndDelete = previousFindByIdAndDelete;
    restoreCloudinary();
  }
});

test("DELETE admin mantiene éxito si Cloudinary falla tras borrar MongoDB", async () => {
  const previousFindByIdUsuario = Usuario.findById;
  const previousFindByIdPropiedad = Propiedad.findById;
  const previousFindByIdAndDelete = Propiedad.findByIdAndDelete;
  const destroyed = [];
  let mongoDeleted = false;
  const restoreCloudinary = mockCloudinaryUpload({ destroyed, failDestroy: true });
  Usuario.findById = () => Promise.resolve({
    _id: { toString: () => "507f1f77bcf86cd799439012" },
    activo: true,
    role: "admin"
  });
  Propiedad.findById = () => Promise.resolve({
    _id: "507f1f77bcf86cd799439088",
    imagenes: ["https://res.cloudinary.com/demo/image/upload/v1/miportal_inmobiliario/admin-a.png"]
  });
  Propiedad.findByIdAndDelete = async () => {
    mongoDeleted = true;
  };
  const adminToken = jwt.sign({ id: "507f1f77bcf86cd799439012", role: "admin" }, "test-secret");

  try {
    const response = await request("/admin/propiedades/507f1f77bcf86cd799439088", {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "X-Forwarded-For": "203.0.113.96"
      }
    });

    assert.equal(response.status, 200);
    assert.equal(mongoDeleted, true);
    assert.deepEqual(destroyed, ["miportal_inmobiliario/admin-a"]);
    assert.deepEqual(JSON.parse(response.text), { ok: true });
  } finally {
    Usuario.findById = previousFindByIdUsuario;
    Propiedad.findById = previousFindByIdPropiedad;
    Propiedad.findByIdAndDelete = previousFindByIdAndDelete;
    restoreCloudinary();
  }
});

test("MulterError LIMIT_UNEXPECTED_FILE y MIME inválido devuelven JSON controlado", async () => {
  const previousFindById = Usuario.findById;
  const destroyed = [];
  const restoreCloudinary = mockCloudinaryUpload({ destroyed });
  Usuario.findById = () => Promise.resolve({
    _id: { toString: () => "507f1f77bcf86cd799439099" },
    activo: true,
    plan: "gratis",
    planActivo: true
  });

  try {
    const unexpected = createMultipartBody({
      fields: { titulo: "Casa" },
      files: [{ name: "otra", filename: "foto.jpg", contentType: "image/jpeg" }]
    });
    const unexpectedResponse = await request("/propiedades", {
      method: "POST",
      headers: {
        ...authHeaderFor(),
        "Content-Type": `multipart/form-data; boundary=${unexpected.boundary}`,
        "X-Forwarded-For": "203.0.113.88"
      },
      rawBody: unexpected.body
    });

    assert.equal(unexpectedResponse.status, 400);
    assert.equal(unexpectedResponse.headers.get("content-type")?.includes("application/json"), true);
    assert.match(unexpectedResponse.text, /campo de subida/i);
    assert.doesNotMatch(unexpectedResponse.text, /stack|CLOUDINARY|api_secret|\/Users\//i);

    const invalidMime = createMultipartBody({
      fields: { titulo: "Casa" },
      files: [{ filename: "foto.txt", contentType: "text/plain" }]
    });
    const invalidMimeResponse = await request("/propiedades", {
      method: "POST",
      headers: {
        ...authHeaderFor(),
        "Content-Type": `multipart/form-data; boundary=${invalidMime.boundary}`,
        "X-Forwarded-For": "203.0.113.89"
      },
      rawBody: invalidMime.body
    });

    assert.equal(invalidMimeResponse.status, 400);
    assert.match(invalidMimeResponse.text, /Formato de imagen no permitido/);
    assert.equal(restoreCloudinary.getUploadCount(), 0);
    assert.deepEqual(destroyed, []);
  } finally {
    Usuario.findById = previousFindById;
    restoreCloudinary();
  }
});

test("Multer 2 limita a 50 imágenes nuevas por petición y limpia subidas parciales", async () => {
  const previousFindById = Usuario.findById;
  const destroyed = [];
  const restoreCloudinary = mockCloudinaryUpload({ destroyed });
  Usuario.findById = () => Promise.resolve({
    _id: { toString: () => "507f1f77bcf86cd799439099" },
    activo: true,
    plan: "vip",
    planActivo: true
  });

  const multipart = createMultipartBody({
    fields: {
      titulo: "Casa",
      direccion: "Calle Test",
      precio: "100000",
      tipoOperacion: "venta",
      habitaciones: "2"
    },
    files: Array.from({ length: 51 }, (_, index) => ({
      filename: `foto-${index + 1}.jpg`,
      contentType: "image/jpeg",
      content: "jpg"
    }))
  });

  try {
    const response = await request("/propiedades", {
      method: "POST",
      headers: {
        ...authHeaderFor(),
        "Content-Type": `multipart/form-data; boundary=${multipart.boundary}`,
        "X-Forwarded-For": "203.0.113.97"
      },
      rawBody: multipart.body
    });

    assert.equal(response.status, 400);
    assert.match(response.text, /No puedes subir más de 50 imágenes nuevas por petición/);
    assert.equal(restoreCloudinary.getUploadCount(), 50);
    assert.equal(destroyed.length, 50);
    assert.equal(destroyed[0], "miportal_inmobiliario/uploaded-1");
    assert.equal(destroyed[49], "miportal_inmobiliario/uploaded-50");
    assert.doesNotMatch(response.text, /stack|CLOUDINARY|api_secret|\/Users\//i);
  } finally {
    Usuario.findById = previousFindById;
    restoreCloudinary();
  }
});

test("PUT con professional_trial_60d permite 50 nuevas y acumula más de 50 totales", async () => {
  const previousFindByIdUsuario = Usuario.findById;
  const previousFindByIdPropiedad = Propiedad.findById;
  const destroyed = [];
  const restoreCloudinary = mockCloudinaryUpload({ destroyed });
  const imagenesOriginales = Array.from({ length: 50 }, (_, index) =>
    `https://res.cloudinary.com/demo/image/upload/v1/miportal_inmobiliario/original-${index + 1}.jpg`
  );
  const propiedad = {
    _id: "507f1f77bcf86cd799439088",
    usuarioId: "507f1f77bcf86cd799439099",
    imagenes: [...imagenesOriginales],
    save: async () => propiedad
  };
  Usuario.findById = () => Promise.resolve({
    _id: { toString: () => "507f1f77bcf86cd799439099" },
    activo: true,
    plan: "professional_trial_60d",
    planActivo: true,
    professionalPromoStatus: "active"
  });
  Propiedad.findById = () => Promise.resolve(propiedad);
  const multipart = createMultipartBody({
    fields: {
      titulo: "Casa profesional",
      direccion: "Calle Test",
      precio: "100000",
      tipoOperacion: "venta",
      habitaciones: "2",
      imagenesExistentes: JSON.stringify(imagenesOriginales)
    },
    files: Array.from({ length: 50 }, (_, index) => ({
      filename: `foto-${index + 1}.jpg`,
      contentType: "image/jpeg",
      content: "jpg"
    }))
  });

  try {
    const response = await request("/propiedades/507f1f77bcf86cd799439088", {
      method: "PUT",
      headers: {
        ...authHeaderFor(),
        "Content-Type": `multipart/form-data; boundary=${multipart.boundary}`,
        "X-Forwarded-For": "203.0.113.98"
      },
      rawBody: multipart.body
    });

    assert.equal(response.status, 200);
    assert.equal(restoreCloudinary.getUploadCount(), 50);
    assert.equal(propiedad.imagenes.length, 100);
    assert.equal(propiedad.imagenes[0], imagenesOriginales[0]);
    assert.match(propiedad.imagenes[99], /uploaded-50\.jpg$/);
    assert.deepEqual(destroyed, []);
  } finally {
    Usuario.findById = previousFindByIdUsuario;
    Propiedad.findById = previousFindByIdPropiedad;
    restoreCloudinary();
  }
});

test("rate limit de subida se aplica a POST sin afectar lecturas", async () => {
  const previousFindById = Usuario.findById;
  const previousFind = Propiedad.find;
  Usuario.findById = () => Promise.resolve({
    _id: { toString: () => "507f1f77bcf86cd799439099" },
    activo: true,
    plan: "gratis",
    planActivo: true
  });
  Propiedad.find = () => ({
    sort: () => ({
      lean: () => Promise.resolve([])
    })
  });
  const headers = {
    ...authHeaderFor(),
    "Content-Type": "multipart/form-data; boundary=----empty",
    "X-Forwarded-For": "203.0.113.92"
  };

  try {
    for (let i = 0; i < 20; i += 1) {
      await request("/propiedades", {
        method: "POST",
        headers,
        rawBody: Buffer.from("------empty--\r\n")
      });
    }

    const limited = await request("/propiedades", {
      method: "POST",
      headers,
      rawBody: Buffer.from("------empty--\r\n")
    });
    assert.equal(limited.status, 429);
    assert.deepEqual(JSON.parse(limited.text), { error: "Demasiadas solicitudes. Inténtalo de nuevo más tarde." });

    const read = await request("/propiedades", {
      headers: { "X-Forwarded-For": "203.0.113.92" }
    });
    assert.notEqual(read.status, 429);
  } finally {
    Usuario.findById = previousFindById;
    Propiedad.find = previousFind;
  }
});

test("rate limits protegen registro, recuperación y contacto", async () => {
  const headers = {
    "Content-Type": "application/json",
    "X-Forwarded-For": "203.0.113.10"
  };
  for (let i = 0; i < 5; i += 1) {
    await request("/auth/register", { method: "POST", headers, body: {} });
    await request("/auth/recuperar", { method: "POST", headers, body: {} });
    await request("/auth/contacto", { method: "POST", headers, body: {} });
  }

  const register = await request("/auth/register", { method: "POST", headers, body: {} });
  const recovery = await request("/auth/recuperar", { method: "POST", headers, body: {} });
  const contact = await request("/auth/contacto", { method: "POST", headers, body: {} });

  assert.equal(register.status, 429);
  assert.equal(recovery.status, 429);
  assert.equal(contact.status, 429);

  assert.deepEqual(JSON.parse(register.text), {
    error: "Demasiadas solicitudes. Inténtalo de nuevo más tarde."
  });
});

test("login, registro y recuperación siguen accesibles bajo uso normal", async () => {
  const headers = {
    "Content-Type": "application/json",
    "X-Forwarded-For": "203.0.113.11"
  };

  const login = await request("/auth/login", { method: "POST", headers, body: {} });
  const register = await request("/auth/register", { method: "POST", headers, body: {} });
  const recovery = await request("/auth/recuperar", { method: "POST", headers, body: {} });

  assert.notEqual(login.status, 429);
  assert.notEqual(register.status, 429);
  assert.notEqual(recovery.status, 429);
});

test("endpoints test-email ya no son públicos", async () => {
  const authPaths = authRoutes.stack.map(layer => layer.route?.path).filter(Boolean);
  const propiedadesPaths = propiedadesRoutes.stack.map(layer => layer.route?.path).filter(Boolean);
  const appPaths = app._router.stack.map(layer => layer.route?.path).filter(Boolean);

  assert.equal(authPaths.includes("/test-email"), false);
  assert.equal(propiedadesPaths.includes("/test-email"), false);
  assert.equal(appPaths.includes("/_debug"), false);
});

test("búsqueda incluye localidad provincia y ubicación pública, y no expone ubicación privada", async () => {
  const original = Propiedad.find;
  const property = { _id: 'location-test', titulo: 'Prueba', precisionUbicacion: 'aproximada',
    direccion: 'Calle privada 9', ubicacionPublica: 'Costa Ballena, Rota', localidad: 'Rota', provincia: 'Cádiz', lat: 36.7, lng: -6.4 };
  const filters = [];
  Propiedad.find = filter => ({ sort() { return this; }, lean: async () => { filters.push(filter); return [property].filter(p => matchesMongoFilter(p, filter)); } });
  try {
    for (const text of ['Rota', 'Cádiz', 'Costa Ballena']) {
      const response = await request(`/propiedades?texto=${encodeURIComponent(text)}`);
      assert.equal(response.status, 200);
      const [p] = JSON.parse(response.text);
      assert.equal(p.ubicacionPublica, 'Costa Ballena, Rota');
      assert.equal(p.direccion, ''); assert.equal(p.lat, null); assert.equal(p.lng, null);
      const keys = filters.at(-1).$and[0].$or.map(condition => Object.keys(condition)[0]);
      for (const field of ['titulo', 'direccion', 'ubicacionPublica', 'localidad', 'provincia']) assert.ok(keys.includes(field));
    }
    const privateSearch = await request('/propiedades?texto=Calle%20privada');
    assert.deepEqual(JSON.parse(privateSearch.text), []);
    assert.equal(property.direccion, 'Calle privada 9');
  } finally { Propiedad.find = original; }
});

test("ficha API pública retira dirección y coordenadas aproximadas", async () => {
  const original = Propiedad.findByIdAndUpdate;
  Propiedad.findByIdAndUpdate = async () => ({ _id: '507f1f77bcf86cd799439088', direccion: 'Calle privada 9',
    ubicacionPublica: 'Costa Ballena, Rota', precisionUbicacion: 'aproximada', lat: 36.7, lng: -6.4 });
  try {
    const response = await request('/propiedades/507f1f77bcf86cd799439088');
    assert.equal(response.status, 200);
    const p = JSON.parse(response.text);
    assert.equal(p.direccion, ''); assert.equal(p.lat, null); assert.equal(p.lng, null);
    assert.equal(p.ubicacionPublica, 'Costa Ballena, Rota');
  } finally { Propiedad.findByIdAndUpdate = original; }
});

test("GET rental filters isolate each price period and include monthly legacy only", async () => {
  const original=Propiedad.find;
  const properties=[undefined,"mes","semana","dia","temporada","desconocida",null].map((period,index)=>({
    _id:String(index),tipoOperacion:"alquiler",precio:100,...(period===undefined?{}:{periodicidadPrecio:period}) }));
  Propiedad.find=filter=>({sort(){return this;},lean:async()=>properties.filter(p=>matchesMongoFilter(p,filter))});
  try{
    for(const [period,count]of[["mes",2],["semana",1],["dia",1],["temporada",1],["desconocida",2]]){
      const res=await request(`/propiedades?tipo=alquiler&periodicidadPrecio=${period}&max=200`);
      assert.equal(res.status,200,res.text);const data=JSON.parse(res.text);assert.equal(data.length,count);
      assert.ok(data.every(p=>period==="mes"?p.periodicidadPrecio===undefined||p.periodicidadPrecio==="mes":period==="desconocida"?p.periodicidadPrecio===null||p.periodicidadPrecio==="desconocida":p.periodicidadPrecio===period));
    }
    const invalid=await request('/propiedades?tipo=alquiler&periodicidadPrecio=constructor');assert.equal(invalid.status,400);
  }finally{Propiedad.find=original;}
});

for (const admin of [false,true]) for(const explicit of [false,true]) test(`PUT ${admin?'admin':'owner'} ${explicit?'updates':'preserves'} rental period`,async()=>{
  const saved={user:Usuario.findById,property:Propiedad.findById};
  const owner="507f1f77bcf86cd799439099",adminId="507f1f77bcf86cd799439012";
  const property={_id:"507f1f77bcf86cd799439088",usuarioId:owner,source:"crm",syncEnabled:true,contentRevision:2,
    titulo:"Prueba",descripcion:"Antes",direccion:"Calle",localidad:"Rota",tipoOperacion:"alquiler",periodicidadPrecio:"semana",habitaciones:0,imagenes:[],save:async()=>property};
  Usuario.findById=()=>Promise.resolve({_id:admin?adminId:owner,activo:true,role:admin?'admin':'user',plan:'gratis'});
  Propiedad.findById=()=>Promise.resolve(property);
  const token=jwt.sign({id:admin?adminId:owner,...(admin?{role:'admin'}:{})},'test-secret');
  try{
    const response=await request(`${admin?'/admin':''}/propiedades/${property._id}`,{method:'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',
      'X-Forwarded-For':`203.0.113.${240+Number(admin)*2+Number(explicit)}`},body:{descripcion:'Nueva',...(explicit?{periodicidadPrecio:'dia'}:{})}});
    assert.equal(response.status,200,response.text);
    assert.equal(property.periodicidadPrecio,explicit?'dia':'semana');
    assert.equal(property.habitaciones,0);assert.equal(property.contentRevision,3);
    assert.deepEqual(Object.keys(property.syncOverrides).sort(),explicit?['descripcion','periodicidadPrecio']:['descripcion']);
  }finally{Usuario.findById=saved.user;Propiedad.findById=saved.property;}
});

for (const admin of [false, true]) for (const estado of [undefined, "segunda_mano", "obra_nueva", "invalid"]) {
  test(`PUT ${admin ? "admin" : "owner"} condition ${estado ?? "omitted"} is preserved/validated`, async () => {
    const saved = { user: Usuario.findById, property: Propiedad.findById };
    const owner = "507f1f77bcf86cd799439099", adminId = "507f1f77bcf86cd799439012";
    let saves = 0;
    const property = { _id: "507f1f77bcf86cd799439088", usuarioId: owner, source: "crm", syncEnabled: true,
      estado: "no_informado", contentRevision: 2, titulo: "Casa", direccion: "Calle", precio: 100000,
      tipoOperacion: "venta", habitaciones: 2, imagenes: [], descripcion: "Antes", syncFingerprint: "baseline-intacto",
      save: async () => { saves++; return property; } };
    Usuario.findById = () => Promise.resolve({ _id: admin ? adminId : owner, activo: true, role: admin ? "admin" : "user", plan: "gratis" });
    Propiedad.findById = () => Promise.resolve(property);
    const token = jwt.sign({ id: admin ? adminId : owner, ...(admin ? { role: "admin" } : {}) }, "test-secret");
    try {
      const response = await request(`${admin ? "/admin" : ""}/propiedades/${property._id}`, { method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.217" },
        body: { descripcion: "Nueva", ...(estado === undefined ? {} : { estado }) } });
      assert.equal(response.status, estado === "invalid" ? 400 : 200, response.text);
      assert.equal(saves, estado === "invalid" ? 0 : 1);
      assert.equal(property.estado, estado === undefined || estado === "invalid" ? "no_informado" : estado);
      assert.equal(property.syncFingerprint, "baseline-intacto");
      if (estado !== "invalid") {
        assert.equal(property.contentRevision, 3);
        assert.deepEqual(Object.keys(property.syncOverrides).sort(), estado === undefined ? ["descripcion"] : ["descripcion", "estado"]);
      }
    } finally { Usuario.findById = saved.user; Propiedad.findById = saved.property; }
  });
}

test("GET condition filters never include no_informado in obra_nueva or segunda_mano", async () => {
  const previous = Propiedad.find;
  const properties = ["obra_nueva", "segunda_mano", "no_informado"].map((estado, i) => ({ _id: String(i), estado }));
  Propiedad.find = filter => ({ sort() { return this; }, lean: async () => properties.filter(p => matchesMongoFilter(p, filter)) });
  try {
    for (const estado of ["obra_nueva", "segunda_mano"]) {
      const response = await request(`/propiedades?estado=${estado}`);
      assert.equal(response.status, 200, response.text);
      const data = JSON.parse(response.text);
      assert.equal(data.length, 1); assert.equal(data[0].estado, estado);
    }
  } finally { Propiedad.find = previous; }
});

for (const admin of [false, true]) for (const rooms of [undefined, 0, 3, null]) test(`PUT ${admin ? "admin" : "owner"} unknown bedrooms ${rooms === undefined ? "omitted" : rooms}`, async () => {
  const saved = { user: Usuario.findById, property: Propiedad.findById };
  const owner = "507f1f77bcf86cd799439099", adminId = "507f1f77bcf86cd799439012";
  const property = { _id: "507f1f77bcf86cd799439088", usuarioId: owner, titulo: "Prueba", direccion: "Calle",
    tipoInmueble: "piso", tipoOperacion: "venta", precio: 100000, imagenes: [], source: "crm", syncEnabled: true,
    habitaciones: null, habitacionesEstado: "desconocido", descripcion: "Antes", contentRevision: 2, save: async () => property };
  Usuario.findById = () => Promise.resolve({ _id: admin ? adminId : owner, activo: true, role: admin ? "admin" : "user", plan: "gratis" });
  Propiedad.findById = () => Promise.resolve(property);
  const token = jwt.sign({ id: admin ? adminId : owner, ...(admin ? { role: "admin" } : {}) }, "test-secret");
  try {
    const response = await request(`${admin ? "/admin" : ""}/propiedades/${property._id}`, { method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.218" },
      body: { descripcion: "Nueva", ...(rooms === undefined ? {} : { habitaciones: rooms }) } });
    assert.equal(response.status, 200, response.text);
    assert.equal(property.habitaciones, rooms ?? null);
    assert.equal(property.habitacionesEstado, typeof rooms === "number" ? "informado" : "desconocido");
    assert.equal(property.contentRevision, 3);
    assert.deepEqual(Object.keys(property.syncOverrides).sort(), typeof rooms === "number" ? ["descripcion", "habitaciones", "habitacionesEstado"] : ["descripcion"]);
  } finally { Usuario.findById = saved.user; Propiedad.findById = saved.property; }
});

test("public bedroom minimum excludes unknown/non-applicable but unfiltered listing retains them", async () => {
  const saved = Propiedad.find;
  const properties = [{ _id: "0", habitaciones: 0 }, { _id: "3", habitaciones: 3 },
    { _id: "u", habitaciones: null, habitacionesEstado: "desconocido" }, { _id: "na", habitaciones: null, habitacionesEstado: "no_aplicable" }];
  Propiedad.find = filter => ({ sort() { return this; }, lean: async () => properties.filter(p => matchesMongoFilter(p, filter)) });
  try {
    for (const query of ["?hab=1", "?hab=2", "?hab=3"]) {
      const response = await request(`/propiedades${query}`); assert.equal(response.status, 200, response.text);
      const data = JSON.parse(response.text); assert.equal(data.length, 1); assert.equal(data[0].habitaciones, 3);
    }
    assert.equal(JSON.parse((await request("/propiedades")).text).length, 4);
  } finally { Propiedad.find = saved; }
});

test("rental budget alert requires an explicit period and persists it",async()=>{
  const saved={user:Usuario.findById,save:Alerta.prototype.save};let writes=0;
  Usuario.findById=()=>Promise.resolve({_id:'507f1f77bcf86cd799439099',activo:true});
  Alerta.prototype.save=async function(){writes++;return this;};
  try{
    const options={method:'POST',headers:{...authHeaderFor(),'Content-Type':'application/json','X-Forwarded-For':'203.0.113.245'}};
    const denied=await request('/alertas',{...options,body:{tipoOperacion:'alquiler',precioMax:1500}});
    assert.equal(denied.status,400,denied.text);assert.equal(writes,0);
    const accepted=await request('/alertas',{...options,body:{tipoOperacion:'alquiler',precioMax:1500,periodicidadPrecio:'semana'}});
    assert.equal(accepted.status,201,accepted.text);assert.equal(writes,1);
    assert.equal(JSON.parse(accepted.text).periodicidadPrecio,'semana');
  }finally{Usuario.findById=saved.user;Alerta.prototype.save=saved.save;}
});

// Real middleware/handlers with in-memory HTTP streams, models and uploads: no sockets.
const cleanupValidationCases = [
  { name: "periodicidad fuera del enum", fields: { periodicidadPrecio: "anual" } },
  { name: "habitaciones negativas", fields: { habitaciones: "-1" } },
  { name: "estado inválido", fields: { estado: "inventado" } },
  { name: "tipo de inmueble inválido", fields: { tipoInmueble: "inventado" } },
  { name: "alquiler sin periodicidad", fields: { tipoOperacion: "alquiler" } },
  { name: "habitaciones incompatibles con estado", fields: { habitacionesEstado: "desconocido" } },
  { name: "habitaciones no aplicables a vivienda", fields: { habitaciones: "", habitacionesEstado: "no_aplicable" } }
];
for (const method of ["POST", "PUT"]) for (const [index, scenario] of cleanupValidationCases.entries()) {
  test(`${method} cleanup tras upload: ${scenario.name}`, async () => {
    const previousUser = Usuario.findById, previousProperty = Propiedad.findById, previousCreate = Propiedad.create;
    const destroyed = [];
    const restore = mockCloudinaryUpload({ destroyed });
    let saves = 0;
    const original = "https://res.cloudinary.com/demo/image/upload/v1/miportal_inmobiliario/original-a.jpg";
    Usuario.findById = async () => ({ _id: "507f1f77bcf86cd799439099", activo: true, plan: "gratis" });
    Propiedad.findById = async () => ({ _id: "507f1f77bcf86cd799439088", usuarioId: "507f1f77bcf86cd799439099",
      tipoOperacion: "venta", tipoInmueble: "piso", habitaciones: 2, imagenes: [original],
      save: async () => { saves++; } });
    Propiedad.create = async () => { saves++; throw new Error("Unexpected persistence"); };
    const multipart = createMultipartBody({ fields: { titulo: "Casa", direccion: "Calle de prueba", precio: "100000",
      tipoOperacion: "venta", tipoInmueble: "piso", habitaciones: "2", ...scenario.fields }, files: [{ content: "jpg" }] });
    try {
      const response = await request(method === "POST" ? "/propiedades" : "/propiedades/507f1f77bcf86cd799439088", {
        method, headers: { ...authHeaderFor(), "Content-Type": `multipart/form-data; boundary=${multipart.boundary}`,
          "X-Forwarded-For": `198.51.100.${(method === "POST" ? 10 : 30) + index}` }, rawBody: multipart.body
      });
      assert.equal(response.status, 400, response.text);
      assert.equal(restore.getUploadCount(), 1);
      assert.equal(saves, 0);
      // Exactly once, and only this request's image: neither originals nor foreign URLs.
      assert.deepEqual(destroyed, ["miportal_inmobiliario/uploaded-1"]);
    } finally {
      Usuario.findById = previousUser; Propiedad.findById = previousProperty; Propiedad.create = previousCreate; restore();
    }
  });
}

for (const [index, mode] of ["valid", "failed", "uncertain", "revision", "photo_limit", "cleanup_failure", "before_upload"].entries()) {
  test(`PUT cleanup lifecycle: ${mode}`, async () => {
    const previousUser = Usuario.findById, previousProperty = Propiedad.findById;
    const destroyed = [];
    const restore = mockCloudinaryUpload({ destroyed, failDestroy: mode === "cleanup_failure" });
    let saves = 0;
    const originals = Array.from({ length: mode === "photo_limit" ? getLimiteFotosPlan("gratis") : 1 }, (_, i) =>
      `https://res.cloudinary.com/demo/image/upload/v1/miportal_inmobiliario/original-${i}.jpg`);
    const property = { _id: "507f1f77bcf86cd799439088", usuarioId: "507f1f77bcf86cd799439099",
      tipoOperacion: "venta", tipoInmueble: "piso", habitaciones: 2, imagenes: [...originals], contentRevision: 2,
      save: async () => {
        saves++;
        assert.deepEqual(destroyed, [], "No cleanup before persistence resolves");
        if (mode === "failed") throw new Error("Definitive mocked save rejection");
        if (mode === "uncertain") throw Object.assign(new Error("Unconfirmed"), {
          code: "PUBLICATION_EDIT_UNCONFIRMED", status: 503, retainImages: true
        });
        return property;
      } };
    Usuario.findById = async () => ({ _id: property.usuarioId, activo: true, plan: "gratis" });
    Propiedad.findById = async () => property;
    const multipart = createMultipartBody({ fields: {
      ...(mode === "revision" ? { expectedContentRevision: "1" } : {}),
      ...(mode === "cleanup_failure" ? { tipoOperacion: "alquiler" } : {})
    }, files: [{ content: "jpg" }] });
    try {
      const response = await request(mode === "before_upload" ? "/propiedades/invalid-id" : `/propiedades/${property._id}`, {
        method: "PUT", headers: { ...authHeaderFor(), "Content-Type": `multipart/form-data; boundary=${multipart.boundary}`,
          "X-Forwarded-For": `198.51.100.${60 + index}` }, rawBody: multipart.body
      });
      const status = { valid: 200, failed: 500, uncertain: 503, revision: 409, photo_limit: 403, cleanup_failure: 400, before_upload: 400 };
      assert.equal(response.status, status[mode], response.text);
      assert.equal(restore.getUploadCount(), mode === "before_upload" ? 0 : 1);
      assert.equal(saves, ["valid", "failed", "uncertain"].includes(mode) ? 1 : 0);
      assert.deepEqual(destroyed, ["valid", "uncertain", "before_upload"].includes(mode) ? [] : ["miportal_inmobiliario/uploaded-1"]);
      if (mode === "valid") assert.deepEqual(property.imagenes, [...originals,
        "https://res.cloudinary.com/demo/image/upload/v1700000000/miportal_inmobiliario/uploaded-1.jpg"]);
    } finally { Usuario.findById = previousUser; Propiedad.findById = previousProperty; restore(); }
  });
}

for (const [index, mode] of ["plan_inactive", "quota", "user_lookup", "after_persist"].entries()) {
  test(`POST cleanup lifecycle: ${mode}`, async () => {
    const replacements = [];
    const replace = (object, key, value) => { replacements.push([object, key, object[key]]); object[key] = value; };
    const destroyed = [];
    const restore = mockCloudinaryUpload({ destroyed });
    let lookups = 0, saves = 0, persisted;
    replace(Usuario, "findById", async () => {
      if (++lookups > 1 && mode === "user_lookup") throw new Error("Mocked lookup failure");
      return { _id: "507f1f77bcf86cd799439099", activo: true,
        plan: mode === "plan_inactive" ? "vip" : "gratis", planActivo: false };
    });
    replace(Propiedad, "countDocuments", async () => mode === "quota" ? 100 : 0);
    replace(Usuario, "startSession", async () => ({ withTransaction: async action => action(), endSession: async () => {} }));
    replace(Usuario, "updateOne", async () => ({ matchedCount: 1 }));
    replace(Propiedad, "create", async documents => {
      assert.deepEqual(destroyed, []);
      saves++; persisted = documents[0]; return documents;
    });
    replace(Propiedad, "findById", async () => persisted || null);
    replace(Alerta, "find", async () => { throw new Error("Mocked failure after successful persistence"); });
    const multipart = createMultipartBody({ fields: {
      titulo: "Casa", direccion: "Calle de prueba", precio: "100000", tipoOperacion: "venta", habitaciones: "2"
    }, files: [{ content: "jpg" }] });
    try {
      const response = await request("/propiedades", { method: "POST", headers: {
        ...authHeaderFor(), "Content-Type": `multipart/form-data; boundary=${multipart.boundary}`,
        "X-Forwarded-For": `198.51.100.${80 + index}`
      }, rawBody: multipart.body });
      assert.equal(response.status, ["plan_inactive", "quota"].includes(mode) ? 403 : 500, response.text);
      assert.equal(restore.getUploadCount(), 1);
      assert.equal(saves, mode === "after_persist" ? 1 : 0);
      assert.deepEqual(destroyed, mode === "after_persist" ? [] : ["miportal_inmobiliario/uploaded-1"]);
      if (persisted) assert.equal(persisted.imagenes.length, 1);
    } finally {
      for (const [object, key, original] of replacements.reverse()) object[key] = original;
      restore();
    }
  });
}
