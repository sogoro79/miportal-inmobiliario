import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import jwt from "jsonwebtoken";
import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import { v2 as cloudinary } from "cloudinary";
import Usuario from "../models/Usuario.js";
import { createCrmImportRouter } from "../routes/crmImport.js";
import { FeedFetchError, createPinnedLookup, defaultRequestOnce, fetchFeedXml } from "../utils/import/feedFetcher.js";
import {
  DEFAULT_MAX_XML_BYTES,
  FeedSecurityError
} from "../utils/import/feedSecurity.js";
import { buildPropiedadCreateData } from "../utils/propertyCreation.js";
import { createUserSecurityRateLimit } from "../utils/security.js";

process.env.JWT_SECRET = "test-secret";

test("lookup fijado respeta contratos all y simple para IPv4 e IPv6", () => {
  for (const target of [{ address: "93.184.216.34", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }]) {
    const lookup = createPinnedLookup(target);
    lookup("public.example", { all: true }, (error, records) => {
      assert.equal(error, null);
      assert.deepEqual(records, [target]);
    });
    lookup("public.example", { all: false }, (error, address, family) => {
      assert.equal(error, null);
      assert.equal(address, target.address);
      assert.equal(family, target.family);
    });
    lookup("public.example", (error, address, family) => {
      assert.equal(error, null);
      assert.equal(address, target.address);
      assert.equal(family, target.family);
    });
  }
});

