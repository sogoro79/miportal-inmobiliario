import crypto from "node:crypto";
import { getCrmEncryptionKey } from "./feedUrlCrypto.js";

export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
// Authenticate identity, run, lifetime and versions together with the payload.
function aad(doc) {
  return Buffer.from(JSON.stringify(["HomeClick24:CRM:provider-snapshot:v1", doc.keyVersion,
    String(doc.runId), String(doc.usuarioId), String(doc.importSourceId), doc.provider,
    doc.sourceIdentityHash, doc.snapshotDigest, new Date(doc.fetchedAt).toISOString(),
    new Date(doc.expiresAt).toISOString(), doc.snapshotVersion, doc.normalizationVersion,
    doc.applyFieldsVersion, doc.providerAdapterVersion]));
}
export function encryptProviderSnapshot(snapshot, metadata, env = process.env) {
  const keyVersion = String(env.CRM_FEED_URL_KEY_VERSION || "1");
  const key = getCrmEncryptionKey(keyVersion, env);
  const payload = Buffer.from(JSON.stringify(snapshot));
  if (payload.length > MAX_SNAPSHOT_BYTES) throw new Error("Snapshot exceeds storage limit");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad({ ...metadata, keyVersion }));
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  return { keyVersion, encryptedSnapshot: [iv, cipher.getAuthTag(), encrypted].map(part => part.toString("base64url")).join(".") };
}
export function decryptProviderSnapshot(doc, env = process.env) {
  if (typeof doc.encryptedSnapshot !== "string" || doc.encryptedSnapshot.length > MAX_SNAPSHOT_BYTES * 1.4 + 100) throw new Error("Invalid snapshot");
  const parts = doc.encryptedSnapshot.split(".");
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error("Invalid snapshot");
  const [iv, tag, encrypted] = parts.map(part => Buffer.from(part, "base64url"));
  if (iv.length !== 12 || tag.length !== 16 || encrypted.length > MAX_SNAPSHOT_BYTES) throw new Error("Invalid snapshot");
  const decipher = crypto.createDecipheriv("aes-256-gcm", getCrmEncryptionKey(doc.keyVersion, env), iv);
  decipher.setAAD(aad(doc)); decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8"));
}
