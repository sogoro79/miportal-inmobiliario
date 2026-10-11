#!/usr/bin/env node
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { decryptFeedUrl } from "../utils/import/feedUrlCrypto.js";
import Usuario from "../models/Usuario.js";
import Propiedad from "../models/Propiedad.js";
import ImportSource from "../models/ImportSource.js";
import ImportSyncRun from "../models/ImportSyncRun.js";
import ImportReconciliation from "../models/ImportReconciliation.js";
import Conversacion from "../models/Conversacion.js";
import Notificacion from "../models/Notificacion.js";
import EstadisticaAnuncio from "../models/EstadisticaAnuncio.js";

export const EXPECTED_URL = "https://www.homeclick24.com/test-sync-apply/homeclick24-sync-apply-v1.xml";
export const EXTERNAL_ID = "SYNC-APPLY-TEST-001";
export const CONFIRMATION = "DELETE_SYNC_APPLY_TEST_ALBERTO";
const HASH = crypto.createHash("sha256").update(EXPECTED_URL).digest("hex");
const same = (a, b) => String(a) === String(b);
const fail = code => { throw Object.assign(new Error(code), { code }); };

export function parseArgs(args) {
  const result = { apply: false };
  for (const arg of args) {
    const match = /^--(user-id|source-id|confirm)=(.+)$/.exec(arg);
    const key = match && { "user-id": "userId", "source-id": "sourceId", confirm: "confirm" }[match[1]];
    if (arg === "--apply" && !result.apply) result.apply = true;
    else if (key && result[key] === undefined) result[key] = match[2];
    else fail("INVALID_ARGUMENTS");
  }
  if (![result.userId, result.sourceId].every(id => /^[a-f0-9]{24}$/i.test(id || ""))) fail("EXPLICIT_IDS_REQUIRED");
  if (result.apply && result.confirm !== CONFIRMATION) fail("CONFIRMATION_REQUIRED");
  if (!result.apply && result.confirm) fail("INVALID_ARGUMENTS");
  return result;
}

const collections = () => Object.fromEntries(Object.entries({ Usuario, Propiedad, ImportSource,
  ImportSyncRun, ImportReconciliation, Conversacion, Notificacion, EstadisticaAnuncio })
  .map(([name, model]) => [name, model.collection]));

export async function inspect({ db, userId, sourceId, env, session, now = new Date(), ownToken }) {
  const options = session ? { session } : {};
  const user = await db.Usuario.findOne({ _id: userId }, options);
  if (!user) fail("USER_NOT_FOUND");
  const source = await db.ImportSource.findOne({ _id: sourceId }, options);
  if (!source || !same(source.usuarioId, userId) || source.feedType !== "generic_xml" ||
      source.feedUrlHash !== HASH || source.activo !== true) fail("SOURCE_IDENTITY_MISMATCH");
  if (decryptFeedUrl(source, env) !== EXPECTED_URL) fail("SOURCE_URL_MISMATCH");
  if (source.importLockToken && source.importLockToken !== ownToken) fail("SOURCE_LOCK_PRESENT");
  if (source.importLockUntil && new Date(source.importLockUntil) > now &&
      (!ownToken || source.importLockToken !== ownToken)) fail("SOURCE_BUSY");
  const properties = await db.Propiedad.find({ importSourceId: sourceId }, options).toArray();
  if (properties.length !== 1) fail("EXACTLY_ONE_SOURCE_PROPERTY_REQUIRED");
  const property = properties[0];
  if (!same(property.usuarioId, userId) || property.source !== "crm" || property.externalId !== EXTERNAL_ID ||
      property.referencia !== "") fail("PROPERTY_IDENTITY_MISMATCH");
  const mediaPresent = !Array.isArray(property.imagenes) || property.imagenes.length > 0 || Boolean(property.videoUrl);
  const reconciliationCount = await db.ImportReconciliation.countDocuments({ $or: [
    { importSourceId: sourceId }, { propiedadId: property._id }, { usuarioId: userId, externalId: EXTERNAL_ID }
  ] }, options);
  const runs = await db.ImportSyncRun.find({ importSourceId: sourceId }, options).toArray();
  if (runs.some(run => !same(run.usuarioId, userId))) fail("RUN_OWNER_MISMATCH");
  if (runs.some(run => ["running", "applying"].includes(run.status) ||
      (run.status === "blocked" && run.errorCode === "SIMULATION_IN_PROGRESS"))) fail("RUN_ACTIVE");
  const references = {};
  for (const name of ["Conversacion", "Notificacion", "EstadisticaAnuncio"]) {
    references[name] = await db[name].countDocuments({ propiedadId: property._id }, options);
  }
  references.favoritos = await db.Usuario.countDocuments({ favoritos: property._id }, options);
  references.otherRuns = await db.ImportSyncRun.countDocuments({ importSourceId: { $ne: sourceId },
    "plan.propiedadId": property._id }, options);
  references.otherProperties = await db.Propiedad.countDocuments({ _id: { $ne: property._id },
    lastSeenRunId: { $in: runs.map(run => run._id) } }, options);
  const summary = { usuarioEncontrado: true, userId: String(userId), nombre: user.nombre || "",
    plan: user.plan, sourceValidada: true, sourceId: String(sourceId), propiedadEncontrada: true,
    propiedadId: String(property._id), externalId: property.externalId,
    imagenesAsociadas: Array.isArray(property.imagenes) ? property.imagenes.length : "estructura no valida",
    importSyncRuns: runs.length, importReconciliations: reconciliationCount, referenciasExternas: references,
    resultado: "APTO PARA LIMPIEZA" };
  if (mediaPresent || reconciliationCount || Object.values(references).some(Boolean)) {
    const code = mediaPresent ? "MEDIA_PRESENT" : reconciliationCount ? "RECONCILIATION_PRESENT" : "EXTERNAL_REFERENCES_PRESENT";
    throw Object.assign(new Error(code), { code, summary: { ...summary, resultado: code } });
  }
  return { user, property, source, summary };
}

