import test from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import Usuario from "../models/Usuario.js";
import { registerSchema } from "../routes/auth.js";
import { requireAdmin } from "../middleware/auth.js";
import {
  authenticateAdminCredentials,
  authenticateUserCredentials,
  createAdminJwt,
  usuarioSeguro
} from "../utils/authentication.js";
import { createRateLimit, resetRateLimitStore } from "../utils/rateLimit.js";

function fakeUsuarioModel(usuario) {
  return {
    findOne() {
      return {
        select() {
          return Promise.resolve(usuario);
        }
      };
    }
  };
}

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    set(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

test("login normal válido autentica con password seleccionada", async () => {
  const hash = await bcrypt.hash("password-segura", 10);
  const usuario = {
    _id: { toString: () => "507f1f77bcf86cd799439011" },
    email: "user@example.com",
    password: hash,
    verificado: true,
    activo: true,
    role: "user"
  };

  const result = await authenticateUserCredentials({
    UsuarioModel: fakeUsuarioModel(usuario),
    email: usuario.email,
    password: "password-segura"
  });

  assert.equal(result.ok, true);
  assert.equal(result.usuario.email, usuario.email);
});

test("login normal inválido devuelve fallo genérico", async () => {
  const hash = await bcrypt.hash("password-segura", 10);
  const result = await authenticateUserCredentials({
    UsuarioModel: fakeUsuarioModel({
      password: hash,
      verificado: true,
      activo: true,
      role: "user"
    }),
    email: "user@example.com",
    password: "incorrecta"
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_credentials");
});

test("password no aparece en la respuesta segura", () => {
  const safe = usuarioSeguro({
    _id: "507f1f77bcf86cd799439011",
    nombre: "User",
    email: "user@example.com",
    password: "hash-no-debe-salir",
    plan: "gratis"
  });

  assert.equal(Object.hasOwn(safe, "password"), false);
});

test("administrador real puede autenticarse y mantiene formato de token", async () => {
  const hash = await bcrypt.hash("admin-password", 10);
  const admin = {
    _id: { toString: () => "507f1f77bcf86cd799439012" },
    email: "admin@example.com",
    password: hash,
    activo: true,
    role: "admin"
  };

  const result = await authenticateAdminCredentials({
    UsuarioModel: fakeUsuarioModel(admin),
    email: admin.email,
    password: "admin-password"
  });
  const response = { token: createAdminJwt(admin, "test-secret") };
  const decoded = jwt.verify(response.token, "test-secret");

  assert.equal(result.ok, true);
  assert.equal(typeof response.token, "string");
  assert.equal(decoded.id, admin._id.toString());
  assert.equal(decoded.role, "admin");
  assert.equal(decoded.email, undefined);
});

test("usuario normal no puede iniciar sesión como admin", async () => {
  const hash = await bcrypt.hash("user-password", 10);
  const result = await authenticateAdminCredentials({
    UsuarioModel: fakeUsuarioModel({
      password: hash,
      activo: true,
      role: "user"
    }),
    email: "user@example.com",
    password: "user-password"
  });

  assert.equal(result.ok, false);
});

test("contraseña incorrecta de administrador falla", async () => {
  const hash = await bcrypt.hash("admin-password", 10);
  const result = await authenticateAdminCredentials({
    UsuarioModel: fakeUsuarioModel({
      password: hash,
      activo: true,
      role: "admin"
    }),
    email: "admin@example.com",
    password: "incorrecta"
  });

  assert.equal(result.ok, false);
});

test("JWT admin no concede acceso si el usuario dejó de ser admin", async () => {
  const previousFindById = Usuario.findById;
  process.env.JWT_SECRET = "test-secret";
  Usuario.findById = () => Promise.resolve({
    _id: { toString: () => "507f1f77bcf86cd799439012" },
    email: "admin@example.com",
    activo: true,
    role: "user"
  });

  const req = {
    headers: {
      authorization: `Bearer ${jwt.sign({ id: "507f1f77bcf86cd799439012", role: "admin" }, "test-secret")}`
    }
  };
  const res = createResponse();
  let nextCalled = false;

  try {
    await requireAdmin(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
  } finally {
    Usuario.findById = previousFindById;
  }
});

test("token sin id no accede a rutas admin", async () => {
  process.env.JWT_SECRET = "test-secret";
  const req = {
    headers: {
      authorization: `Bearer ${jwt.sign({ role: "admin" }, "test-secret")}`
    }
  };
  const res = createResponse();
  let nextCalled = false;

  await requireAdmin(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test("token con esAdmin pero sin usuario real no accede a rutas admin", async () => {
  process.env.JWT_SECRET = "test-secret";
  const req = {
    headers: {
      authorization: `Bearer ${jwt.sign({ esAdmin: true }, "test-secret")}`
    }
  };
  const res = createResponse();
  let nextCalled = false;

  await requireAdmin(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test("usuario admin desactivado no accede a rutas admin", async () => {
  const previousFindById = Usuario.findById;
  process.env.JWT_SECRET = "test-secret";
  Usuario.findById = () => Promise.resolve({
    _id: { toString: () => "507f1f77bcf86cd799439012" },
    email: "admin@example.com",
    activo: false,
    role: "admin"
  });

  const req = {
    headers: {
      authorization: `Bearer ${jwt.sign({ id: "507f1f77bcf86cd799439012", role: "admin" }, "test-secret")}`
    }
  };
  const res = createResponse();
  let nextCalled = false;

  try {
    await requireAdmin(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
  } finally {
    Usuario.findById = previousFindById;
  }
});

test("role no puede asignarse durante registro", () => {
  const result = registerSchema.safeParse({
    nombre: "User",
    email: "user@example.com",
    token: "turnstile-token",
    role: "admin"
  });

  assert.equal(result.success, false);
});

test("rate limiting bloquea intentos repetidos en login de usuario y admin", () => {
  resetRateLimitStore();
  const userLimiter = createRateLimit({ windowMs: 60_000, max: 1, keyPrefix: "test-user-login" });
  const adminLimiter = createRateLimit({ windowMs: 60_000, max: 1, keyPrefix: "test-admin-login" });
  const req = { ip: "127.0.0.1", headers: {}, socket: {} };

  let userNext = 0;
  userLimiter(req, createResponse(), () => { userNext += 1; });
  const userRes = createResponse();
  userLimiter(req, userRes, () => { userNext += 1; });

  let adminNext = 0;
  adminLimiter(req, createResponse(), () => { adminNext += 1; });
  const adminRes = createResponse();
  adminLimiter(req, adminRes, () => { adminNext += 1; });

  assert.equal(userNext, 1);
  assert.equal(userRes.statusCode, 429);
  assert.equal(adminNext, 1);
  assert.equal(adminRes.statusCode, 429);
});
