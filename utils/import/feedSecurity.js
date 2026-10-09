import dns from "node:dns/promises";
import net from "node:net";
import ipaddr from "ipaddr.js";

export const DEFAULT_MAX_REDIRECTS = 3;
export const DEFAULT_FEED_TIMEOUT_MS = 9000;
export const DEFAULT_MAX_XML_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_PREVIEW_PROPERTIES = 500;
export const DEFAULT_MAX_PHOTOS_PER_PROPERTY = 60;

export class FeedSecurityError extends Error {
  constructor(message, code = "FEED_SECURITY_ERROR") {
    super(message);
    this.name = "FeedSecurityError";
    this.code = code;
  }
}

function normalizeHostname(hostname = "") {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

export function isPrivateOrReservedIp(ip) {
  if (!net.isIP(ip) || ip.includes("%")) return true;
  let address = ipaddr.parse(ip);
  if (address.kind() === "ipv6" && address.isIPv4MappedAddress()) address = address.toIPv4Address();
  if (address.range() !== "unicast") return true;
  // Only allocated global IPv6 unicast; transition and special ranges fail closed.
  return address.kind() === "ipv6" && !address.match(ipaddr.parseCIDR("2000::/3"));
}

export function maskFeedUrl(rawUrl = "") {
  try {
    const url = new URL(rawUrl);
    url.username = "";
    url.password = "";
    url.hash = "";
    if (url.pathname && url.pathname !== "/") url.pathname = "/...";
    if (url.search) url.search = "?...";
    return url.toString();
  } catch {
    return "[url inválida]";
  }
}

export function parseAndValidateFeedUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || "").trim());
  } catch {
    throw new FeedSecurityError("La URL del feed no es válida.", "INVALID_URL");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new FeedSecurityError("Solo se permiten feeds http o https.", "INVALID_PROTOCOL");
  }

  if (!url.hostname || url.username || url.password) {
    throw new FeedSecurityError("La URL del feed no es válida.", "INVALID_URL");
  }

  const hostname = normalizeHostname(url.hostname);
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new FeedSecurityError("La URL del feed apunta a una red no permitida.", "PRIVATE_HOST");
  }

  if (net.isIP(hostname) && isPrivateOrReservedIp(hostname)) {
    throw new FeedSecurityError("La URL del feed apunta a una red no permitida.", "PRIVATE_IP");
  }

  return url;
}

export async function assertPublicFeedTarget(url, {
  lookup = dns.lookup
} = {}) {
  const parsed = typeof url === "string" ? parseAndValidateFeedUrl(url) : url;
  const records = await lookup(normalizeHostname(parsed.hostname), { all: true, verbatim: true });
  const addresses = Array.isArray(records) ? records.map(record => record.address) : [records.address];

  if (!addresses.length || addresses.some(isPrivateOrReservedIp)) {
    throw new FeedSecurityError("La URL del feed apunta a una red no permitida.", "PRIVATE_IP");
  }

  const firstRecord = Array.isArray(records) ? records[0] : records;
  return {
    url: parsed,
    address: firstRecord.address,
    family: firstRecord.family || net.isIP(firstRecord.address),
    addresses
  };
}

export function rejectUnsafeXml(xml = "") {
  const value = String(xml);
  if (/<!DOCTYPE/i.test(value)) {
    throw new FeedSecurityError("El XML contiene DOCTYPE y no se puede procesar.", "XML_DOCTYPE_BLOCKED");
  }
  if (/<!ENTITY/i.test(value)) {
    throw new FeedSecurityError("El XML contiene entidades externas y no se puede procesar.", "XML_ENTITY_BLOCKED");
  }
}
