#!/usr/bin/env node
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { parseAndValidateFeedUrl } from "../utils/import/feedSecurity.js";

export const DEMO_IDS = Object.freeze(["SYNC-DEMO-001", "SYNC-DEMO-002", "SYNC-DEMO-003", "SYNC-DEMO-004"]);
export const CONFIRMATION = "DELETE_SYNC_DEMO_ALBERTO";
export const COLLECTIONS = Object.freeze({
  users: "usuarios", properties: "propiedads", sources: "importsources",
  runs: "importsyncruns", reconciliations: "importreconciliations"
});
const MAX_SCAN_DOCUMENTS = 100000;
const MAX_TIME_MS = 60000;

export class CleanupError extends Error {
  constructor(code, references = []) {
    super(code);
    this.code = code;
    this.references = references;
  }
}
function abort(code, references) { throw new CleanupError(code, references); }
const id = value => String(value ?? "");
const digest = value => crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (value?.toHexString) return value.toHexString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const signature = docs => digest(canonical([...docs].sort((a, b) => id(a._id).localeCompare(id(b._id)))));

export function parseCleanupArgs(argv) {
  const result = {};
  const allowed = new Set(["user-id", "source-id", "expected-feed-url", "confirm"]);
  for (const arg of argv) {
    if (arg === "--apply" && result.apply === undefined) { result.apply = true; continue; }
    const match = /^--([^=]+)=(.+)$/.exec(arg);
    if (!match || !allowed.has(match[1]) || Object.hasOwn(result, match[1])) abort("INVALID_ARGUMENTS");
    result[match[1]] = match[2];
  }
  return validateOptions({ userId: result["user-id"], sourceId: result["source-id"],
    expectedFeedUrl: result["expected-feed-url"], apply: result.apply === true, confirm: result.confirm });
}

function validateOptions(options) {
  if (!/^[a-f0-9]{24}$/i.test(options.userId || "")) abort("USER_ID_REQUIRED");
  if (!/^[a-f0-9]{24}$/i.test(options.sourceId || "")) abort("SOURCE_ID_REQUIRED");
  if (!options.expectedFeedUrl) abort("EXPECTED_FEED_URL_REQUIRED");
  let normalized;
  try { normalized = parseAndValidateFeedUrl(options.expectedFeedUrl).toString(); }
  catch { abort("EXPECTED_FEED_URL_INVALID"); }
  // Same normalization and SHA-256 as selectedImport.feedHash / feedUrlCrypto.
  return { ...options, userId: options.userId.toLowerCase(), sourceId: options.sourceId.toLowerCase(),
    expectedHash: digest(normalized), shouldApply: options.apply === true && options.confirm === CONFIRMATION };
}

async function read(db, collection, filter, { session, projection, limit = MAX_SCAN_DOCUMENTS } = {}) {
  const cursor = db.collection(collection).find(filter, { session, projection, maxTimeMS: MAX_TIME_MS }).limit(limit + 1);
  try {
    const docs = await cursor.toArray();
    if (docs.length > limit) abort("READ_LIMIT_EXCEEDED");
    return docs;
  } finally { await cursor.close(); }
}

// Check IDs recursively, including unknown/nested propertyId paths. Never output documents.
function hasReference(value, targets) {
  if (value?.toHexString || typeof value === "string") return targets.has(id(value));
  if (Array.isArray(value)) return value.some(item => hasReference(item, targets));
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.values(value).some(item => hasReference(item, targets));
  }
  return false;
}

async function referencesToProperties(db, propertyIds, sourceId, session) {
  const targets = new Set(propertyIds.map(id));
  const excluded = new Set([COLLECTIONS.sources, COLLECTIONS.runs]);
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  const references = [];
  for (const { name, type } of collections) {
    if (name.startsWith("system.") || excluded.has(name)) continue;
    if (type && type !== "collection") abort("UNSUPPORTED_COLLECTION");
    // Usuario is only read for identity/plan and favorites, not personal/account data.
    const projection = name === COLLECTIONS.users ? { favoritos: 1 } : undefined;
    const referenceTargets = name === COLLECTIONS.reconciliations ? new Set([...targets, id(sourceId)]) : targets;
    const cursor = db.collection(name).find({}, { session, projection, maxTimeMS: MAX_TIME_MS });
    let count = 0;
    let scanned = 0;
    try {
      for await (const doc of cursor) {
        if (++scanned > MAX_SCAN_DOCUMENTS) abort("REFERENCE_SCAN_LIMIT_EXCEEDED");
        const { _id, ...content } = doc;
        if (hasReference(content, referenceTargets)) count++;
      }
    } finally { await cursor.close(); }
    if (count) references.push({ collection: name, count });
  }
  return references;
}

