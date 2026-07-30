const buckets = new Map();

function getClientIp(req) {
  return req.ip || req.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
}

export function createRateLimit({ windowMs = 15 * 60 * 1000, max = 5, keyPrefix = "default" } = {}) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${keyPrefix}:${getClientIp(req)}`;
    const current = buckets.get(key);

    if (!current || current.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    current.count += 1;
    if (current.count > max) {
      const retryAfter = Math.ceil((current.resetAt - now) / 1000);
      res.set?.("Retry-After", String(retryAfter));
      return res.status(429).json({
        error: "Demasiados intentos. Inténtalo de nuevo más tarde."
      });
    }

    next();
  };
}

export function resetRateLimitStore() {
  buckets.clear();
}
