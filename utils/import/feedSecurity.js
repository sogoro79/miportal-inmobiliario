import dns from "node:dns/promises";
import net from "node:net";

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

function ipv4ToInt(ip) {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function ipv4InRange(ip, base, maskBits) {
  const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

function normalizeIpv6(ip = "") {
  return ip.toLowerCase();
}

function normalizeHostname(hostname = "") {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

export function isPrivateOrReservedIp(ip) {
  const version = net.isIP(ip);
  if (!version) return true;

  if (version === 4) {
    return ipv4InRange(ip, "0.0.0.0", 8) ||
      ipv4InRange(ip, "10.0.0.0", 8) ||
      ipv4InRange(ip, "100.64.0.0", 10) ||
      ipv4InRange(ip, "127.0.0.0", 8) ||
      ipv4InRange(ip, "169.254.0.0", 16) ||
      ipv4InRange(ip, "172.16.0.0", 12) ||
      ipv4InRange(ip, "192.0.0.0", 24) ||
      ipv4InRange(ip, "192.168.0.0", 16) ||
      ipv4InRange(ip, "198.18.0.0", 15) ||
      ipv4InRange(ip, "224.0.0.0", 4) ||
      ipv4InRange(ip, "240.0.0.0", 4);
  }

  const value = normalizeIpv6(ip);
  if (value.startsWith("::ffff:")) {
    const mapped = value.slice("::ffff:".length);
    if (net.isIP(mapped) === 4) return isPrivateOrReservedIp(mapped);
    return true;
  }

  return value === "::1" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("fe80:");
}

export function maskFeedUrl(rawUrl = "") {
  try {
    const url = new URL(rawUrl);
    url.username = "";
    url.password = "";
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
  const records = await lookup(parsed.hostname, { all: true, verbatim: true });
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
