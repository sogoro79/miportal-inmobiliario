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

export const TARGET = "SYNC-REAPPEARED-UI-001";
export const CONTROL = "SYNC-REAPPEARED-UI-CONTROL-001";
export const ALLOWED_EXTERNAL_IDS = Object.freeze([TARGET, CONTROL]);
export const FEED_URL = "https://www.homeclick24.com/test-sync-reappeared-ui/homeclick24-reappeared-ui.xml";
export const CONFIRM = "DELETE_SYNC_REAPPEARED_UI_TEST_ALBERTO";
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const SOURCE_HASH = hash(FEED_URL);
const id = value => String(value ?? "");
const validId = value => /^[a-fA-F0-9]{24}$/.test(id(value));
const fail = code => { throw Object.assign(new Error(code), { code }); };
const defaultModels = { Usuario, Propiedad, ImportSource, ImportSyncRun, ImportReconciliation };
const unique = values => [...new Set(values.filter(Boolean).map(id))].sort();
const safeId = value => validId(value) ? id(value) : "[identidad invalida]";
const safeDate = value => value != null && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const safeStatus = (value, allowed) => value == null ? null : allowed.includes(value) ? value : "unknown";
const merge = (...groups) => [...new Map(groups.flat().map(row => [id(row._id), row])).values()]
  .sort((a, b) => id(a._id).localeCompare(id(b._id)));

export function parseArgs(args) {
  const options = { apply: false };
  for (const arg of args) {
    if (arg === "--apply" && !options.apply) { options.apply = true; continue; }
    const match = /^--(user-id|source-id|confirm|expect-plan)=(.+)$/.exec(arg);
    if (!match || options[match[1]] !== undefined) fail("INVALID_ARGUMENTS");
    options[match[1]] = match[2];
  }
  for (const key of ["user-id", "source-id"]) {
    if (!validId(options[key])) fail("INVALID_ARGUMENTS");
    options[key] = options[key].toLowerCase();
  }
  if (options.apply && (options.confirm !== CONFIRM || !/^[a-f0-9]{64}$/.test(options["expect-plan"] || ""))) fail("CONFIRMATION_REQUIRED");
  if (!options.apply && (options.confirm || options["expect-plan"])) fail("INVALID_ARGUMENTS");
  return options;
}

async function read(Model, filter, session, select) {
  let query = Model.find(filter);
  if (select) query = query.select(select);
  if (session) query = query.session(session);
  if (query.setOptions) query = query.setOptions({ strictQuery: false });
  return (await query.lean()).sort((a, b) => id(a._id).localeCompare(id(b._id)));
}

function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (value?.toHexString) return value.toHexString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

const runRefs = run => [...(run.plan || []).map(e => e.externalId), ...(run.selectedExternalIds || []),
  ...(run.newImport?.selectedExternalIds || []), ...(run.newImport?.results || []).map(e => e.externalId),
  ...(run.missingHide?.selectedExternalIds || []), ...(run.missingHide?.results || []).map(e => e.externalId),
  ...(run.reappearedRestore?.selectedExternalIds || []), ...(run.reappearedRestore?.results || []).map(e => e.externalId),
  ...(run.plan || []).filter(e => e.restoreEvidence).map(e => e.restoreEvidence.externalId)];
const runPropertyIds = run => (run.plan || []).flatMap(e => [e.propiedadId, e.restoreEvidence?.propiedadId])
  .concat((run.newImport?.results || []).map(e => e.propertyId));
const runLinks = run => (run.plan || []).flatMap(e => e.restoreEvidence
  ? [e.restoreEvidence.causalRunId, e.restoreEvidence.expectedHiddenByMissingRunId] : []);
