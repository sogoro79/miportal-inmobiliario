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

export function defaultRequestOnce(url, {
  timeoutMs = DEFAULT_FEED_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_XML_BYTES,
  binary = false,
  target
} = {}) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    let settled = false;
    let deadline;
    const fail = error => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(error instanceof FeedFetchError
        ? error
        : new FeedFetchError("No se pudo leer el feed XML.", "FEED_UNREACHABLE", { cause: error }));
    };
    const req = client.request(url, {
      method: "GET",
      timeout: timeoutMs,
      lookup: target ? createPinnedLookup(target) : undefined,
      servername: url.hostname,
      headers: {
        "Accept": "application/xml,text/xml,*/*;q=0.8",
        "Host": url.host,
        "User-Agent": "HomeClick24 CRM Importer/1.0"
      }
    }, res => {
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
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers || {},
          body: binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString("utf8")
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
  requestOnce = defaultRequestOnce
} = {}) {
  let currentUrl = parseAndValidateFeedUrl(rawUrl);

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    let target;
    try {
      target = await assertPublicFeedTarget(currentUrl, { lookup });
    } catch (error) {
      if (error instanceof FeedSecurityError) throw error;
      throw new FeedFetchError("No se pudo resolver el dominio del feed XML.", "DNS_LOOKUP_FAILED");
    }

    const response = await requestOnce(currentUrl, { timeoutMs, maxBytes, target, binary });
    const status = Number(response.statusCode || 0);

    if ([301, 302, 303, 307, 308].includes(status)) {
      if (redirectCount >= maxRedirects) {
        throw new FeedFetchError("El feed redirige demasiadas veces.", "TOO_MANY_REDIRECTS");
      }
      const location = response.headers?.location;
      if (!location) throw new FeedFetchError("Redirección de feed no válida.", "INVALID_REDIRECT");
      currentUrl = parseAndValidateFeedUrl(new URL(location, currentUrl).toString());
      continue;
    }

    if (status < 200 || status >= 300) {
      throw new FeedFetchError(`El feed respondió con estado ${status}.`, "BAD_STATUS");
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
