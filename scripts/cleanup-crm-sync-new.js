#!/usr/bin/env node
import "dotenv/config";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import Usuario from "../models/Usuario.js";
import Propiedad from "../models/Propiedad.js";
import ImportSource from "../models/ImportSource.js";
import ImportSyncRun from "../models/ImportSyncRun.js";
import ImportReconciliation from "../models/ImportReconciliation.js";
import Conversacion from "../models/Conversacion.js";
import Notificacion from "../models/Notificacion.js";
import EstadisticaAnuncio from "../models/EstadisticaAnuncio.js";

export const EXTERNAL_ID = "SYNC-NEW-TEST-001";
export const FEED_URL = "https://www.homeclick24.com/test-sync-new/homeclick24-sync-new-test.xml";
export const CONFIRM = "DELETE_SYNC_NEW_TEST_ALBERTO";
const TITLE = "Piso de prueba NEW CRM en Chipiona";
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const id = value => String(value ?? "");
const defaultModels = { Usuario, Propiedad, ImportSource, ImportSyncRun, ImportReconciliation,
  Conversacion, Notificacion, EstadisticaAnuncio };
const fail = code => { throw Object.assign(new Error(code), { code }); };

export function parseArgs(args) {
  const options = { apply: false };
  for (const arg of args) {
    if (arg === "--apply" && !options.apply) { options.apply = true; continue; }
    const match = /^--(user-id|source-id|confirm|expect-plan)=(.+)$/.exec(arg);
    if (!match || options[match[1]] !== undefined) fail("INVALID_ARGUMENTS");
    options[match[1]] = match[2];
  }
  for (const key of ["user-id", "source-id"]) if (!/^[a-fA-F0-9]{24}$/.test(options[key] || "")) fail("INVALID_ARGUMENTS");
  if (options.apply && (options.confirm !== CONFIRM || !/^[a-f0-9]{64}$/.test(options["expect-plan"] || ""))) fail("CONFIRMATION_REQUIRED");
  if (!options.apply && (options.confirm || options["expect-plan"])) fail("INVALID_ARGUMENTS");
  return options;
}

async function read(Model, filter, session, select) {
  let query = Model.find(filter);
  if (select) query = query.select(select);
  if (session) query = query.session(session);
  return (await query.lean()).sort((a, b) => id(a._id).localeCompare(id(b._id)));
}

async function inspect(options, models, session) {
  const userId = options["user-id"], sourceId = options["source-id"];
  const users = await read(models.Usuario, { _id: userId }, session, "plan +publicationVersion");
  const sources = await read(models.ImportSource, { _id: sourceId }, session, "+encryptedFeedUrl");
  const properties = await read(models.Propiedad, { $or: [{ externalId: EXTERNAL_ID }, { importSourceId: sourceId }] }, session);
  const targets = properties.filter(p => p.externalId === EXTERNAL_ID);
  const propertyIds = targets.map(p => p._id);
  const relation = { $or: [{ importSourceId: sourceId }, { propiedadId: { $in: propertyIds } },
    { usuarioId: userId, externalId: EXTERNAL_ID }] };
  const reconciliations = await read(models.ImportReconciliation, relation, session);
  const runs = await read(models.ImportSyncRun, { $or: [{ importSourceId: sourceId },
    { "plan.propiedadId": { $in: propertyIds } }, { "newImport.results.propertyId": { $in: propertyIds } },
    { usuarioId: userId, "plan.externalId": EXTERNAL_ID },
    { usuarioId: userId, "newImport.selectedExternalIds": EXTERNAL_ID }] }, session, "+plan");
  const conversations = await read(models.Conversacion, { propiedadId: { $in: propertyIds } }, session);
  const notifications = await read(models.Notificacion, { propiedadId: { $in: propertyIds } }, session);
  const favorites = await read(models.Usuario, { favoritos: { $in: propertyIds } }, session, "_id");
  const stats = await read(models.EstadisticaAnuncio, { propiedadId: { $in: propertyIds } }, session);
  const refs = run => [...(run.plan || []).map(e => e.externalId), ...(run.selectedExternalIds || []),
    ...(run.newImport?.selectedExternalIds || []), ...(run.newImport?.results || []).map(e => e.externalId)];
  const report = { usuarioEncontrado: users.length === 1, planActual: users[0]?.plan || null,
    sourceEncontrada: sources.length === 1, sourceUrlCoincide: sources[0]?.feedUrlHash === hash(FEED_URL),
    propiedadEncontrada: targets.length === 1, externalId: EXTERNAL_ID, propiedadId: id(targets[0]?._id) || null,
    tituloCoincide: targets[0]?.titulo === TITLE, imagenesAsociadas: targets.reduce((n,p) => n + (p.imagenes?.length || 0), 0),
    importSyncRuns: runs.length, importReconciliations: reconciliations.length,
    importReceipts: runs.reduce((n,r) => n + (r.newImport?.results?.length || 0), 0),
    otrasPropiedadesAfectadas: properties.length - targets.length,
    otrosExternalIdsEnRuns: runs.flatMap(refs).filter(e => e !== EXTERNAL_ID).length,
    referenciasExternas: conversations.length + notifications.length + favorites.length,
    estadisticasAsociadas: stats.length, runs: runs.map(r => ({ runId: id(r._id), createdAt: r.createdAt || r.startedAt,
      externalIds: [...new Set(refs(r))], newImportStatus: r.newImport?.status || null, sourceId: id(r.importSourceId) })),
    resultado: "NO APTO PARA LIMPIEZA", dryRun: !options.apply };
  let reason;
  if (users.length !== 1) reason = "USER_NOT_FOUND";
  else if (!sources.length && !properties.length && !runs.length && !reconciliations.length) report.resultado = "YA LIMPIO";
  else if (sources.length !== 1 || id(sources[0].usuarioId) !== userId || !report.sourceUrlCoincide || sources[0].feedType !== "generic_xml") reason = "SOURCE_IDENTITY_MISMATCH";
  else if (sources[0].importLockToken || sources[0].importLockUntil > new Date()) reason = "SOURCE_BUSY";
  else if (targets.length !== 1 || properties.length !== 1) reason = "PROPERTY_SELECTION_AMBIGUOUS";
  else {
    const p = targets[0];
    if (id(p.usuarioId) !== userId || id(p.importSourceId) !== sourceId || p.source !== "crm" || p.titulo !== TITLE ||
      p.precio !== 198000 || p.localidad !== "Chipiona" || p.tipoOperacion !== "venta" || p.referencia !== "") reason = "PROPERTY_IDENTITY_MISMATCH";
    else if (!Array.isArray(p.imagenes) || p.imagenes.length || p.videoUrl) reason = "MEDIA_PRESENT";
    else if (report.referenciasExternas) reason = "EXTERNAL_REFERENCES";
    else if (stats.some(s => id(s.usuarioId) !== userId)) reason = "AMBIGUOUS_STATISTICS";
    else if (runs.some(r => id(r.usuarioId) !== userId || id(r.importSourceId) !== sourceId || !refs(r).length ||
      refs(r).some(e => e !== EXTERNAL_ID) || ["running", "applying"].includes(r.status) ||
      ["importing", "indeterminate"].includes(r.newImport?.status) ||
      [...(r.plan || []).map(e => e.propiedadId), ...(r.newImport?.results || []).map(e => e.propertyId)]
        .filter(Boolean).some(v => id(v) !== id(p._id)))) reason = "AMBIGUOUS_RUN";
    else if (reconciliations.some(r => id(r.usuarioId) !== userId || id(r.importSourceId) !== sourceId ||
      id(r.propiedadId) !== id(p._id) || r.source !== "crm" || r.externalId !== EXTERNAL_ID ||
      r.state !== "prepared" || !Array.isArray(r.publicIds) || r.publicIds.length || r.reasonCode)) reason = "RECONCILIATION_PENDING_OR_AMBIGUOUS";
    else report.resultado = "APTO PARA LIMPIEZA";
  }
  if (reason) report.reasonCode = reason;
  // The fingerprint includes read versions/content, not only the displayed counts.
  const manifest = { users, sources, properties, runs, reconciliations, stats };
  report.planHash = hash(JSON.stringify(manifest));
  return { report, targets, runs, reconciliations, stats };
}