const propertyRefs = (propertyIds, runIds) => [
  { _id: { $in: propertyIds } }, { hiddenByMissingRunId: { $in: runIds } }, { lastSeenRunId: { $in: runIds } }
];
const crossRunRefs = (propertyIds, runIds) => [
  { "plan.propiedadId": { $in: propertyIds } }, { "plan.restoreEvidence.propiedadId": { $in: propertyIds } },
  { "newImport.results.propertyId": { $in: propertyIds } },
  { "plan.restoreEvidence.causalRunId": { $in: runIds } },
  { "plan.restoreEvidence.expectedHiddenByMissingRunId": { $in: runIds } }
];
const reconciliationRefs = (propertyIds, runIds) => [
  { propiedadId: { $in: propertyIds } }, { runId: { $in: runIds } }, { importSyncRunId: { $in: runIds } }
];

function exactReceipt(receipt, resultStatus, countField, alreadyField) {
  const start = new Date(receipt?.startedAt).getTime(), end = new Date(receipt?.completedAt).getTime();
  return receipt?.status === "completed" && receipt.startedAt != null && receipt.completedAt != null &&
    typeof receipt.operationId === "string" && receipt.operationId.length > 0 &&
    Number.isFinite(start) && Number.isFinite(end) && end >= start &&
    Array.isArray(receipt.selectedExternalIds) && receipt.selectedExternalIds.length === 1 && receipt.selectedExternalIds[0] === TARGET &&
    Array.isArray(receipt.results) && receipt.results.length === 1 && receipt.results[0]?.externalId === TARGET &&
    receipt.results[0].status === resultStatus && receipt[countField] === 1 && receipt[alreadyField] === 0 && !receipt.errorCode;
}

