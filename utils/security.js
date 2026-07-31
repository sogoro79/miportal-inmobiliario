import helmet from "helmet";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";

const PROD_ALLOWED_ORIGINS = new Set([
  "https://www.homeclick24.com",
  "https://homeclick24.com",
  "https://homeclick24.onrender.com",
  "https://miportal-inmobiliario-server.onrender.com"
]);

const DEV_ALLOWED_ORIGINS = new Set([
  "http://localhost:3000",
  "http://localhost:5173"
]);

const ALLOWED_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const ALLOWED_HEADERS = ["Content-Type", "Authorization", "Stripe-Signature"];
const RATE_LIMIT_MESSAGE = "Demasiadas solicitudes. Inténtalo de nuevo más tarde.";

export function getAllowedCorsOrigins(env = process.env.NODE_ENV) {
  return env === "production"
    ? PROD_ALLOWED_ORIGINS
    : new Set([...PROD_ALLOWED_ORIGINS, ...DEV_ALLOWED_ORIGINS]);
}

export function createCorsOptions({ env = process.env.NODE_ENV } = {}) {
  const allowedOrigins = getAllowedCorsOrigins(env);

  return {
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.has(origin)) return callback(null, true);

      const err = new Error("Origen no permitido");
      err.statusCode = 403;
      return callback(err);
    },
    methods: ALLOWED_METHODS,
    allowedHeaders: ALLOWED_HEADERS,
    credentials: false,
    optionsSuccessStatus: 204
  };
}

export function createHelmetMiddleware({ env = process.env.NODE_ENV } = {}) {
  return helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
    frameguard: { action: "sameorigin" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    hsts: env === "production"
      ? { maxAge: 15552000, includeSubDomains: true, preload: false }
      : false
  });
}

export function createSecurityRateLimit({ windowMs, max, keyPrefix }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: req => `${keyPrefix}:${ipKeyGenerator(req.ip)}`,
    handler: (req, res) => res.status(429).json({ error: RATE_LIMIT_MESSAGE })
  });
}

export const securityRateLimits = {
  register: createSecurityRateLimit({ windowMs: 60 * 60 * 1000, max: 5, keyPrefix: "register" }),
  passwordRecovery: createSecurityRateLimit({ windowMs: 60 * 60 * 1000, max: 5, keyPrefix: "password-recovery" }),
  passwordReset: createSecurityRateLimit({ windowMs: 60 * 60 * 1000, max: 8, keyPrefix: "password-reset" }),
  verificationResend: createSecurityRateLimit({ windowMs: 60 * 60 * 1000, max: 5, keyPrefix: "verification-resend" }),
  contact: createSecurityRateLimit({ windowMs: 60 * 60 * 1000, max: 5, keyPrefix: "contact" }),
  alertCreate: createSecurityRateLimit({ windowMs: 60 * 60 * 1000, max: 20, keyPrefix: "alert-create" }),
  chatMessage: createSecurityRateLimit({ windowMs: 15 * 60 * 1000, max: 30, keyPrefix: "chat-message" }),
  propertyUpload: createSecurityRateLimit({ windowMs: 60 * 60 * 1000, max: 20, keyPrefix: "property-upload" }),
  adminSensitive: createSecurityRateLimit({ windowMs: 15 * 60 * 1000, max: 60, keyPrefix: "admin-sensitive" }),
  backup: createSecurityRateLimit({ windowMs: 60 * 60 * 1000, max: 2, keyPrefix: "backup" })
};