test("transporte real de Node conecta a IP fijada conservando Host", async () => {
  // Loopback solo en la prueba del transporte; fetchFeedXml sigue rechazándolo.
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.host, `unresolvable.example:${server.address().port}`);
    res.writeHead(200, { "content-type": "application/xml" });
    res.end("<properties/>");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await defaultRequestOnce(new URL(`http://unresolvable.example:${server.address().port}/feed.xml`), {
      target: { address: "127.0.0.1", family: 4 }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, "<properties/>");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("FEED_UNREACHABLE conserva cause y solo permite codigos internos seguros", async () => {
  const originalRequest = http.request;
  try {
    for (const code of ["ERR_INVALID_IP_ADDRESS", "ECONNREFUSED", "ETIMEDOUT", "ENETUNREACH", "secret-token"] ) {
      const originalError = Object.assign(new Error("mensaje sensible"), { code });
      http.request = () => {
        const req = new EventEmitter();
        req.end = () => setImmediate(() => req.emit("error", originalError));
        return req;
      };
      await assert.rejects(() => defaultRequestOnce(new URL("http://public.example/feed.xml")), error => {
        assert.equal(error.code, "FEED_UNREACHABLE");
        assert.equal(error.cause, originalError);
        assert.equal(error.internalCode, code === "secret-token" ? undefined : code);
        assert.equal(error.message, "No se pudo leer el feed XML.");
        return true;
      });
    }
  } finally {
    http.request = originalRequest;
  }
});

const USER_ID = "507f1f77bcf86cd799439099";
const OTHER_ID = "507f1f77bcf86cd799439088";

function authHeaderFor(userId = USER_ID) {
  return { Authorization: `Bearer ${jwt.sign({ id: userId }, "test-secret")}` };
}

function makeUsuario(overrides = {}) {
  return {
    _id: USER_ID,
    nombre: "Profesional",
    email: "pro@example.test",
    plan: "lanzamiento_2026",
    planActivo: true,
    trialAccepted: false,
    role: "user",
    activo: true,
    ...overrides
  };
}

function createPropiedadModel({ count = 3 } = {}) {
  return {
    countFilters: [],
    creates: [],
    async countDocuments(filter) {
      this.countFilters.push(filter);
      return count;
    },
    async create(data) {
      this.creates.push(data);
      throw new Error("El análisis CRM no debe crear propiedades.");
    }
  };
}

function createApp({
  user = makeUsuario(),
  count = 3,
  fetchFeedXml: fetcher,
  importSelected,
  simulateSync,
  syncSourceManager,
  ImportSourceModel = { findOne: async () => null },
  importUserRateLimitMiddleware = (req, res, next) => next(),
  userRateLimitMiddleware = (req, res, next) => next()
} = {}) {
  const app = express();
  app.use(express.json());
  const previousFindById = Usuario.findById;
  Usuario.findById = async id => {
    if (String(id) !== String(USER_ID)) return null;
    return user;
  };
  const PropiedadModel = createPropiedadModel({ count });
  app.use("/api/crm-import", createCrmImportRouter({
    fetchFeedXml: fetcher || (async () => ({ xml: validFeedXml(), finalUrl: "https://example.com/feed.xml" })),
    PropiedadModel,
    ImportSourceModel,
    importSelected,
    simulateSync,
    syncSourceManager,
    importRateLimitMiddleware: (req, res, next) => next(),
    importUserRateLimitMiddleware,
    rateLimitMiddleware: (req, res, next) => next(),
    userRateLimitMiddleware
  }));
  return {
    app,
    PropiedadModel,
    restore() {
      Usuario.findById = previousFindById;
    }
  };
}

function createReq(path, { method = "POST", headers = {}, body } = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const normalizedHeaders = Object.fromEntries(
    Object.entries({
      "content-type": "application/json",
      ...headers
    }).map(([key, value]) => [key.toLowerCase(), value])
  );
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
  req.socket.remoteAddress = "127.0.0.1";
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
  const originalEnd = res.end.bind(res);
  res.end = (chunk, encoding, callback) => {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    originalEnd(undefined, encoding, callback);
    const text = Buffer.concat(chunks).toString("utf8");
    resolve({
      status: res.statusCode,
      body: text ? JSON.parse(text) : null
    });
    return res;
  };
  return res;
}

async function request(app, path, options = {}) {
  return new Promise((resolve, reject) => {
    app.handle(createReq(path, options), createRes(resolve), reject);
  });
}

function validFeedXml({ count = 2, photoCount = 3 } = {}) {
  const photos = Array.from({ length: photoCount }, (_, index) => `<photo>https://cdn.example.test/${index}.jpg</photo>`).join("");
  const items = Array.from({ length: count }, (_, index) => `
    <property>
      <id>CRM-${index + 1}</id>
      <title>Casa ${index + 1}</title>
      <operation>sale</operation>
      <price>${250000 + index}</price>
      <city>Chipiona</city>
      <photos>${photos}</photos>
    </property>
  `).join("");
  return `<properties>${items}</properties>`;
}

test("POST /api/crm-import/analyze requiere autenticación", async () => {
  const { app, restore } = createApp();
  try {
    const response = await request(app, "/api/crm-import/analyze", {
      body: { feedUrl: "https://example.com/feed.xml" }
    });
    assert.equal(response.status, 401);
  } finally {
    restore();
  }
});

test("GET/PUT fuente sync requieren auth y solo permiten el propietario autenticado", async () => {
  const calls = [];
  const { app, restore } = createApp({ syncSourceManager: {
    get: async id => { calls.push(["get", id]); return { configured: false, syncEnabled: false }; },
    configure: async (id, url) => { calls.push(["put", id, url]); return { configured: true, syncEnabled: false }; }
  } });
  try {
    for (const method of ["GET", "PUT"]) assert.equal((await request(app, "/api/crm-import/sync/source", { method })).status, 401);
    for (const extra of [{ ownerId: OTHER_ID }, { usuarioId: OTHER_ID }, { importSourceId: OTHER_ID }]) {
      assert.equal((await request(app, "/api/crm-import/sync/source", { method: "PUT", headers: authHeaderFor(), body: { feedUrl: "https://example.com/feed.xml", ...extra } })).status, 400);
    }
    assert.equal((await request(app, `/api/crm-import/sync/source?usuarioId=${OTHER_ID}`, { method: "GET", headers: authHeaderFor() })).status, 400);
    assert.deepEqual(calls, []);
    assert.equal((await request(app, "/api/crm-import/sync/source", { method: "PUT", headers: authHeaderFor(), body: { feedUrl: "https://example.com/feed.xml" } })).status, 200);
    assert.equal((await request(app, "/api/crm-import/sync/source", { method: "GET", headers: authHeaderFor() })).status, 200);
    assert.deepEqual(calls, [["put", USER_ID, "https://example.com/feed.xml"], ["get", USER_ID]]);
  } finally { restore(); }
});

test("fuente sync sin clave/bloqueada falla de forma controlada sin filtrar errores", async () => {
  for (const code of ["SYNC_SOURCE_NOT_CONFIGURED", "SYNC_SOURCE_BUSY", "SYNC_SOURCE_URL_MISMATCH"]) {
    const { app, restore } = createApp({ syncSourceManager: { configure: async () => { throw Object.assign(new Error("private-token secret"), { code }); } } });
    try {
      const response = await request(app, "/api/crm-import/sync/source", { method: "PUT", headers: authHeaderFor(), body: { feedUrl: "https://example.com/feed.xml" } });
      assert.equal(response.status, 409);
      assert.equal(response.body.code, code);
      if (code === "SYNC_SOURCE_URL_MISMATCH") assert.equal(response.body.error, "Esta cuenta ya tiene inmuebles vinculados a otra fuente CRM. En esta fase solo puedes configurar la misma fuente.");
      assert.doesNotMatch(JSON.stringify(response), /private-token|secret/);
    } finally { restore(); }
  }
});

test("configurar fuente comparte rate limit por usuario con analisis/simulacion", async () => {
  const { app, restore } = createApp({
    syncSourceManager: { configure: async () => ({ configured: true, syncEnabled: false }) },
    userRateLimitMiddleware: createUserSecurityRateLimit({ max: 1, windowMs: 60000, keyPrefix: "sync-source-test" })
  });
  try {
    const options = { method: "PUT", headers: authHeaderFor(), body: { feedUrl: "https://example.com/feed.xml" } };
    assert.equal((await request(app, "/api/crm-import/sync/source", options)).status, 200);
    assert.equal((await request(app, "/api/crm-import/sync/source", options)).status, 429);
  } finally { restore(); }
});

test("simulación requiere auth, body estricto y usa solo req.user.id", async () => {
  const calls = [];
  const { app, restore } = createApp({ simulateSync: async input => { calls.push(input); return { mode: "simulation", missingCount: 0 }; } });
  const importSourceId = "507f1f77bcf86cd799439077";
  try {
    assert.equal((await request(app, "/api/crm-import/sync/simulate", { body: { importSourceId } })).status, 401);
    for (const extra of [{ ownerId: OTHER_ID }, { usuarioId: OTHER_ID }, { feedUrl: "https://secret.example/token" }]) {
      assert.equal((await request(app, "/api/crm-import/sync/simulate", { headers: authHeaderFor(), body: { importSourceId, ...extra } })).status, 400);
    }
    const response = await request(app, "/api/crm-import/sync/simulate", { headers: authHeaderFor(), body: { importSourceId } });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [{ usuarioId: USER_ID, importSourceId }]);
  } finally { restore(); }
});

test("simulación no filtra URL, query ni mensajes técnicos en respuesta/logs", async () => {
  const logs = [];
  const previousWarn = console.warn;
  console.warn = (...args) => logs.push(args);
  const { app, restore } = createApp({ simulateSync: async () => { throw Object.assign(new Error("https://secret.example/private-token?api=secret-test"), { code: "secret-test" }); } });
  try {
    const response = await request(app, "/api/crm-import/sync/simulate", { headers: authHeaderFor(), body: { importSourceId: "507f1f77bcf86cd799439077" } });
    assert.equal(response.status, 500);
    assert.equal(response.body.code, "SYNC_RUN_FAILED");
    assert.doesNotMatch(JSON.stringify({ response, logs }), /secret-test|private-token|secret\.example/);
  } finally { restore(); console.warn = previousWarn; }
});

test("simulación legacy y fuente ajena exponen códigos claros", async () => {
  for (const [code, status] of [["SYNC_SOURCE_NOT_CONFIGURED", 409], ["SYNC_SOURCE_NOT_FOUND", 404]]) {
    const { app, restore } = createApp({ simulateSync: async () => { throw Object.assign(new Error("internal"), { code }); } });
    try {
      const response = await request(app, "/api/crm-import/sync/simulate", { headers: authHeaderFor(), body: { importSourceId: "507f1f77bcf86cd799439077" } });
      assert.equal(response.status, status);
      assert.equal(response.body.code, code);
    } finally { restore(); }
  }
});

test("importación requiere auth, rechaza propietarios externos y usa selección del servidor", async () => {
  let called;
  const { app, restore } = createApp({ importSelected: async input => { called = input; return { imported: 1 }; } });
  const body = { feedUrl: "https://example.com/feed.xml", selectedExternalIds: ["CRM-1"] };
  try {
    assert.equal((await request(app, "/api/crm-import/import", { body })).status, 401);
    for (const invalid of [{ ...body, ownerId: OTHER_ID }, { ...body, usuarioId: OTHER_ID }, { ...body, selectedExternalIds: [] }, { ...body, properties: [] }]) {
      assert.equal((await request(app, "/api/crm-import/import", { headers: authHeaderFor(), body: invalid })).status, 400);
    }
    assert.equal(called, undefined);
    assert.equal((await request(app, "/api/crm-import/import", { headers: authHeaderFor(), body })).status, 200);
    assert.equal(called.usuarioId, USER_ID);
    assert.deepEqual(called.selectedExternalIds, ["CRM-1"]);
    assert.equal(called.analyzed.properties[0].titulo, "Casa 1");
  } finally { restore(); }
});

test("endpoint import permite selección de 10 y rechaza 11 antes de importar", async () => {
  let calls = 0;
  const { app, restore } = createApp({ importSelected: async input => {
    calls += 1;
    assert.equal(input.selectedExternalIds.length, 10);
    return { imported: 10 };
  } });
  const body = { feedUrl: "https://example.com/feed.xml", selectedExternalIds: Array.from({ length: 10 }, (_, i) => `CRM-${i + 1}`) };
  try {
    const allowed = await request(app, "/api/crm-import/import", { headers: authHeaderFor(), body });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.imported, 10);
    const denied = await request(app, "/api/crm-import/import", { headers: authHeaderFor(), body: { ...body, selectedExternalIds: [...body.selectedExternalIds, "CRM-11"] } });
    assert.equal(denied.status, 400);
    assert.match(denied.body.error, /entre 1 y 10 inmuebles/);
    assert.equal(calls, 1);
  } finally { restore(); }
});