async function preflight(db, options, { session, now, ownLock } = {}) {
  const userId = new mongoose.Types.ObjectId(options.userId);
  const sourceId = new mongoose.Types.ObjectId(options.sourceId);
  const scope = { usuarioId: userId, importSourceId: sourceId };
  const users = await read(db, COLLECTIONS.users, { _id: userId }, { session, projection: { _id: 1, plan: 1 }, limit: 1 });
  if (users.length !== 1) abort("USER_NOT_FOUND");
  const sources = await read(db, COLLECTIONS.sources, { $or: [{ usuarioId: userId }, { _id: sourceId }] }, { session, limit: 2 });
  if (sources.length !== 1 || id(sources[0]._id) !== options.sourceId || id(sources[0].usuarioId) !== options.userId) abort("SOURCE_IDENTITY_MISMATCH");
  const source = sources[0];
  if (source.activo !== true || source.feedType !== "generic_xml" || source.feedUrlHash !== options.expectedHash) abort("SOURCE_IDENTITY_MISMATCH");
  const lockUntil = source.importLockUntil == null ? null : new Date(source.importLockUntil);
  if (lockUntil && !Number.isFinite(lockUntil.getTime())) abort("SOURCE_BUSY");
  if (source.lastSyncStatus === "running" ||
    (ownLock ? source.importLockToken !== ownLock || !lockUntil || lockUntil <= now() :
      Boolean(source.importLockToken) || Boolean(lockUntil && lockUntil > now()))) abort("SOURCE_BUSY");

  const properties = await read(db, COLLECTIONS.properties, { ...scope, source: "crm", externalId: { $in: DEMO_IDS } }, { session, limit: 4 });
  const associated = await read(db, COLLECTIONS.properties, { importSourceId: sourceId }, { session, limit: 4 });
  if (properties.length !== 4 || associated.length !== 4 ||
    DEMO_IDS.some(ref => properties.filter(p => p.externalId === ref).length !== 1) ||
    associated.some(p => !properties.some(target => id(target._id) === id(p._id)))) abort("PROPERTY_SET_MISMATCH");
  // A stray fifth demo announcement for this account also blocks cleanup, even on another source.
  const fifth = await read(db, COLLECTIONS.properties, { usuarioId: userId, externalId: "SYNC-DEMO-005" }, { session, limit: 1 });
  if (fifth.length) abort("PROPERTY_SET_MISMATCH");
  if (properties.some(p => !Array.isArray(p.imagenes) || p.imagenes.length !== 0)) abort("IMAGES_PRESENT_OR_UNKNOWN");
  const propertyIds = properties.map(p => p._id);
  const references = await referencesToProperties(db, propertyIds, sourceId, session);
  if (references.length) abort("EXTERNAL_REFERENCES", references);
  const runs = await read(db, COLLECTIONS.runs, { importSourceId: sourceId }, { session });
  if (runs.some(run => id(run.usuarioId) !== options.userId || run.status === "running")) abort("RUNS_BUSY_OR_INCONSISTENT");
  const { importLockToken, importLockUntil, ...stableSource } = source;
  return { userId, sourceId, scope, propertyIds, runIds: runs.map(run => run._id), plan: users[0].plan,
    signature: signature([...properties, ...runs, stableSource, users[0]]),
    summary: { mode: options.shouldApply ? "APPLY" : "DRY RUN", userFound: true,
      plan: ["gratis", "basico", "destacado", "starter", "pro_agentes", "agencia_basica", "vip", "vip_trial", "lanzamiento_2026"].includes(users[0].plan) ? users[0].plan : "otro",
      sourceValidated: true, targetProperties: 4, externalIds: [...DEMO_IDS], images: 0,
      syncRuns: runs.length, externalReferences: 0, reconciliations: 0, result: "APTO PARA LIMPIEZA" } };
}