export async function cleanup(options, { models = defaultModels, startSession = () => mongoose.startSession() } = {}) {
  // Validate even programmatic callers before any database access.
  const args = [`--user-id=${options["user-id"]}`, `--source-id=${options["source-id"]}`];
  if (options.apply) args.push("--apply", `--confirm=${options.confirm}`, `--expect-plan=${options["expect-plan"]}`);
  parseArgs(args);
  if (!options.apply) return (await inspect(options, models)).report;
  const session = await startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const state = await inspect(options, models, session);
      if (state.report.resultado === "YA LIMPIO") { result = state.report; return; }
      if (state.report.resultado !== "APTO PARA LIMPIEZA") fail(state.report.reasonCode);
      if (state.report.planHash !== options["expect-plan"]) fail("PLAN_CHANGED");
      // Contend on the existing source document: concurrent import/configuration cannot commit unnoticed.
      const fence = await models.ImportSource.updateOne({ _id: options["source-id"], usuarioId: options["user-id"],
        feedUrlHash: hash(FEED_URL), importLockToken: { $exists: false } },
      { $set: { importLockToken: crypto.randomUUID(), importLockUntil: new Date(Date.now() + 60000) } }, { session });
      if (fence.matchedCount !== 1) fail("SOURCE_BUSY");
      const deleted = {};
      for (const [name, records] of [["ImportSyncRun", state.runs], ["ImportReconciliation", state.reconciliations],
        ["EstadisticaAnuncio", state.stats], ["Propiedad", state.targets]]) {
        const count = await models[name].deleteMany({ _id: { $in: records.map(r => r._id) } }, { session });
        if (count.deletedCount !== records.length) fail("DELETE_COUNT_MISMATCH");
        deleted[name] = count.deletedCount;
      }
      const source = await models.ImportSource.deleteMany({ _id: options["source-id"], usuarioId: options["user-id"] }, { session });
      if (source.deletedCount !== 1) fail("DELETE_COUNT_MISMATCH");
      deleted.ImportSource = source.deletedCount;
      const after = await inspect(options, models, session);
      if (after.report.resultado !== "YA LIMPIO") fail("POST_VERIFICATION_FAILED");
      result = { ...state.report, resultado: "LIMPIEZA COMPLETADA", deleted, verificacionPosterior: true };
    });
    return result;
  } finally { await session.endSession(); }
}

export async function main(args = process.argv.slice(2)) {
  let connected = false;
  try {
    const options = parseArgs(args);
    if (!process.env.MONGODB_URI) fail("MONGODB_URI_REQUIRED");
    await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, autoCreate: false }); connected = true;
    const report = await cleanup(options);
    console.log(JSON.stringify(report, null, 2));
    if (report.resultado === "NO APTO PARA LIMPIEZA") process.exitCode = 1;
  } catch (error) {
    const code = /^[A-Z_]+$/.test(error.code || "") ? error.code : "CLEANUP_FAILED";
    console.error(JSON.stringify({ resultado: "NO APTO PARA LIMPIEZA", code })); process.exitCode = 1;
  } finally { if (connected) await mongoose.disconnect(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
