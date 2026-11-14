import { createHash } from "node:crypto";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";
import {
  DEFAULT_FEED_TIMEOUT_MS,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_MAX_XML_BYTES,
  FeedSecurityError,
  assertPublicFeedTarget,
  maskFeedUrl,
  parseAndValidateFeedUrl
} from "./feedSecurity.js";

export class FeedFetchError extends Error {
  constructor(message, code = "FEED_FETCH_ERROR", options = {}) {
    super(message, options);
    this.name = "FeedFetchError";
    this.code = code;
    const safeCodes = ["ERR_INVALID_IP_ADDRESS", "ECONNREFUSED", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH", "ECONNRESET", "EAI_AGAIN", "ENOTFOUND", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT"];
    if (safeCodes.includes(options.cause?.code)) this.internalCode = options.cause.code;
  }
}

export function createPinnedLookup(target) {
  return (hostname, options, callback) => {
    const done = typeof options === "function" ? options : callback;
    if (options?.all) {
      done(null, [{ address: target.address, family: target.family }]);
    } else {
      done(null, target.address, target.family);
    }
  };
}

function isAllowedXmlContentType(contentType = "") {
  if (!contentType) return true;
  const type = String(contentType).split(";")[0].trim().toLowerCase();
  return type === "application/xml" ||
    type === "text/xml" ||
    type === "application/octet-stream" ||
    type === "text/plain" ||
    type.endsWith("+xml");
}

function getHeader(headers = {}, name = "") {
  const expected = name.toLowerCase();
  const found = Object.entries(headers).find(([key]) => String(key).toLowerCase() === expected);
  return found?.[1];
}

const sha256 = value => createHash("sha256").update(value).digest("hex");

function transportSummary(initialHost, url, target, redirects, response) {
  const peer = response.peerAddress;
  const info = {
    initialHostHash: sha256(initialHost), finalHostHash: sha256(url.hostname),
    protocol: url.protocol.slice(0, -1), redirects,
    resolvedIpHash: sha256(target.address), resolvedFamily: target.family,
    ...(isIP(peer || "") && { peerIpHash: sha256(peer), peerFamily: isIP(peer) })
  };
  if (response.statusCode !== 403) return info;
  const header = name => getHeader(response.headers, name);
  const prefix = response.body.slice(0, 8192).toString().trimStart();
  const type = String(header("content-type") || "").split(";")[0].trim().toLowerCase();
  const format = !response.body.length ? "empty" : type === "text/html" || /^(?:<!doctype html|<html)/i.test(prefix)
    ? "html" : type.endsWith("/xml") || type.endsWith("+xml") || /^<\?xml/i.test(prefix) ? "xml"
    : type.startsWith("text/") || /^[\x20-\x7e\s]+$/.test(prefix) ? "text" : "unknown";
  // Emit fixed categories and header presence only; values can echo customer data.
  const server = String(header("server") || "").toLowerCase();
  const denied = /access denied|forbidden/i.test(prefix);
  return { ...info, bodyBytes: response.bodyBytes ?? Buffer.byteLength(response.body),
    bodySha256: response.bodySha256 ?? sha256(response.body), bodyFormat: format,
    responseBodyClass: denied && (server === "cloudflare" || /cloudflare/i.test(prefix)) ? "cloudflare-access-denied"
      : denied ? "generic-forbidden" : format === "html" ? "unknown-html" : format,
    serverClass: ["cloudflare", "nginx", "cloudfront", "varnish", "envoy"].includes(server) ? server : "unknown",
    headerPresence: ["server", "via", "cf-ray", "x-cache", "x-served-by", "x-request-id", "retry-after"]
      .filter(name => header(name) !== undefined),
    retryAfterPresent: header("retry-after") !== undefined };
}