test("preview identifica duplicados de la fuente actual", async () => {
  const fixture = createApp({ ImportSourceModel: { findOne: async () => ({ _id: OTHER_ID }) } });
  fixture.PropiedadModel.find = async () => [{ externalId: "CRM-1" }];
  try {
    const response = await request(fixture.app, "/api/crm-import/analyze", { headers: authHeaderFor(), body: { feedUrl: "https://example.com/feed.xml" } });
    assert.equal(response.body.properties[0].duplicado, true);
    assert.equal(response.body.properties[1].duplicado, false);
  } finally { fixture.restore(); }
});

test("preview VIP no recorta fotos y referencia ausente impide selección", async () => {
  const fixture = createApp({ user: makeUsuario({ plan: "vip" }), fetchFeedXml: async () => ({ xml: validFeedXml({ photoCount: 75 }).replace("<id>CRM-1</id>", "") }) });
  try {
    const result = await request(fixture.app, "/api/crm-import/analyze", { headers: authHeaderFor(), body: { feedUrl: "https://example.com/feed.xml" } });
    assert.equal(result.body.properties[0].fotosImportables, 75);
    assert.match(result.body.properties[0].errors.join(" "), /referencia externa ausente/);
  } finally { fixture.restore(); }
});

test("importación real aplica rate limit por usuario autenticado", async () => {
  const fixture = createApp({ importSelected: async () => ({ imported: 0 }), importUserRateLimitMiddleware: createUserSecurityRateLimit({ windowMs: 60000, max: 1, keyPrefix: "crm-import-test" }) });
  const options = { headers: authHeaderFor(), body: { feedUrl: "https://example.com/feed.xml", selectedExternalIds: ["CRM-1"] } };
  try {
    assert.equal((await request(fixture.app, "/api/crm-import/import", options)).status, 200);
    assert.equal((await request(fixture.app, "/api/crm-import/import", options)).status, 429);
  } finally { fixture.restore(); }
});

