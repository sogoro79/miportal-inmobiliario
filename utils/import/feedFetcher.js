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
  constructor(message, code = "FEED_FETCH_ERROR") {
    super(message);
    this.name = "FeedFetchError";
    this.code = code;
  }
}

function defaultRequestOnce(url, {
  timeoutMs = DEFAULT_FEED_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_XML_BYTES
} = {}) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(url, {
      method: "GET",
      timeout: timeoutMs,
      headers: {
        "Accept": "application/xml,text/xml,*/*;q=0.8",
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
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers || {},
          body: Buffer.concat(chunks).toString("utf8")
        });
      });
    });

    req.on("timeout", () => {
      req.destroy(new FeedFetchError("Tiempo de espera agotado al leer el feed.", "FEED_TIMEOUT"));
    });
    req.on("error", error => {
      reject(error instanceof FeedFetchError
        ? error
        : new FeedFetchError("No se pudo leer el feed XML.", "FEED_UNREACHABLE"));
    });
    req.end();
  });
}

export async function fetchFeedXml(rawUrl, {
  lookup,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  timeoutMs = DEFAULT_FEED_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_XML_BYTES,
  requestOnce = defaultRequestOnce
} = {}) {
  let currentUrl = parseAndValidateFeedUrl(rawUrl);

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    try {
      await assertPublicFeedTarget(currentUrl, { lookup });
    } catch (error) {
      if (error instanceof FeedSecurityError) throw error;
      throw new FeedFetchError("No se pudo resolver el dominio del feed XML.", "DNS_LOOKUP_FAILED");
    }
    const response = await requestOnce(currentUrl, { timeoutMs, maxBytes });
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

    const body = String(response.body || "");
    if (Buffer.byteLength(body, "utf8") > maxBytes) {
      throw new FeedFetchError("El feed XML supera el tamaño máximo permitido.", "FEED_TOO_LARGE");
    }

    return {
      xml: body,
      finalUrl: currentUrl.toString(),
      safeUrlForLogs: maskFeedUrl(currentUrl.toString())
    };
  }

  throw new FeedSecurityError("No se pudo validar el feed.", "FEED_VALIDATION_FAILED");
}
