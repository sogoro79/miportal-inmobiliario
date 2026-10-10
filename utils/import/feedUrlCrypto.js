import crypto from "node:crypto";
import { parseAndValidateFeedUrl, maskFeedUrl } from "./feedSecurity.js";

export class FeedUrlCryptoError extends Error {
  constructor(code = "SYNC_SOURCE_NOT_CONFIGURED") {
    super("La fuente no tiene una URL recuperable configurada correctamente.");
    this.code = code;
    this.status = 409;
  }
}

function keyFor(version, env) {
  if (!/^[1-9]\d{0,2}$/.test(String(version))) throw new FeedUrlCryptoError();
  const raw = env[`CRM_FEED_URL_KEY_V${version}`];
  if (typeof raw !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(raw)) throw new FeedUrlCryptoError();
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new FeedUrlCryptoError();
  return key;
}

function aad(version) { return Buffer.from(`HomeClick24:CRM:feed-url:v${version}`); }

// Configuration helper only: no database writes and no automatic enrollment.
export function encryptFeedUrl(rawUrl, env = process.env) {
  const url = parseAndValidateFeedUrl(rawUrl).toString();
  if (Buffer.byteLength(url, "utf8") > 2000) throw new FeedUrlCryptoError();
  const version = String(env.CRM_FEED_URL_KEY_VERSION || "1");
  const key = keyFor(version, env);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(version));
  const encrypted = Buffer.concat([cipher.update(url, "utf8"), cipher.final()]);
  return {
    encryptedFeedUrl: [iv, cipher.getAuthTag(), encrypted].map(part => part.toString("base64url")).join("."),
    feedUrlKeyVersion: version,
    feedUrlHash: crypto.createHash("sha256").update(url).digest("hex"),
    feedUrlMasked: maskFeedUrl(url),
    syncEnabled: false
  };
}

export function decryptFeedUrl(source, env = process.env) {
  try {
    const version = source.feedUrlKeyVersion;
    const key = keyFor(version, env);
    const parts = source.encryptedFeedUrl?.split(".");
    if (parts?.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new FeedUrlCryptoError();
    const [iv, tag, encrypted] = parts.map(part => Buffer.from(part, "base64url"));
    if (iv.length !== 12 || tag.length !== 16 || encrypted.length > 2000) throw new FeedUrlCryptoError();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad(version));
    decipher.setAuthTag(tag);
    const url = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    const parsed = parseAndValidateFeedUrl(url).toString();
    if (crypto.createHash("sha256").update(parsed).digest("hex") !== source.feedUrlHash) throw new FeedUrlCryptoError();
    return parsed;
  } catch {
    throw new FeedUrlCryptoError();
  }
}