test("análisis usa req.user.id, rechaza ownerId externo y no crea propiedades", async () => {
  const { app, restore, PropiedadModel } = createApp();
  try {
    const rejected = await request(app, "/api/crm-import/analyze", {
      headers: authHeaderFor(),
      body: { feedUrl: "https://example.com/feed.xml", ownerId: OTHER_ID }
    });
    assert.equal(rejected.status, 400);

    const rejectedUsuarioId = await request(app, "/api/crm-import/analyze", {
      headers: authHeaderFor(),
      body: { feedUrl: "https://example.com/feed.xml", usuarioId: OTHER_ID }
    });
    assert.equal(rejectedUsuarioId.status, 400);

    const accepted = await request(app, "/api/crm-import/analyze", {
      headers: authHeaderFor(),
      body: { feedUrl: "https://example.com/feed.xml" }
    });
    assert.equal(accepted.status, 200);
    assert.equal(PropiedadModel.creates.length, 0);
    assert.equal(PropiedadModel.countFilters[0].usuarioId, USER_ID);
  } finally {
    restore();
  }
});

test("preview no modifica usuario ni llama Cloudinary", async () => {
  let saveCalls = 0;
  const user = makeUsuario({ save: async () => { saveCalls += 1; } });
  const previousUpload = cloudinary.uploader.upload_stream;
  cloudinary.uploader.upload_stream = () => {
    throw new Error("Cloudinary no debe usarse en análisis.");
  };
  const { app, restore, PropiedadModel } = createApp({ user });
  try {
    const response = await request(app, "/api/crm-import/analyze", {
      headers: authHeaderFor(),
      body: { feedUrl: "https://example.com/feed.xml" }
    });
    assert.equal(response.status, 200);
    assert.equal(saveCalls, 0);
    assert.equal(PropiedadModel.creates.length, 0);
  } finally {
    cloudinary.uploader.upload_stream = previousUpload;
    restore();
  }
});

