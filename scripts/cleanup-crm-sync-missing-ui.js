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

export const EXTERNAL_ID = "SYNC-MISSING-UI-001";
export const ALLOWED_EXTERNAL_IDS = Object.freeze([EXTERNAL_ID, "SYNC-MISSING-UI-CONTROL-001"]);
export const FEED_URL = "https://www.homeclick24.com/test-sync-missing-ui/homeclick24-missing-ui.xml";
export const CONFIRM = "DELETE_SYNC_MISSING_UI_TEST_ALBERTO";
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const id = value => String(value ?? "");
const defaultModels = { Usuario, Propiedad, ImportSource, ImportSyncRun, ImportReconciliation };
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
  for (const key of ["user-id", "source-id"]) options[key] = options[key].toLowerCase();
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
  const properties = await read(models.Propiedad, { $or: [{ externalId: { $in: ALLOWED_EXTERNAL_IDS } }, { importSourceId: sourceId }] }, session);
  const relation = { $or: [{ importSourceId: sourceId },
    { usuarioId: userId, externalId: { $in: ALLOWED_EXTERNAL_IDS } }] };
  const reconciliations = await read(models.ImportReconciliation, relation, session);
  const runs = await read(models.ImportSyncRun, { $or: [{ importSourceId: sourceId },
    { usuarioId: userId, "plan.externalId": { $in: ALLOWED_EXTERNAL_IDS } },
    { usuarioId: userId, selectedExternalIds: { $in: ALLOWED_EXTERNAL_IDS } },
    { usuarioId: userId, "newImport.selectedExternalIds": { $in: ALLOWED_EXTERNAL_IDS } },
    { usuarioId: userId, "newImport.results.externalId": { $in: ALLOWED_EXTERNAL_IDS } },
    { usuarioId: userId, "missingHide.selectedExternalIds": { $in: ALLOWED_EXTERNAL_IDS } },
    { usuarioId: userId, "missingHide.results.externalId": { $in: ALLOWED_EXTERNAL_IDS } }] }, session, "+plan");
  const candidateRunIds = runs.map(r => r._id);
  const hiddenProperties = candidateRunIds.length ? await read(models.Propiedad,
    { hiddenByMissingRunId: { $in: candidateRunIds } }, session, "+hiddenByMissingRunId") : [];
  const completedReceipts = runs.filter(r => r.missingHide?.status === "completed");
  const receipt = completedReceipts[0]?.missingHide;
  const missingHideReceiptValido = completedReceipts.length === 1 &&
    Array.isArray(receipt.selectedExternalIds) && receipt.selectedExternalIds.length === 1 &&
    receipt.selectedExternalIds[0] === EXTERNAL_ID &&
    Array.isArray(receipt.results) && receipt.results.length === 1 &&
    receipt.results[0].externalId === EXTERNAL_ID && receipt.results[0].status === "hidden" &&
    receipt.countHidden === 1 && receipt.countAlreadyHidden === 0;
  const originalIds = [...new Set([...runs.flatMap(r => [...(r.plan || []).map(e => e.propiedadId),
    ...(r.newImport?.results || []).map(e => e.propertyId)]), ...reconciliations.map(r => r.propiedadId)]
    .filter(Boolean).map(id))];
  const links = runs.flatMap(r => [
    ...(r.plan || []).filter(e => e.propiedadId).map(e => ({ externalId: e.externalId, propertyId: id(e.propiedadId) })),
    ...(r.newImport?.results || []).filter(e => e.propertyId).map(e => ({ externalId: e.externalId, propertyId: id(e.propertyId) }))
  ]);
  const referencedProperties = originalIds.length ? await read(models.Propiedad, { _id: { $in: originalIds } }, session) : [];
  const crossRuns = originalIds.length ? await read(models.ImportSyncRun, { $or: [
    { "plan.propiedadId": { $in: originalIds } }, { "newImport.results.propertyId": { $in: originalIds } }] }, session, "+plan") : [];
  const crossReconciliations = originalIds.length ? await read(models.ImportReconciliation,
    { propiedadId: { $in: originalIds } }, session) : [];
  const crossReference = crossRuns.some(r => !runs.some(known => id(known._id) === id(r._id))) ||
    crossReconciliations.some(r => !reconciliations.some(known => id(known._id) === id(r._id)));
  const refs = run => [...(run.plan || []).map(e => e.externalId), ...(run.selectedExternalIds || []),
    ...(run.newImport?.selectedExternalIds || []), ...(run.newImport?.results || []).map(e => e.externalId),
    ...(run.missingHide?.selectedExternalIds || []), ...(run.missingHide?.results || []).map(e => e.externalId)];
  const report = { usuarioEncontrado: users.length === 1, planActual: users[0]?.plan || null,
    sourceEncontrada: sources.length === 1, sourceUrlCoincide: sources[0]?.feedUrlHash === hash(FEED_URL),
    propiedadEncontrada: properties.length > 0 || referencedProperties.length > 0 || hiddenProperties.length > 0, allowedExternalIds: ALLOWED_EXTERNAL_IDS,
    propiedadesConHiddenByMissingRunId: hiddenProperties.length,
    missingHideCompletedReceipts: completedReceipts.length, missingHideReceiptValido,
    importSyncRuns: runs.length, importReconciliations: reconciliations.length,
    applyReceipts: runs.filter(r => r.appliedAt || r.selectedExternalIds?.length).length,
    newImportReceipts: runs.filter(r => r.newImport).length,
    missingHideReceipts: runs.filter(r => r.missingHide).length,
    otrasPropiedadesAfectadas: new Set([...properties, ...referencedProperties, ...hiddenProperties].map(p => id(p._id))).size,
    otrosExternalIdsEnRuns: runs.flatMap(refs).filter(e => !ALLOWED_EXTERNAL_IDS.includes(e)).length,
    runs: runs.map(r => ({ runId: id(r._id), createdAt: r.createdAt || r.startedAt,
      externalIds: [...new Set(refs(r))], applyStatus: r.appliedAt ? "applied" : r.status,
      newImportStatus: r.newImport?.status || null, missingHideStatus: r.missingHide?.status || null, sourceId: id(r.importSourceId) })),
    resultado: "NO APTO PARA LIMPIEZA", dryRun: !options.apply };
  let reason;
  if (users.length !== 1) reason = "USER_NOT_FOUND";
  else if (hiddenProperties.length) reason = "HIDDEN_PROPERTY_REFERENCE";
  else if (report.propiedadEncontrada) reason = "PROPERTY_STILL_EXISTS";
  else if (crossReference) reason = "AMBIGUOUS_CRM_REFERENCE";
  else if (!sources.length && !runs.length && !reconciliations.length) report.resultado = "YA LIMPIO";
  else if (sources.length !== 1 || id(sources[0].usuarioId) !== userId || !report.sourceUrlCoincide || sources[0].feedType !== "generic_xml") reason = "SOURCE_IDENTITY_MISMATCH";
  else if (sources[0].importLockToken || sources[0].importLockUntil > new Date()) reason = "SOURCE_BUSY";
  else if (!missingHideReceiptValido) reason = "MISSING_RECEIPT_MISMATCH";
  else {
    if (originalIds.length > 1 || originalIds.some(v => !/^[a-fA-F0-9]{24}$/.test(v)) ||
      links.some(e => e.externalId !== EXTERNAL_ID)) reason = "AMBIGUOUS_PROPERTY_REFERENCE";
    else if (runs.some(r => id(r.usuarioId) !== userId || id(r.importSourceId) !== sourceId || !refs(r).length ||
      refs(r).some(e => !ALLOWED_EXTERNAL_IDS.includes(e)) || ["running", "preparing", "applying", "indeterminate"].includes(r.status) ||
      r.planTruncated === true || (r.totalResults != null && r.totalResults > (r.plan || []).length) ||
      (r.newImport && !["completed", "failed"].includes(r.newImport.status)) ||
      (r.missingHide && !["completed", "failed"].includes(r.missingHide.status)) ||
      (r.sourceIdentityHash != null && r.sourceIdentityHash !== hash(FEED_URL)) ||
      (r.plan || []).some(e => e.missingEvidence &&
        (id(e.missingEvidence.usuarioId) !== userId || id(e.missingEvidence.importSourceId) !== sourceId)) ||
      (r.missingHide && (!(r.missingHide.selectedExternalIds || []).length ||
        [...(r.missingHide.selectedExternalIds || []), ...(r.missingHide.results || []).map(e => e.externalId)]
          .some(e => e !== EXTERNAL_ID))) ||
      (r.missingHide?.status === "completed" && (!r.missingHide.results?.length ||
        r.missingHide.results.some(e => !["hidden", "already_hidden"].includes(e.status))))))
      reason = "AMBIGUOUS_RUN";
    else if (reconciliations.some(r => id(r.usuarioId) !== userId || id(r.importSourceId) !== sourceId ||
      r.source !== "crm" || !ALLOWED_EXTERNAL_IDS.includes(r.externalId) ||
      !links.some(e => e.externalId === r.externalId && e.propertyId === id(r.propiedadId)) ||
      r.state !== "prepared" || !Array.isArray(r.publicIds) || r.publicIds.length || r.reasonCode)) reason = "RECONCILIATION_PENDING_OR_AMBIGUOUS";
    else report.resultado = "APTO PARA LIMPIEZA";
  }
  if (reason) report.reasonCode = reason;
  // The fingerprint includes read versions/content, not only the displayed counts.
  const manifest = { users, sources, properties, runs, reconciliations, referencedProperties, crossRuns, crossReconciliations,
    candidateRunIds, hiddenProperties, missingHideCompletedReceipts: completedReceipts.length, missingHideReceiptValido };
  report.planHash = hash(JSON.stringify(manifest));
  return { report, runs, reconciliations, originalIds, candidateRunIds };
}