async function inspect(options, models, session, historical = {}) {
  const userId = options["user-id"], sourceId = options["source-id"];
  const users = await read(models.Usuario, { _id: userId }, session, "nombre email plan activo +publicationVersion");
  const sources = await read(models.ImportSource, { $or: [{ _id: sourceId }, { usuarioId: userId, feedUrlHash: SOURCE_HASH }] }, session, "+encryptedFeedUrl");
  const selection = [{ importSourceId: sourceId }, ...[
    "plan.externalId", "selectedExternalIds", "newImport.selectedExternalIds", "newImport.results.externalId",
    "missingHide.selectedExternalIds", "missingHide.results.externalId", "reappearedRestore.selectedExternalIds",
    "reappearedRestore.results.externalId", "plan.restoreEvidence.externalId"
  ].map(field => ({ [field]: { $in: ALLOWED_EXTERNAL_IDS } }))];
  const runs = await read(models.ImportSyncRun, { $or: selection }, session, "+plan");
  const runIds = unique([...runs.map(r => r._id), ...(historical.runIds || [])]);
  const reconciliations = await read(models.ImportReconciliation, { $or: [
    { importSourceId: sourceId }, { externalId: { $in: ALLOWED_EXTERNAL_IDS } }
  ] }, session);
  const propertyIds = unique([...runs.flatMap(runPropertyIds), ...reconciliations.map(r => r.propiedadId), ...(historical.propertyIds || [])]);
  const properties = await read(models.Propiedad, { $or: [
    { externalId: { $in: ALLOWED_EXTERNAL_IDS } }, { importSourceId: sourceId }, ...propertyRefs(propertyIds, runIds)
  ] }, session, "_id usuarioId externalId importSourceId +hiddenByMissingRunId lastSeenRunId");
  const crossRuns = await read(models.ImportSyncRun, { $or: crossRunRefs(propertyIds, runIds) }, session, "+plan");
  const crossReconciliations = await read(models.ImportReconciliation, { $or: reconciliationRefs(propertyIds, runIds) }, session);
  // Cross-reference matches are not silently included in the deletion set.
  const foreignRuns = crossRuns.filter(r => !runs.some(known => id(known._id) === id(r._id)));
  const foreignReconciliations = crossReconciliations.filter(r => !reconciliations.some(known => id(known._id) === id(r._id)));
  const crossSources = await read(models.ImportSource, { $or: [
    { _id: { $in: unique(runs.map(r => r.importSourceId)) } }
  ] }, session, "+encryptedFeedUrl");
  const foreignSources = crossSources.filter(s => id(s._id) !== sourceId);
  const missingRuns = runs.filter(r => r.missingHide?.status === "completed");
  const restoreRuns = runs.filter(r => r.reappearedRestore?.status === "completed");
  const missing = missingRuns[0], restored = restoreRuns[0];
  const missingValid = missingRuns.length === 1 && exactReceipt(missing.missingHide, "hidden", "countHidden", "countAlreadyHidden");
  const restoreValid = restoreRuns.length === 1 && exactReceipt(restored.reappearedRestore, "restored", "countRestored", "countAlreadyRestored") &&
    restored.reappearedRestore.selectionHash === hash(JSON.stringify([TARGET]));
  const hiddenProperties = properties.filter(p => runIds.includes(id(p.hiddenByMissingRunId)));
  const evidence = restored?.plan?.find(e => e.externalId === TARGET)?.restoreEvidence;
  const missingEntry = missing?.plan?.find(e => e.externalId === TARGET);
  const causalValid = missingValid && restoreValid && missingEntry?.type === "MISSING" &&
    restored.plan?.find(e => e.externalId === TARGET)?.type === "REAPPEARED" &&
    id(missing._id) !== id(restored._id) && propertyIds.length === 1 && validId(propertyIds[0]) &&
    id(missingEntry.propiedadId) === propertyIds[0] && id(evidence?.propiedadId) === propertyIds[0] &&
    id(evidence?.usuarioId) === userId && id(evidence?.importSourceId) === sourceId && evidence?.externalId === TARGET &&
    id(evidence?.causalRunId) === id(missing._id) && id(evidence?.expectedHiddenByMissingRunId) === id(missing._id) &&
    new Date(restored.reappearedRestore.startedAt) >= new Date(missing.missingHide.completedAt);
  const report = {
    usuarioEncontrado: users.length === 1, planActual: users[0]?.plan || null,
    usuario: users.length === 1 ? { userId: id(users[0]._id), nombre: users[0].nombre || null, email: users[0].email || null } : null,
    sourceEncontrada: sources.some(s => id(s._id) === sourceId),
    sourceUrlCoincide: sources.length === 1 && sources[0].feedUrlHash === SOURCE_HASH,
    propiedadTargetEncontrada: properties.some(p => p.externalId === TARGET),
    propiedadControlEncontrada: properties.some(p => p.externalId === CONTROL),
    allowedExternalIds: ALLOWED_EXTERNAL_IDS, propiedadesConHiddenByMissingRunId: hiddenProperties.length,
    importSyncRuns: runs.length, importReconciliations: reconciliations.length,
    applyReceipts: runs.filter(r => r.appliedAt || r.resultCodes?.length || r.selectedExternalIds?.length || r.status === "applied").length,
    newImportReceipts: runs.filter(r => r.newImport).length,
    missingHideReceipts: runs.filter(r => r.missingHide).length,
    reappearedRestoreReceipts: runs.filter(r => r.reappearedRestore).length,
    missingHideCompletedValido: Boolean(missingValid), reappearedRestoreCompletedValido: Boolean(restoreValid),
    otrasPropiedadesAfectadas: properties.length,
    otrosExternalIdsEnRuns: runs.flatMap(runRefs).filter(ref => !ALLOWED_EXTERNAL_IDS.includes(ref)).length,
    referenciasExternas: foreignRuns.length + foreignReconciliations.length + foreignSources.length,
    runs: runs.map(r => ({ runId: safeId(r._id), createdAt: safeDate(r.createdAt || r.startedAt),
      externalIds: [...new Set(runRefs(r).map(ref => ALLOWED_EXTERNAL_IDS.includes(ref) ? ref : "[externalId ajeno]"))].sort(),
      status: safeStatus(r.status, ["running", "completed", "incomplete", "simulated", "applying", "applied", "blocked", "failed", "aborted"]),
      sourceId: safeId(r.importSourceId), newImportStatus: safeStatus(r.newImport?.status, ["idle", "importing", "completed", "indeterminate", "failed"]),
      missingHideStatus: safeStatus(r.missingHide?.status, ["preparing", "applying", "completed", "indeterminate", "failed"]),
      reappearedRestoreStatus: safeStatus(r.reappearedRestore?.status, ["preparing", "applying", "completed", "indeterminate", "failed"]) })),
    resultado: "NO APTO", dryRun: !options.apply
  };
  let reason;
  if (users.length !== 1) reason = "USER_NOT_FOUND";
  else if (properties.length) reason = "PROPERTY_OR_INVERSE_REFERENCE_EXISTS";
  else if (report.referenciasExternas) reason = "FOREIGN_CRM_REFERENCE";
  else if (!sources.length && !runs.length && !reconciliations.length) report.resultado = "YA LIMPIO";
  else if (sources.length !== 1 || id(sources[0]._id) !== sourceId || id(sources[0].usuarioId) !== userId ||
    sources[0].feedType !== "generic_xml" || !report.sourceUrlCoincide) reason = "SOURCE_IDENTITY_MISMATCH";
  else if (Object.hasOwn(sources[0], "importLockToken") || new Date(sources[0].importLockUntil) > new Date()) reason = "SOURCE_BUSY";
  else if (report.applyReceipts || report.newImportReceipts) reason = "UNEXPECTED_UPDATE_OR_NEW_OPERATION";
  else if (runs.some(r => id(r.usuarioId) !== userId || id(r.importSourceId) !== sourceId || r.status !== "simulated" ||
    r.mode !== "simulation" || r.sourceIdentityHash !== SOURCE_HASH || r.snapshotComplete !== true ||
    r.planTruncated === true || r.errorCode || r.blocked === true || !Array.isArray(r.plan) || !r.plan.length ||
    r.totalResults !== r.plan.length || new Set(r.plan.map(e => e.externalId)).size !== r.plan.length ||
    runRefs(r).some(ref => !ALLOWED_EXTERNAL_IDS.includes(ref)) ||
    r.plan.some(e => e.externalId === CONTROL ? e.type !== "NEW" || e.propiedadId || e.restoreEvidence || e.missingEvidence :
      !["CONFLICT", "UNCHANGED", "MISSING", "REAPPEARED"].includes(e.type) || id(e.propiedadId) !== propertyIds[0]) ||
    r.plan.some(e => [e.missingEvidence, e.restoreEvidence].filter(Boolean).some(evidence =>
      id(evidence.usuarioId) !== userId || id(evidence.importSourceId) !== sourceId)) ||
    runLinks(r).some(ref => !runIds.includes(id(ref))) ||
    (r.missingHide && !exactReceipt(r.missingHide, "hidden", "countHidden", "countAlreadyHidden")) ||
    (r.reappearedRestore && !exactReceipt(r.reappearedRestore, "restored", "countRestored", "countAlreadyRestored")))) reason = "AMBIGUOUS_OR_ACTIVE_RUN";
  else if (!missingValid || !restoreValid || !causalValid) reason = "RECEIPT_OR_CAUSAL_MISMATCH";
  else if (reconciliations.some(r => id(r.usuarioId) !== userId || id(r.importSourceId) !== sourceId || r.source !== "crm" ||
    r.externalId !== TARGET || id(r.propiedadId) !== propertyIds[0] || r.state !== "prepared" || r.reasonCode ||
    !Array.isArray(r.publicIds) || r.publicIds.length ||
    [r.runId, r.importSyncRunId].filter(Boolean).some(ref => !runIds.includes(id(ref))))) reason = "RECONCILIATION_PENDING_OR_AMBIGUOUS";
  else report.resultado = "APTO PARA LIMPIEZA";
  if (reason) report.reasonCode = reason;
  report.planHash = hash(JSON.stringify(canonical({ userId, sourceId, expectedSourceHash: SOURCE_HASH,
    whitelist: ALLOWED_EXTERNAL_IDS, users, sources, runs, reconciliations, properties,
    crossRuns, crossReconciliations, crossSources, propertyIds, runIds,
    missingValid, restoreValid, causalValid, resultado: report.resultado, reason: reason || null })));
  return { report, runs, reconciliations, propertyIds, runIds };
}

