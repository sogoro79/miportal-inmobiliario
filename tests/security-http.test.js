import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { EventEmitter } from "events";
import { PassThrough, Readable, Writable } from "stream";
import Propiedad from "../models/Propiedad.js";
import Usuario from "../models/Usuario.js";
import { setBackupRunnerForTests, resetBackupRunnerForTests } from "../utils/backupRunner.js";

process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret";
process.env.RESEND_API_KEY = "re_test";
process.env.STRIPE_SECRET_KEY = "sk_test_123";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";

const { default: app } = await import("../server.js");
const { default: authRoutes } = await import("../routes/auth.js");
const { default: propiedadesRoutes } = await import("../routes/propiedades.js");

function normalizeHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
}

function createReq(path, { method = "GET", headers = {}, body } = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
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

test("backup rechaza GET, anónimo y usuario normal; permite admin real mediante POST", async () => {
  const previousFindById = Usuario.findById;
  let backupStarted = 0;
  setBackupRunnerForTests(() => {
    backupStarted += 1;
  });

  try {
    const getResponse = await request("/backup-now");
    assert.equal(getResponse.status, 405);

    const headResponse = await request("/backup-now", { method: "HEAD" });
    assert.equal(headResponse.status, 405);
    assert.equal(backupStarted, 0);

    const anonymous = await request("/backup-now", { method: "POST" });
    assert.equal(anonymous.status, 401);

    Usuario.findById = () => Promise.resolve({
      _id: { toString: () => "507f1f77bcf86cd799439011" },
      activo: true,
      role: "user"
    });
    const userToken = jwt.sign({ id: "507f1f77bcf86cd799439011" }, "test-secret");
    const normalUser = await request("/backup-now", {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}`, "X-Forwarded-For": "203.0.113.20" }
    });
    assert.equal(normalUser.status, 403);

    Usuario.findById = () => Promise.resolve({
      _id: { toString: () => "507f1f77bcf86cd799439012" },
      activo: true,
      role: "admin"
    });
    const adminToken = jwt.sign({ id: "507f1f77bcf86cd799439012", role: "admin" }, "test-secret");
    const admin = await request("/backup-now", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "X-Forwarded-For": "203.0.113.21" }
    });
    assert.equal(admin.status, 200);
    assert.equal(backupStarted, 1);
    assert.doesNotMatch(admin.text, /secret|token|password|mongodb|stripe/i);
  } finally {
    Usuario.findById = previousFindById;
    resetBackupRunnerForTests();
  }
});

test("backup evita dos ejecuciones simultáneas", async () => {
  const previousFindById = Usuario.findById;
  const child = new EventEmitter();
  let backupStarted = 0;
  setBackupRunnerForTests(() => {
    backupStarted += 1;
    return child;
  });

  Usuario.findById = () => Promise.resolve({
    _id: { toString: () => "507f1f77bcf86cd799439012" },
    activo: true,
    role: "admin"
  });
  const adminToken = jwt.sign({ id: "507f1f77bcf86cd799439012", role: "admin" }, "test-secret");
  const headers = {
    Authorization: `Bearer ${adminToken}`,
    "X-Forwarded-For": "203.0.113.22"
  };

  try {
    const first = await request("/backup-now", { method: "POST", headers });
    const second = await request("/backup-now", { method: "POST", headers });

    assert.equal(first.status, 200);
    assert.equal(second.status, 409);
    assert.equal(backupStarted, 1);
    assert.deepEqual(JSON.parse(second.text), { error: "Backup en curso" });
  } finally {
    child.emit("close", 0);
    Usuario.findById = previousFindById;
    resetBackupRunnerForTests();
  }
});