export function defaultRequestOnce(url, {
  timeoutMs = DEFAULT_FEED_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_XML_BYTES,
  binary = false,
  observeFeed = false,
  onHttpStatus,
  target,
  signal
} = {}) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    let settled = false;
    let deadline;
    let abort;
    const fail = error => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (abort) signal?.removeEventListener("abort", abort);
      reject(error instanceof FeedFetchError
        ? error
        : new FeedFetchError("No se pudo leer el feed XML.", "FEED_UNREACHABLE", { cause: error }));
    };
    const req = client.request(url, {
      method: "GET",
      timeout: timeoutMs,
      signal,
      lookup: target ? createPinnedLookup(target) : undefined,
      servername: url.hostname,
      headers: {
        "Accept": "application/xml,text/xml,*/*;q=0.8",
        "Host": url.host,
        "User-Agent": "HomeClick24 CRM Importer/1.0"
      }
    }, res => {
      onHttpStatus?.(res.statusCode);
      const peerAddress = observeFeed ? res.socket?.remoteAddress : undefined;
      const chunks = [];
      let received = 0;

      res.on("data", chunk => {
        received += chunk.length;
        if (received > maxBytes) {
          req.destroy(new FeedFetchError("El feed XML supera el tamaño máximo permitido.", "FEED_TOO_LARGE"));
          return;
        }
        chunks.push(chunk);
      });

      res.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (abort) signal?.removeEventListener("abort", abort);
        const bytes = Buffer.concat(chunks);
        resolve({
          ...(observeFeed && { peerAddress }),
          ...(observeFeed && res.statusCode === 403 && { bodyBytes: received, bodySha256: sha256(bytes) }),
          statusCode: res.statusCode || 0,
          headers: res.headers || {},
          body: binary ? bytes : bytes.toString("utf8")
        });
      });
      res.on("aborted", () => {
        fail(new FeedFetchError("La respuesta del feed se interrumpió antes de completarse.", "FEED_TRUNCATED"));
      });
      res.on("error", () => {
        fail(new FeedFetchError("La respuesta del feed se interrumpió antes de completarse.", "FEED_TRUNCATED"));
      });
    });

    req.on("timeout", () => {
      req.destroy(new FeedFetchError("Tiempo de espera agotado al leer el feed.", "FEED_TIMEOUT"));
    });
    req.on("error", error => {
      fail(error);
    });
    abort = () => req.destroy(signal.reason || new FeedFetchError("Tiempo máximo de importación alcanzado.", "FEED_TIMEOUT"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    deadline = setTimeout(() => req.destroy(new FeedFetchError("Tiempo de espera agotado al leer el feed.", "FEED_TIMEOUT")), timeoutMs);
    req.end();
  });
}

export async function fetchPublicResource(rawUrl, {
  lookup,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  timeoutMs = DEFAULT_FEED_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_XML_BYTES,
  binary = false,
  requestOnce = defaultRequestOnce,
  onFeedResponse,
  onHttpStatus,
  budget,
  signal = budget?.signal
} = {}) {
  let currentUrl = parseAndValidateFeedUrl(rawUrl);

  const initialHost = currentUrl.hostname;
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    // A DNS or connection failure on a new hop has no HTTP response.
    onHttpStatus?.(null);
    budget?.assertActive();
    let target;
    try {
      target = await (budget ? budget.run(() => assertPublicFeedTarget(currentUrl, { lookup })) : assertPublicFeedTarget(currentUrl, { lookup }));
    } catch (error) {
      if (error instanceof FeedSecurityError || error.code === "IMPORT_TIMEOUT") throw error;
      throw new FeedFetchError("No se pudo resolver el dominio del feed XML.", "DNS_LOOKUP_FAILED");
    }

    budget?.assertActive();
    const request = () => requestOnce(currentUrl, { timeoutMs: budget ? Math.min(timeoutMs, budget.remainingMs()) : timeoutMs, maxBytes, target, binary, signal, onHttpStatus, observeFeed: !binary && Boolean(onFeedResponse) });
    const response = await (budget ? budget.run(request) : request());
    const status = Number(response.statusCode || 0);

    onHttpStatus?.(status || null);
    if ([301, 302, 303, 307, 308].includes(status)) {
      if (redirectCount >= maxRedirects) {
        throw new FeedFetchError("El feed redirige demasiadas veces.", "TOO_MANY_REDIRECTS");
      }
      const location = response.headers?.location;
      if (!location) throw new FeedFetchError("Redirección de feed no válida.", "INVALID_REDIRECT");
      currentUrl = parseAndValidateFeedUrl(new URL(location, currentUrl).toString());
      continue;
    }

    if (!binary && onFeedResponse) {
      try { onFeedResponse(transportSummary(initialHost, currentUrl, target, redirectCount, response)); }
      catch { /* Diagnostics never affect the request. */ }
    }
    if (status < 200 || status >= 300) {
      const error = new FeedFetchError(`El feed respondió con estado ${status}.`, "BAD_STATUS");
      error.httpStatus = status;
      const retryAfter = getHeader(response.headers, "retry-after");
      if (typeof retryAfter === "string" && retryAfter.length <= 100) error.retryAfter = retryAfter;
      throw error;
    }

    if (!binary && !isAllowedXmlContentType(getHeader(response.headers, "content-type"))) {
      throw new FeedFetchError("El feed no devuelve un contenido XML válido.", "INVALID_CONTENT_TYPE");
    }

    const body = binary ? response.body : String(response.body || "");
    if (binary && !Buffer.isBuffer(body)) throw new FeedFetchError("Respuesta incompleta.", "FEED_TRUNCATED");
    if (Buffer.byteLength(body) > maxBytes) {
      throw new FeedFetchError("El feed XML supera el tamaño máximo permitido.", "FEED_TOO_LARGE");
    }

    return {
      xml: body,
      headers: response.headers,
      finalUrl: currentUrl.toString(),
      safeUrlForLogs: maskFeedUrl(currentUrl.toString())
    };
  }

  throw new FeedSecurityError("No se pudo validar el feed.", "FEED_VALIDATION_FAILED");
}

export function fetchFeedXml(rawUrl, options) {
  return fetchPublicResource(rawUrl, options);
}