async function verify(options, models, session, state) {
  const after = await inspect(options, models, session, state);
  if (after.report.resultado !== "YA LIMPIO") fail("POST_VERIFICATION_FAILED");
  for (const [name, records] of [["ImportSource", [{ _id: options["source-id"] }]],
    ["ImportSyncRun", state.runs], ["ImportReconciliation", state.reconciliations]]) {
    if (records.length && (await read(models[name], { _id: { $in: records.map(r => r._id) } }, session)).length) fail("POST_VERIFICATION_FAILED");
  }
}

export async function cleanup(options, { models = defaultModels, startSession = () => mongoose.startSession() } = {}) {
  if (Object.keys(options).some(key => !["user-id", "source-id", "apply", "confirm", "expect-plan"].includes(key))) fail("INVALID_ARGUMENTS");
  const args = [`--user-id=${options["user-id"]}`, `--source-id=${options["source-id"]}`];
  if (options.apply) args.push("--apply", `--confirm=${options.confirm}`, `--expect-plan=${options["expect-plan"]}`);
  else if (options.confirm || options["expect-plan"]) fail("INVALID_ARGUMENTS");
  options = parseArgs(args);
  const initial = await inspect(options, models);
  if (!options.apply || initial.report.resultado === "YA LIMPIO") return initial.report;
  if (initial.report.resultado !== "APTO PARA LIMPIEZA") fail(initial.report.reasonCode);
  if (initial.report.planHash !== options["expect-plan"]) fail("PLAN_CHANGED");
  const session = await startSession(), token = crypto.randomUUID();
  let result, committedState;
  try {
    await session.withTransaction(async () => {
      const state = await inspect(options, models, session);
      if (state.report.resultado !== "APTO PARA LIMPIEZA") fail(state.report.reasonCode || "PLAN_CHANGED");
      if (state.report.planHash !== options["expect-plan"]) fail("PLAN_CHANGED");
      // All productive CRM operations coordinate on this same source document.
      const fence = await models.ImportSource.updateOne({ _id: options["source-id"], usuarioId: options["user-id"],
        feedType: "generic_xml", feedUrlHash: SOURCE_HASH, importLockToken: { $exists: false } },
      { $set: { importLockToken: token, importLockUntil: new Date(Date.now() + 120000) } }, { session });
      if (fence.matchedCount !== 1) fail("SOURCE_BUSY");
      const deleted = {};
      for (const [name, records] of [["ImportSyncRun", state.runs], ["ImportReconciliation", state.reconciliations]]) {
        const deletion = await models[name].deleteMany({ _id: { $in: records.map(r => r._id) },
          usuarioId: options["user-id"], importSourceId: options["source-id"] }, { session });
        if (deletion.deletedCount !== records.length) fail("DELETE_COUNT_MISMATCH");
        deleted[name] = deletion.deletedCount;
      }
      const source = await models.ImportSource.deleteMany({ _id: options["source-id"], usuarioId: options["user-id"],
        feedType: "generic_xml", feedUrlHash: SOURCE_HASH, importLockToken: token }, { session });
      if (source.deletedCount !== 1) fail("DELETE_COUNT_MISMATCH");
      deleted.ImportSource = source.deletedCount;
      await verify(options, models, session, state);
      committedState = state;
      result = { ...state.report, resultado: "LIMPIEZA COMPLETADA", deleted, verificacionPosterior: true };
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
    // Recheck after commit, retaining the historical IDs from the deleted receipts.
    await verify(options, models, undefined, committedState);
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
    if (report.resultado === "NO APTO") process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ resultado: "NO APTO", code: /^[A-Z_]+$/.test(error.code || "") ? error.code : "CLEANUP_UNCONFIRMED" }));
    process.exitCode = 1;
  } finally { if (connected) await mongoose.disconnect(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