test("SSRF bloquea protocolos, localhost, loopback, privadas y metadata", async () => {
  const blockedUrls = [
    "file:///etc/passwd",
    "ftp://example.com/feed.xml",
    "http://localhost/feed.xml",
    "http://127.0.0.1/feed.xml",
    "http://[::1]/feed.xml",
    "http://[::ffff:127.0.0.1]/feed.xml",
    "http://10.0.0.1/feed.xml",
    "http://172.16.0.1/feed.xml",
    "http://192.168.1.1/feed.xml",
    "http://169.254.169.254/latest/meta-data",
    "http://[fc00::1]/feed.xml",
    "http://[fd00::1]/feed.xml",
    "http://[fe80::1]/feed.xml",
    "https://user:secret@example.com/feed.xml"
  ];

  for (const feedUrl of blockedUrls) {
    await assert.rejects(
      () => fetchFeedXml(feedUrl, {
        requestOnce: async () => {
          throw new Error("No debe descargarse");
        }
      }),
      error => error instanceof FeedSecurityError
    );
  }
});

test("SSRF rechaza hosts con alguna IP privada y usa solo la IP validada", async () => {
  await assert.rejects(
    () => fetchFeedXml("https://mixed.example/feed.xml", {
      lookup: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.5", family: 4 }
      ],
      requestOnce: async () => {
        throw new Error("No debe descargarse si una IP resuelta es privada.");
      }
    }),
    error => error instanceof FeedSecurityError
  );

  let targetUsed = null;
  const response = await fetchFeedXml("https://public.example/feed.xml", {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    requestOnce: async (url, options) => {
      targetUsed = options.target;
      return {
        statusCode: 200,
        headers: { "content-type": "application/xml" },
        body: validFeedXml()
      };
    }
  });
  assert.equal(response.xml.includes("<properties>"), true);
  assert.equal(targetUsed.address, "93.184.216.34");
  assert.equal(targetUsed.family, 4);
});