async function verify({ db, userId, sourceId, propertyId, originalUser, session }) {
  const options = session ? { session } : {};
  const user = await db.Usuario.findOne({ _id: userId }, options);
  if (JSON.stringify(user) !== JSON.stringify(originalUser) ||
      await db.Propiedad.countDocuments({ $or: [{ _id: propertyId }, { importSourceId: sourceId }] }, options) ||
      await db.ImportSource.countDocuments({ _id: sourceId }, options) ||
      await db.ImportSyncRun.countDocuments({ importSourceId: sourceId }, options) ||
      await db.ImportReconciliation.countDocuments({ $or: [{ importSourceId: sourceId }, { propiedadId: propertyId }] }, options)) {
    fail("POST_VERIFICATION_FAILED");
  }
}

export async function cleanup({ db, client, userId, sourceId, env = {}, apply = false, confirm, now = () => new Date() }) {
  if (apply && confirm !== CONFIRMATION) fail("CONFIRMATION_REQUIRED");
  const initial = await inspect({ db, userId, sourceId, env, now: now() });
  if (!apply) return { ...initial.summary, dryRun: true };
  const session = await client.startSession();
  const token = crypto.randomUUID();
  let confirmed;
  try {
    await session.withTransaction(async () => {
      // Fence on the same source document as import/configure/simulate/apply, before any reads.
      const fence = await db.ImportSource.updateOne({ _id: sourceId, usuarioId: userId, feedUrlHash: HASH,
        $and: [{ $or: [{ importLockToken: { $exists: false } }, { importLockToken: null }] },
          { $or: [{ importLockUntil: { $exists: false } }, { importLockUntil: null }, { importLockUntil: { $lte: now() } }] }]
      }, { $set: { importLockToken: token, importLockUntil: new Date(now().getTime() + 15 * 60 * 1000) } }, { session });
      if (fence.matchedCount !== 1) fail("SOURCE_BUSY");
      const fresh = await inspect({ db, userId, sourceId, env, session, now: now(), ownToken: token });
      if (!same(fresh.property._id, initial.property._id) || JSON.stringify(fresh.user) !== JSON.stringify(initial.user)) fail("IDENTITY_CHANGED");
      const deleted = await db.Propiedad.deleteOne({ _id: fresh.property._id, usuarioId: userId,
        importSourceId: sourceId, source: "crm", externalId: EXTERNAL_ID }, { session });
      if (deleted.deletedCount !== 1) fail("DELETE_COUNT_MISMATCH");
      const runs = await db.ImportSyncRun.deleteMany({ usuarioId: userId, importSourceId: sourceId }, { session });
      if (runs.deletedCount !== fresh.summary.importSyncRuns) fail("DELETE_COUNT_MISMATCH");
      const source = await db.ImportSource.deleteOne({ _id: sourceId, usuarioId: userId,
        feedUrlHash: HASH, importLockToken: token }, { session });
      if (source.deletedCount !== 1) fail("DELETE_COUNT_MISMATCH");
      await verify({ db, userId, sourceId, propertyId: fresh.property._id, originalUser: initial.user, session });
      confirmed = fresh.summary;
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, readPreference: "primary" });
    await verify({ db, userId, sourceId, propertyId: initial.property._id, originalUser: initial.user });
    return { ...confirmed, dryRun: false, resultado: "LIMPIEZA CONFIRMADA" };
  } finally { await session.endSession(); }
}

export async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  await import("dotenv/config");
  if (!process.env.MONGODB_URI) fail("MONGODB_URI_REQUIRED");
  try {
    await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, autoCreate: false });
    const result = await cleanup({ db: collections(), client: mongoose.connection.getClient(),
      ...args, userId: new mongoose.Types.ObjectId(args.userId), sourceId: new mongoose.Types.ObjectId(args.sourceId), env: process.env });
    console.log(JSON.stringify(result, null, 2));
  } finally { await mongoose.disconnect(); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli().catch(error => {
    if (error.summary) console.error(JSON.stringify(error.summary, null, 2));
    // Never print driver messages, connection strings, decrypted URLs or credentials.
    const safeCodes = /^(USER_|SOURCE_|PROPERTY_|EXACTLY_|MEDIA_|RUN_|RECONCILIATION_|EXTERNAL_|POST_|IDENTITY_|DELETE_|CONFIRMATION_|INVALID_|EXPLICIT_|MONGODB_URI_|SYNC_SOURCE_)/;
    console.error("ABORTADO:", safeCodes.test(error.code || "") ? error.code : "CLEANUP_UNCONFIRMED_CHECK_BEFORE_RETRY");
    process.exitCode = 1;
  });
}