async function verifyRemoval(db, before, session) {
  const settings = { session, projection: { _id: 1 } };
  const properties = await read(db, COLLECTIONS.properties, { $or: [
    { importSourceId: before.sourceId },
    { usuarioId: before.userId, source: "crm", externalId: { $in: DEMO_IDS } }
  ] }, settings);
  const runs = await read(db, COLLECTIONS.runs, before.scope, settings);
  const sources = await read(db, COLLECTIONS.sources, { _id: before.sourceId }, settings);
  const users = await read(db, COLLECTIONS.users, { _id: before.userId }, { session, projection: { _id: 1, plan: 1 }, limit: 1 });
  if (properties.length || runs.length || sources.length || users.length !== 1 || users[0].plan !== before.plan) abort("POST_VERIFICATION_FAILED");
}

export async function cleanupCrmSyncDemo({ db, client, options, now = () => new Date() }) {
  const validated = validateOptions(options);
  const before = await preflight(db, validated, { now });
  if (!validated.shouldApply) return before.summary;
  if (!client?.startSession) abort("TRANSACTIONS_REQUIRED");
  const session = client.startSession();
  const token = crypto.randomUUID();
  try {
    await session.withTransaction(async () => {
      // Contend with Phase 2/configuration on the same source document. Simulations
      // do not use this lock: apply must run in a window without account activity.
      const locked = await db.collection(COLLECTIONS.sources).updateOne({ _id: before.sourceId, usuarioId: before.userId,
        feedUrlHash: validated.expectedHash,
        $and: [
          { $or: [{ importLockToken: { $exists: false } }, { importLockToken: null }, { importLockToken: "" }] },
          { $or: [{ importLockUntil: { $exists: false } }, { importLockUntil: null }, { importLockUntil: { $lte: now() } }] }
        ]
      }, { $set: { importLockToken: token, importLockUntil: new Date(now().getTime() + 15 * 60000) } }, { session });
      if (locked.matchedCount !== 1) abort("SOURCE_BUSY");
      const checked = await preflight(db, validated, { session, now, ownLock: token });
      if (checked.signature !== before.signature) abort("PREFLIGHT_CHANGED");
      const deletedProperties = await db.collection(COLLECTIONS.properties).deleteMany({ ...before.scope,
        _id: { $in: before.propertyIds }, source: "crm", externalId: { $in: DEMO_IDS } }, { session });
      const deletedRuns = await db.collection(COLLECTIONS.runs).deleteMany({ ...before.scope, _id: { $in: before.runIds } }, { session });
      const deletedSource = await db.collection(COLLECTIONS.sources).deleteOne({ _id: before.sourceId, usuarioId: before.userId,
        feedUrlHash: validated.expectedHash, importLockToken: token }, { session });
      if (deletedProperties.deletedCount !== 4 || deletedRuns.deletedCount !== before.runIds.length || deletedSource.deletedCount !== 1) abort("DELETE_COUNT_MISMATCH");
      await verifyRemoval(db, before, session);
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, readPreference: "primary" });
  } finally { await session.endSession(); }
  await verifyRemoval(db, before);
  return { ...before.summary, result: "LIMPIEZA VERIFICADA", applied: true };
}

export async function runCleanupCli({ argv = process.argv.slice(2), env = process.env,
  mongo = mongoose, stdout = console.log, stderr = console.error } = {}) {
  let connectionAttempted = false;
  try {
    const options = parseCleanupArgs(argv);
    if (!env.MONGODB_URI) abort("MONGODB_URI_REQUIRED");
    connectionAttempted = true;
    await mongo.connect(env.MONGODB_URI, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000 });
    const summary = await cleanupCrmSyncDemo({ db: mongo.connection.db, client: mongo.connection.getClient(), options });
    stdout(JSON.stringify(summary, null, 2));
    return 0;
  } catch (error) {
    // Never print driver messages/stacks, URLs, connection strings or arbitrary codes.
    stderr(JSON.stringify(error instanceof CleanupError ? { error: error.code, references: error.references } :
      { error: "CLEANUP_NOT_CONFIRMED", message: "Operacion no confirmada. Revisar mediante dry-run antes de repetir apply." }));
    return 1;
  } finally {
    if (connectionAttempted) {
      try { await mongo.disconnect(); }
      catch { stderr(JSON.stringify({ error: "DISCONNECT_FAILED" })); return 1; }
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await import("dotenv/config");
  process.exitCode = await runCleanupCli();
}