test("SSRF revalida redirects y bloquea destino privado", async () => {
  await assert.rejects(
    () => fetchFeedXml("https://public.example/feed.xml", {
      lookup: async hostname => [{ address: hostname === "private.example" ? "127.0.0.1" : "93.184.216.34", family: 4 }],
      requestOnce: async url => ({
        statusCode: 302,
        headers: { location: "http://private.example/feed.xml" },
        body: ""
      })
    }),
    error => error instanceof FeedSecurityError
  );
});

test("SSRF rechaza redirects a protocolos no permitidos y demasiados redirects", async () => {
  for (const location of ["file:///etc/passwd", "ftp://example.com/feed.xml"]) {
    await assert.rejects(
      () => fetchFeedXml("https://public.example/feed.xml", {
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        requestOnce: async () => ({
          statusCode: 302,
          headers: { location },
          body: ""
        })
      }),
      error => error instanceof FeedSecurityError
    );
  }

  await assert.rejects(
    () => fetchFeedXml("https://public.example/feed.xml", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      requestOnce: async () => ({
        statusCode: 302,
        headers: { location: "/next.xml" },
        body: ""
      })
    }),
    error => error instanceof FeedFetchError && error.code === "TOO_MANY_REDIRECTS"
  );
});

test("fetcher controla timeout, XML mayor que el límite y estados HTTP", async () => {
  await assert.rejects(
    () => fetchFeedXml("https://public.example/feed.xml", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      requestOnce: async () => {
        throw new FeedFetchError("Tiempo de espera agotado al leer el feed.", "FEED_TIMEOUT");
      }
    }),
    error => error instanceof FeedFetchError && error.code === "FEED_TIMEOUT"
  );

  await assert.rejects(
    () => fetchFeedXml("https://public.example/feed.xml", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      requestOnce: async () => ({
        statusCode: 200,
        headers: {},
        body: "a".repeat(DEFAULT_MAX_XML_BYTES + 1)
      })
    }),
    error => error instanceof FeedFetchError && error.code === "FEED_TOO_LARGE"
  );

  for (const statusCode of [404, 500]) {
    await assert.rejects(
      () => fetchFeedXml("https://public.example/feed.xml", {
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        requestOnce: async () => ({
          statusCode,
          headers: { "content-type": "application/xml" },
          body: ""
        })
      }),
      error => error instanceof FeedFetchError && error.code === "BAD_STATUS"
    );
  }
});

test("fetcher valida Content-Type XML sin bloquear respuestas genéricas", async () => {
  for (const contentType of ["application/xml", "text/xml", "application/atom+xml", "application/octet-stream", undefined]) {
    const response = await fetchFeedXml("https://public.example/feed.xml", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      requestOnce: async () => ({
        statusCode: 200,
        headers: contentType ? { "content-type": contentType } : {},
        body: validFeedXml()
      })
    });
    assert.equal(response.xml.includes("<properties>"), true);
  }

  const responseWithUppercaseHeader = await fetchFeedXml("https://public.example/feed.xml", {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    requestOnce: async () => ({
      statusCode: 200,
      headers: { "Content-Type": "application/xml" },
      body: validFeedXml()
    })
  });
  assert.equal(responseWithUppercaseHeader.xml.includes("<properties>"), true);

  await assert.rejects(
    () => fetchFeedXml("https://public.example/feed.xml", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      requestOnce: async () => ({
        statusCode: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: "<html></html>"
      })
    }),
    error => error instanceof FeedFetchError && error.code === "INVALID_CONTENT_TYPE"
  );
});

