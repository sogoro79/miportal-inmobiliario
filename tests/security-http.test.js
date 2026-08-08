import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import jwt from "jsonwebtoken";
import { PassThrough, Readable, Writable } from "stream";
import { v2 as cloudinary } from "cloudinary";
import Propiedad from "../models/Propiedad.js";
import Usuario from "../models/Usuario.js";

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
