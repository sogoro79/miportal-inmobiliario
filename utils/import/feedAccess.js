import { inmowebAvailable, INMOWEB_UNAVAILABLE, INMOWEB_UNAVAILABLE_MESSAGE } from "./inmowebAvailability.js";
import { createHash } from "node:crypto";
import { fetchFeedXml, FeedFetchError } from "./feedFetcher.js";
import { createImportBudget } from "./importBudget.js";
import { parseAndValidateFeedUrl } from "./feedSecurity.js";

export const PROVIDER_BLOCKED = "CRM_PROVIDER_TEMPORARILY_BLOCKED";
export const PROVIDER_MESSAGE = "El proveedor no está disponible temporalmente. Inténtalo más tarde.";
const blocked = () => Object.assign(new FeedFetchError(PROVIDER_MESSAGE, PROVIDER_BLOCKED), { status: 503 });

export function retryAfterMs(value, now) {
  if (typeof value !== "string" || value.length > 100) return 60_000;
  const delay = /^\d+$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) && delay > 0 ? delay : 60_000;
}

// Shared across routes in one router/process, never across tenants. No URLs or
// response headers are retained. Memory state deliberately does not survive restart.
// Fresh transport callers never consume cache or another caller's capture.
// InmoWeb NEW instead uses the separately bound server snapshot lease.
export function createFeedAccess({ fetchXml = fetchFeedXml, now = Date.now,
  ttlMs = 5 * 60_000, forbiddenCooldownMs = 15 * 60_000,
  transientCooldownMs = 60_000, maxEntries = 100, maxCacheBytes = 32 * 1024 * 1024,
  snapshots, log = event => console.info("[CRM Feed Access]", event), instance = "process", version = "unknown"
} = {}) {
  const entries = new Map();
  const safeLabel = value => /^[a-zA-Z0-9_.-]{1,80}$/.test(value || "") ? value : "unknown";
  const trimCache = () => {
    let bytes = 0;
    for (const entry of entries.values()) bytes += entry.capture ? Buffer.byteLength(entry.capture.xml) : 0;
    for (const entry of entries.values()) {
      if (bytes <= maxCacheBytes) break;
      if (entry.capture) { bytes -= Buffer.byteLength(entry.capture.xml); entry.capture = null; }
    }
  };
  return async function access(rawUrl, { usuarioId, feedType = "generic_xml", fresh = true, budget, signal,
    ...transport } = {}) {
    budget?.assertActive();
    if (signal?.aborted) throw signal.reason;
    if (!usuarioId) throw new TypeError("CRM feed access requires an authenticated owner");
    const url = parseAndValidateFeedUrl(rawUrl).toString();
    // URL hash changes on credential/source rotation; feed type doesn't affect transport.
    const key = createHash("sha256").update(JSON.stringify([String(usuarioId), url,
      transport.maxBytes ?? null, transport.timeoutMs ?? null, transport.maxRedirects ?? null])).digest("hex");
    for (const [id, entry] of entries) {
      if (!entry.pending && entry.until <= now() && (!entry.capture || entry.capture.expiresAt <= now())) entries.delete(id);
    }
    let entry = entries.get(key);
    if (!entry) {
      // Do not evict active cooldowns to make room for a burst of distinct sources.
      if (entries.size >= maxEntries) throw blocked();
      entry = { until: 0, pending: null, capture: null };
      entries.set(key, entry);
    }
    const wait = promise => budget ? budget.run(() => promise) : signal ? new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    }) : promise;
    // Serialise fresh validations behind any existing download, then refetch.
    while (fresh && entry.pending) {
      try { await wait(entry.pending); } catch (error) { budget?.assertActive(); if (signal?.aborted) throw error; }
    }
    budget?.assertActive();
    if (!fresh && entry.capture?.expiresAt > now()) return { ...entry.capture, cached: true };
    if (feedType === "inmoweb" && !inmowebAvailable(now())) {
      throw Object.assign(new FeedFetchError(INMOWEB_UNAVAILABLE_MESSAGE, INMOWEB_UNAVAILABLE), { status: 503 });
    }
    if (entry.until > now()) throw blocked();
    if (!fresh && entry.pending) return wait(entry.pending);
    const started = now();
    entry.pending = (async () => {
      let status = null;
      let cooldownMs = 0;
      const transportBudget = fresh && budget ? budget : createImportBudget({ timeoutMs: 45_000 });
      try {
        // Shared reads have their own transport deadline: one waiter's cancellation
        // must not abort other readers. Fresh writes retain their operation budget.
        const result = await transportBudget.run(() => fetchXml(url, { ...transport, budget: transportBudget,
          signal: fresh && signal ? signal : transportBudget.signal }));
        status = result.httpStatus || 200;
        const capture = { xml: result.xml, fetchedAt: new Date(now()).toISOString(), expiresAt: now() + ttlMs, cached: false };
        capture.captureId = snapshots?.record({ xml: result.xml, usuarioId,
          sourceHash: createHash("sha256").update(url).digest("hex"), fetchedAt: capture.fetchedAt });
        entry.capture = capture;
        trimCache();
        return { ...capture };
      } catch (error) {
        status = Number.isInteger(error.httpStatus) ? error.httpStatus : null;
        cooldownMs = status === 403 ? forbiddenCooldownMs : status === 429 ? retryAfterMs(error.retryAfter, now())
          : status >= 500 || ["FEED_TIMEOUT", "IMPORT_TIMEOUT", "FEED_UNREACHABLE", "DNS_LOOKUP_FAILED"].includes(error.code) ? transientCooldownMs : 0;
        entry.capture = null;
        if (cooldownMs) { entry.until = now() + cooldownMs; throw blocked(); }
        throw error;
      } finally {
        if (transportBudget !== budget) transportBudget.dispose();
        // An explicit whitelist; never pass the error, URL, headers or response body.
        try { log({ provider: ["inmoweb", "generic_xml", "auto"].includes(feedType) ? feedType : "other",
          httpStatus: status, durationMs: Math.max(0, now() - started), timestamp: new Date(now()).toISOString(),
          instance: safeLabel(instance), version: safeLabel(version), cooldownMs }); } catch { /* telemetry must not affect imports */ }
      }
    })();
    const pending = entry.pending;
    pending.finally(() => { if (entry.pending === pending) entry.pending = null; }).catch(() => {});
    return wait(pending);
  };
}