export async function cleanup(options, { models = defaultModels, startSession = () => mongoose.startSession() } = {}) {
  // Validate even programmatic callers before any database access.
  const args = [`--user-id=${options["user-id"]}`, `--source-id=${options["source-id"]}`];
  if (options.apply) args.push("--apply", `--confirm=${options.confirm}`, `--expect-plan=${options["expect-plan"]}`);
  options = parseArgs(args);
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
      for (const [name, records] of [["ImportSyncRun", state.runs], ["ImportReconciliation", state.reconciliations]]) {
        const count = await models[name].deleteMany({ _id: { $in: records.map(r => r._id) },
          usuarioId: options["user-id"], importSourceId: options["source-id"] }, { session });
        if (count.deletedCount !== records.length) fail("DELETE_COUNT_MISMATCH");
        deleted[name] = count.deletedCount;
      }
      const source = await models.ImportSource.deleteMany({ _id: options["source-id"], usuarioId: options["user-id"],
        feedType: "generic_xml", feedUrlHash: hash(FEED_URL) }, { session });
      if (source.deletedCount !== 1) fail("DELETE_COUNT_MISMATCH");
      deleted.ImportSource = source.deletedCount;
      const after = await inspect(options, models, session);
      if (after.report.resultado !== "YA LIMPIO") fail("POST_VERIFICATION_FAILED");
      if (state.candidateRunIds.length && (await read(models.Propiedad,
        { hiddenByMissingRunId: { $in: state.candidateRunIds } }, session, "+hiddenByMissingRunId")).length)
        fail("POST_VERIFICATION_FAILED");
      for (const [name, records] of [["ImportSyncRun", state.runs], ["ImportReconciliation", state.reconciliations]]) {
        if (records.length && (await read(models[name], { _id: { $in: records.map(r => r._id) } }, session)).length)
          fail("POST_VERIFICATION_FAILED");
      }
      // Keep the IDs from the deleted receipts: never infer them from a missing property.
      if (state.originalIds.length) {
        const ids = state.originalIds;
        const residualRuns = await read(models.ImportSyncRun, { $or: [
          { "plan.propiedadId": { $in: ids } }, { "newImport.results.propertyId": { $in: ids } }] }, session, "+plan");
        const residualReconciliations = await read(models.ImportReconciliation, { propiedadId: { $in: ids } }, session);
        const residualProperties = await read(models.Propiedad, { _id: { $in: ids } }, session);
        if (residualRuns.length || residualReconciliations.length || residualProperties.length) fail("POST_VERIFICATION_FAILED");
      }
      result = { ...state.report, resultado: "LIMPIEZA COMPLETADA", deleted, verificacionPosterior: true };
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
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