test("request HTTP libera recursos en timeout, exceso de tamaño en streaming y respuesta truncada", async () => {
  const originalRequest = http.request;
  try {
    http.request = (url, options, callback) => {
      const req = new EventEmitter();
      req.end = () => setImmediate(() => req.emit("timeout"));
      req.destroy = error => setImmediate(() => req.emit("error", error));
      return req;
    };
    await assert.rejects(
      () => defaultRequestOnce(new URL("http://public.example/feed.xml"), { timeoutMs: 30 }),
      error => error instanceof FeedFetchError && error.code === "FEED_TIMEOUT"
    );
  } finally {
    http.request = originalRequest;
  }

  try {
    http.request = (url, options, callback) => {
      const req = new EventEmitter();
      req.end = () => {
        const res = new PassThrough();
        res.statusCode = 200;
        res.headers = { "content-type": "application/xml" };
        callback(res);
        res.write(Buffer.alloc(64, "a"));
        res.write(Buffer.alloc(64, "b"));
      };
      req.destroy = error => setImmediate(() => req.emit("error", error));
      return req;
    };
    await assert.rejects(
      () => defaultRequestOnce(new URL("http://public.example/feed.xml"), { maxBytes: 80 }),
      error => error instanceof FeedFetchError && error.code === "FEED_TOO_LARGE"
    );
  } finally {
    http.request = originalRequest;
  }

  try {
    http.request = (url, options, callback) => {
      const req = new EventEmitter();
      req.end = () => {
        const res = new PassThrough();
        res.statusCode = 200;
        res.headers = { "content-type": "application/xml", "content-length": "1000" };
        callback(res);
        res.write("<properties>");
        setImmediate(() => res.emit("aborted"));
      };
      req.destroy = error => setImmediate(() => req.emit("error", error));
      return req;
    };
    await assert.rejects(
      () => defaultRequestOnce(new URL("http://public.example/feed.xml")),
      error => error instanceof FeedFetchError && error.code === "FEED_TRUNCATED"
    );
  } finally {
    http.request = originalRequest;
  }
});

test("análisis controla DOCTYPE, ENTITY, XML inválido y vacío", async () => {
  const cases = [
    { xml: "<!DOCTYPE root><properties></properties>", status: 400 },
    { xml: "<!ENTITY xxe SYSTEM 'file:///etc/passwd'><properties></properties>", status: 400 },
    { xml: `${" ".repeat(5000)}<!DOCTYPE root><properties></properties>`, status: 400 },
    { xml: `${" ".repeat(5000)}<!ENTITY xxe SYSTEM 'file:///etc/passwd'><properties></properties>`, status: 400 },
    { xml: "<properties><property></properties>", status: 400 },
    { xml: "<properties></properties>", status: 400 }
  ];

  for (const item of cases) {
    const fetcher = async () => {
      if (item.error) throw item.error;
      return { xml: item.xml, finalUrl: "https://example.com/feed.xml" };
    };
    const { app, restore } = createApp({ fetchFeedXml: fetcher });
    try {
      const response = await request(app, "/api/crm-import/analyze", {
        headers: authHeaderFor(),
        body: { feedUrl: "https://example.com/feed.xml" }
      });
      assert.equal(response.status >= 400, true);
    } finally {
      restore();
    }
  }
});

test("feed válido limita preview a 500 inmuebles y 60 fotos por inmueble", async () => {
  const { app, restore } = createApp({
    fetchFeedXml: async () => ({ xml: validFeedXml({ count: 505, photoCount: 70 }) })
  });
  try {
    const response = await request(app, "/api/crm-import/analyze", {
      headers: authHeaderFor(),
      body: { feedUrl: "https://example.com/feed.xml" }
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.total, 500);
    assert.equal(response.body.properties[0].fotosDisponibles, 60);
    assert.equal(response.body.properties[0].fotosImportables, 20);
  } finally {
    restore();
  }
});

test("límites del preview respetan planes principales y usuarios sin cupo", async () => {
  const scenarios = [
    { user: makeUsuario({ plan: "lanzamiento_2026", planActivo: true }), count: 3, anuncios: 10, fotos: 20, cupo: 7, puede: true, motivo: "puede_publicar" },
    { user: makeUsuario({ plan: "gratis", planActivo: false }), count: 1, anuncios: 2, fotos: 7, cupo: 1, puede: true, motivo: "puede_publicar" },
    { user: makeUsuario({ plan: "basico", planActivo: true }), count: 1, anuncios: 3, fotos: 10, cupo: 2, puede: true, motivo: "puede_publicar" },
    { user: makeUsuario({ plan: "destacado", planActivo: true }), count: 2, anuncios: 4, fotos: 15, cupo: 2, puede: true, motivo: "puede_publicar" },
    { user: makeUsuario({ plan: "basico", planActivo: true }), count: 3, anuncios: 3, fotos: 10, cupo: 0, puede: false, motivo: "limite_anuncios" },
    { user: makeUsuario({ plan: "basico", planActivo: false }), count: 0, anuncios: 3, fotos: 10, cupo: 3, puede: false, motivo: "plan_inactivo" },
    { user: makeUsuario({ plan: "vip", planActivo: true }), count: 25, anuncios: null, fotos: null, cupo: null, puede: true, motivo: "puede_publicar" },
    { user: makeUsuario({ plan: "vip_trial", planActivo: true, trialAccepted: true }), count: 25, anuncios: null, fotos: null, cupo: null, puede: true, motivo: "puede_publicar" }
  ];

  for (const scenario of scenarios) {
    const { app, restore } = createApp({ user: scenario.user, count: scenario.count });
    try {
      const response = await request(app, "/api/crm-import/analyze", {
        headers: authHeaderFor(),
        body: { feedUrl: "https://example.com/feed.xml" }
      });
      assert.equal(response.status, 200);
      assert.equal(response.body.limiteAnuncios, scenario.anuncios);
      assert.equal(response.body.limiteFotos, scenario.fotos);
      assert.equal(response.body.cupoDisponible, scenario.cupo);
      assert.equal(response.body.puedePublicarAhora, scenario.puede);
      assert.equal(response.body.motivo, scenario.motivo);
    } finally {
      restore();
    }
  }
});

test("rate limit de análisis CRM se aplica por usuario autenticado", async () => {
  const userRateLimitMiddleware = createUserSecurityRateLimit({
    windowMs: 60 * 60 * 1000,
    max: 2,
    keyPrefix: `crm-import-analyze-test-${Date.now()}`
  });
  const { app, restore } = createApp({ userRateLimitMiddleware });
  try {
    for (const expectedStatus of [200, 200, 429]) {
      const response = await request(app, "/api/crm-import/analyze", {
        headers: authHeaderFor(),
        body: { feedUrl: "https://example.com/feed.xml" }
      });
      assert.equal(response.status, expectedStatus);
    }
  } finally {
    restore();
  }
});

test("helper común conserva la preparación de publicación manual", () => {
  const data = buildPropiedadCreateData({
    titulo: "Casa manual",
    referencia: "REF-1",
    direccion: "Calle Real, Chipiona",
    localidad: "Chipiona",
    provincia: "Cádiz",
    codigoPostal: "11550",
    precio: 250000,
    descripcion: "Descripción",
    tipoOperacion: "venta",
    habitaciones: 3,
    banos: 2,
    superficie: 90,
    tipoInmueble: "chalet",
    numeroPlantas: "2",
    sotano: "si",
    plantaLocal: "3",
    garaje: "true",
    piscina: "false",
    terraza: "true"
  }, {
    usuarioId: USER_ID,
    plan: "basico",
    imagenes: ["https://cdn.example.test/1.jpg"]
  });

  assert.equal(data.usuarioId, USER_ID);
  assert.equal(data.localidad, "Chipiona");
  assert.equal(data.numeroPlantas, "2");
  assert.equal(data.sotano, "si");
  assert.equal(data.plantaLocal, "");
  assert.equal(data.garaje, true);
  assert.equal(data.piscina, false);
  assert.equal(data.terraza, true);
  assert.deepEqual(data.imagenes, ["https://cdn.example.test/1.jpg"]);
});
