import { baselineValid, hasOverrides, managedFingerprint, managedChangedFields,
  suppliedNonPhotoDifferences, SYNC_APPLY_FIELDS_VERSION, SYNC_SNAPSHOT_VERSION, SYNC_NORMALIZATION_VERSION } from "./syncBaseline.js";
import { missingContentFingerprint, MISSING_EVIDENCE_VERSION } from "./missingEligibility.js";
import { tieneOcultacionManualSeparada, tieneEstadoNoDisponible } from "../propertyAvailability.js";
import { getEstadoPublicacionUsuario } from "../publishEligibility.js";
import { getPlanConfig, KNOWN_PLAN_IDS } from "../planLimits.js";
import { usuarioTienePlanLanzamientoActivo } from "../launchPlan.js";
import { usuarioTienePromocionProfesionalActiva } from "../professionalPromotion.js";

export const REAPPEARED_EVIDENCE_VERSION = 1;
export const REAPPEARED_BLOCK_CODES = new Set([
  "REAPPEARED_SNAPSHOT_INCOMPLETE", "REAPPEARED_RUN_TRUNCATED", "REAPPEARED_PROPERTY_NOT_FOUND",
  "REAPPEARED_IDENTITY_AMBIGUOUS", "REAPPEARED_OWNER_CHANGED", "REAPPEARED_SOURCE_CHANGED",
  "REAPPEARED_HIDE_MARKER_MISSING", "REAPPEARED_REMOVAL_DATE_MISSING", "REAPPEARED_CAUSAL_RUN_INVALID",
  "REAPPEARED_ALREADY_VISIBLE", "REAPPEARED_NOT_ENROLLED", "REAPPEARED_BASELINE_INVALID",
  "REAPPEARED_MANUAL_OVERRIDE", "REAPPEARED_RECONCILIATION_UNCHECKED", "REAPPEARED_RECONCILIATION_PENDING",
  "REAPPEARED_REVISION_INVALID", "REAPPEARED_CONTENT_CHANGED", "REAPPEARED_PLAN_INACTIVE",
  "REAPPEARED_PLAN_LIMIT", "REAPPEARED_LISTING_EXPIRED", "REAPPEARED_RUN_CHANGED",
  "REAPPEARED_RUN_EXPIRED", "REAPPEARED_OTHER_HIDING_CAUSE"
]);
const id = value => String(value ?? "").toLowerCase();
const validId = value => /^[a-f0-9]{24}$/.test(id(value));
const validHash = value => /^[a-f0-9]{64}$/.test(value || "");
const date = value => value == null || value === "" ? NaN : new Date(value).getTime();
const blocked = code => ({ restoreEligible: false, restoreBlockCode: code });
const expectedVersions = { snapshotVersion: SYNC_SNAPSHOT_VERSION, normalizationVersion: SYNC_NORMALIZATION_VERSION,
  applyFieldsVersion: SYNC_APPLY_FIELDS_VERSION };

export function hasReappearedMarkers(property) {
  // Incomplete causal markers are candidates for review, never a fallback UPDATE.
  return property.visiblePublicamente === false && property.hiddenByMissingRunId != null;
}

function causalEntry(property, context) {
  if (!Array.isArray(context.causalRuns)) return null;
  const matches = context.causalRuns.filter(run => id(run._id) === id(property.hiddenByMissingRunId));
  if (matches.length !== 1) return null;
  const run = matches[0], receipt = run.missingHide;
  if (id(run.usuarioId) !== id(context.usuarioId) || id(run.importSourceId) !== id(context.importSourceId) ||
    run.sourceIdentityHash !== context.sourceIdentityHash || !validHash(run.sourceIdentityHash) ||
    run.status !== "simulated" || run.snapshotComplete !== true || run.planTruncated === true ||
    run.totalResults > 100 || !validHash(run.snapshotDigest) ||
    Object.entries(expectedVersions).some(([key, value]) => run[key] !== value) ||
    !receipt || receipt.status !== "completed" || !Array.isArray(receipt.selectedExternalIds) ||
    !receipt.selectedExternalIds.length || receipt.selectedExternalIds.length > 10 ||
    new Set(receipt.selectedExternalIds).size !== receipt.selectedExternalIds.length ||
    !Array.isArray(receipt.results) || receipt.results.length !== receipt.selectedExternalIds.length ||
    receipt.results.some(e => !e || typeof e !== "object") ||
    new Set(receipt.results.map(e => e.externalId)).size !== receipt.results.length ||
    receipt.results.some(e => !receipt.selectedExternalIds.includes(e.externalId) ||
      !["hidden", "already_hidden"].includes(e.status)) ||
    receipt.countHidden !== receipt.results.filter(e => e.status === "hidden").length ||
    receipt.countAlreadyHidden !== receipt.results.filter(e => e.status === "already_hidden").length ||
    !receipt.selectedExternalIds.includes(property.externalId) ||
    !receipt.results.some(e => e.externalId === property.externalId && ["hidden", "already_hidden"].includes(e.status)))
    return null;
  if (!Array.isArray(run.plan) || run.plan.length > 100 || run.plan.some(e => !e || typeof e !== "object")) return null;
  const entries = run.plan.filter(e => e.externalId === property.externalId);
  if (entries.length !== 1 || entries[0].type !== "MISSING" || entries[0].hideMissingEligible !== true ||
    entries[0].safeReasonCode !== "MISSING_REQUIRES_REVIEW" ||
    id(entries[0].propiedadId) !== id(property._id)) return null;
  const entry = entries[0], evidence = entry.missingEvidence;
  if (!evidence || evidence.version !== MISSING_EVIDENCE_VERSION || evidence.enrolled !== true || evidence.reconciliationChecked !== true ||
    id(evidence.usuarioId) !== id(context.usuarioId) || id(evidence.importSourceId) !== id(context.importSourceId) ||
    evidence.expectedVisiblePublicamente !== true ||
    !Number.isSafeInteger(evidence.expectedContentRevision) || evidence.expectedContentRevision < 0 ||
    evidence.baselineVersion !== SYNC_APPLY_FIELDS_VERSION || !validHash(evidence.expectedBaselineFingerprint) ||
    !validHash(evidence.expectedContentFingerprint) || !Number.isFinite(date(receipt.startedAt)) ||
    !Number.isFinite(date(receipt.completedAt)) || date(receipt.completedAt) < date(receipt.startedAt) ||
    date(receipt.completedAt) > +(context.now || new Date()) ||
    date(property.removedFromFeedAt) < date(receipt.startedAt) ||
    date(property.removedFromFeedAt) > date(receipt.completedAt)) return null;
  return entry;
}

// Detection requires proven cause, independently of commercial/content eligibility.
export function reappearedIdentityBlock(property, incoming, context = {}) {
  if (!validId(property._id) || !incoming || incoming.externalId !== property.externalId) return "REAPPEARED_IDENTITY_AMBIGUOUS";
  if (!validId(context.usuarioId) || id(property.usuarioId) !== id(context.usuarioId)) return "REAPPEARED_OWNER_CHANGED";
  if (!validId(context.importSourceId) || id(property.importSourceId) !== id(context.importSourceId) ||
    property.source !== "crm") return "REAPPEARED_SOURCE_CHANGED";
  if (property.visiblePublicamente !== false) return "REAPPEARED_ALREADY_VISIBLE";
  if (!validId(property.hiddenByMissingRunId)) return "REAPPEARED_HIDE_MARKER_MISSING";
  if (!Number.isFinite(date(property.removedFromFeedAt))) return "REAPPEARED_REMOVAL_DATE_MISSING";
  if (tieneOcultacionManualSeparada(property)) return "REAPPEARED_OTHER_HIDING_CAUSE";
  if (!causalEntry(property, context)) return "REAPPEARED_CAUSAL_RUN_INVALID";
  return null;
}

function commercialObservation(user, count, now) {
  if (!user || user.activo === false || !Number.isSafeInteger(count) || count < 0) return null;
  if (!KNOWN_PLAN_IDS.includes(user.plan || "gratis")) return null;
  const availability = getEstadoPublicacionUsuario(user, count);
  if (!availability.planActivoParaPublicar) return null;
  const plan = user.plan || "gratis", deadlines = [];
  if (user.planFechaFin != null) deadlines.push(date(user.planFechaFin));
  if (plan === "vip_trial") {
    if (!user.trialAccepted || !user.planActivo) return null;
    deadlines.push(date(user.trialEndDate));
  }
  if (plan === "lanzamiento_2026") {
    if (!usuarioTienePlanLanzamientoActivo(user, now)) return null;
    deadlines.push(date(getPlanConfig(plan).expiracionFija));
  }
  if (plan === "professional_trial_60d") {
    if (!usuarioTienePromocionProfesionalActiva(user, now)) return null;
    deadlines.push(date(user.professionalPromoEndsAt));
  }
  if (deadlines.some(end => !Number.isFinite(end) || end <= +now)) return null;
  return { plan: availability.plan, count, unlimited: !Number.isFinite(availability.limiteAnuncios),
    limit: Number.isFinite(availability.limiteAnuncios) ? availability.limiteAnuncios : null,
    available: Number.isFinite(availability.cupoDisponible) ? availability.cupoDisponible : null,
    validUntil: deadlines.length ? new Date(Math.min(...deadlines)) : null };
}

export function prepareReappearedEligibility(snapshot, matches, externalId, context = {}) {
  const now = context.now || new Date();
  if (!snapshot.snapshotComplete) return blocked("REAPPEARED_SNAPSHOT_INCOMPLETE");
  if (!matches.length) return blocked("REAPPEARED_PROPERTY_NOT_FOUND");
  if (matches.length !== 1) return blocked("REAPPEARED_IDENTITY_AMBIGUOUS");
  const property = matches[0];
  const incoming = snapshot.properties.filter(e => e.data.externalId === externalId);
  if (property.externalId !== externalId || incoming.length !== 1 || incoming[0].errors.length)
    return blocked("REAPPEARED_IDENTITY_AMBIGUOUS");
  const data = incoming[0].data;
  const identityBlock = reappearedIdentityBlock(property, data, context);
  if (identityBlock) return blocked(identityBlock);
  if (property.syncEnabled !== true) return blocked("REAPPEARED_NOT_ENROLLED");
  if (hasOverrides(property)) return blocked("REAPPEARED_MANUAL_OVERRIDE");
  if (!baselineValid(property)) return blocked("REAPPEARED_BASELINE_INVALID");
  const causal = causalEntry(property, context).missingEvidence;
  if (!Number.isSafeInteger(property.contentRevision) || property.contentRevision < 0 ||
    property.contentRevision !== causal.expectedContentRevision + 1)
    return blocked("REAPPEARED_REVISION_INVALID");
  if (property.syncApplyFingerprint !== causal.expectedBaselineFingerprint ||
    missingContentFingerprint({ ...property, visiblePublicamente: true }) !== causal.expectedContentFingerprint)
    return blocked("REAPPEARED_CONTENT_CHANGED");
  if (!Array.isArray(context.reconciliations)) return blocked("REAPPEARED_RECONCILIATION_UNCHECKED");
  if (context.reconciliations.some(r => id(r.propiedadId) === id(property._id) ||
    (id(r.usuarioId) === id(context.usuarioId) && id(r.importSourceId) === id(context.importSourceId) && r.externalId === externalId)))
    return blocked("REAPPEARED_RECONCILIATION_PENDING");
  if (data.crmWithdrawal || tieneEstadoNoDisponible(property) || tieneEstadoNoDisponible(data))
    return blocked("REAPPEARED_OTHER_HIDING_CAUSE");
  if (managedChangedFields(property, data).length || suppliedNonPhotoDifferences(property, data).length)
    return blocked("REAPPEARED_CONTENT_CHANGED");
  if (property.fechaExpiracion != null && !(date(property.fechaExpiracion) > +now))
    return blocked("REAPPEARED_LISTING_EXPIRED");
  if (id(context.user?._id) !== id(context.usuarioId)) return blocked("REAPPEARED_PLAN_INACTIVE");
  const commercial = commercialObservation(context.user, context.visibleCount, now);
  if (!commercial) return blocked("REAPPEARED_PLAN_INACTIVE");
  if (!commercial.unlimited && commercial.available < 1) return blocked("REAPPEARED_PLAN_LIMIT");
  if (!validHash(context.sourceIdentityHash) || !validHash(context.snapshotDigest) ||
    Object.entries(expectedVersions).some(([key, value]) => context.versions?.[key] !== value))
    return blocked("REAPPEARED_RUN_CHANGED");
  return { restoreEligible: true, restoreBlockCode: null, restoreEvidence: {
    version: REAPPEARED_EVIDENCE_VERSION, propiedadId: property._id, usuarioId: property.usuarioId,
    importSourceId: property.importSourceId, externalId,
    expectedContentRevision: property.contentRevision, expectedVisiblePublicamente: false,
    expectedHiddenByMissingRunId: property.hiddenByMissingRunId, expectedRemovedFromFeedAt: property.removedFromFeedAt,
    expectedBaselineFingerprint: property.syncApplyFingerprint, baselineVersion: property.syncApplyFingerprintVersion,
    expectedManagedFingerprint: managedFingerprint(property), expectedContentFingerprint: missingContentFingerprint(property),
    causalRunId: property.hiddenByMissingRunId, causalRunValidated: true, reconciliationChecked: true, enrolled: true,
    observedPlan: commercial.plan, observedVisibleCount: commercial.count, observedLimit: commercial.limit,
    observedAvailable: commercial.available, observedUnlimited: commercial.unlimited, observedAt: now,
    planValidUntil: commercial.validUntil, listingValidUntil: property.fechaExpiracion ?? null,
    sourceIdentityHash: context.sourceIdentityHash, snapshotDigest: context.snapshotDigest, ...expectedVersions
  } };
}

export function safeReappearedEligibility(entry, run, now, versions) {
  if (!(date(run.expiresAt) > +now)) return blocked("REAPPEARED_RUN_EXPIRED");
  if (run.snapshotComplete !== true) return blocked("REAPPEARED_SNAPSHOT_INCOMPLETE");
  if (run.planTruncated === true || run.totalResults > 100 || run.plan?.length > 100) return blocked("REAPPEARED_RUN_TRUNCATED");
  if (run.status !== "simulated" || run.errorCode || run.blocked === true || run.missingHide ||
    run.reappearedRestore || (run.newImport?.status && run.newImport.status !== "idle") ||
    !validHash(run.sourceIdentityHash) || !validHash(run.snapshotDigest) ||
    Object.entries(versions).some(([key, value]) => run[key] !== value)) return blocked("REAPPEARED_RUN_CHANGED");
  if (entry.restoreEligible !== true) return blocked(REAPPEARED_BLOCK_CODES.has(entry.restoreBlockCode)
    ? entry.restoreBlockCode : "REAPPEARED_RUN_CHANGED");
  const e = entry.restoreEvidence;
  if (!e || entry.type !== "REAPPEARED" || entry.safeReasonCode !== "REAPPEARED_REQUIRES_REVIEW" ||
    entry.blocked !== true || entry.linked !== true ||
    e.version !== REAPPEARED_EVIDENCE_VERSION || !validId(entry.propiedadId) ||
    id(e.propiedadId) !== id(entry.propiedadId) || id(e.usuarioId) !== id(run.usuarioId) ||
    id(e.importSourceId) !== id(run.importSourceId) || !validId(e.usuarioId) || !validId(e.importSourceId) ||
    e.externalId !== entry.externalId || e.expectedVisiblePublicamente !== false || e.enrolled !== true ||
    !validId(e.expectedHiddenByMissingRunId) || id(e.causalRunId) !== id(e.expectedHiddenByMissingRunId) ||
    !Number.isFinite(date(e.expectedRemovedFromFeedAt)) || e.causalRunValidated !== true || e.reconciliationChecked !== true ||
    !Number.isSafeInteger(e.expectedContentRevision) || e.expectedContentRevision < 1 ||
    e.baselineVersion !== SYNC_APPLY_FIELDS_VERSION || !validHash(e.expectedBaselineFingerprint) ||
    e.expectedManagedFingerprint !== e.expectedBaselineFingerprint || !validHash(e.expectedContentFingerprint) ||
    e.sourceIdentityHash !== run.sourceIdentityHash || e.snapshotDigest !== run.snapshotDigest ||
    Object.entries(versions).some(([key, value]) => e[key] !== value) ||
    typeof e.observedPlan !== "string" || !Number.isSafeInteger(e.observedVisibleCount) || e.observedVisibleCount < 0 ||
    !Number.isFinite(date(e.observedAt)) || date(e.observedAt) > +now ||
    typeof e.observedUnlimited !== "boolean" ||
    e.observedUnlimited !== !Number.isFinite(getPlanConfig(e.observedPlan).anuncios) ||
    (!e.observedUnlimited && e.observedLimit !== getPlanConfig(e.observedPlan).anuncios) ||
    (e.observedUnlimited ? e.observedLimit !== null || e.observedAvailable !== null :
      !Number.isSafeInteger(e.observedLimit) || e.observedLimit < 1 || !Number.isSafeInteger(e.observedAvailable) ||
      e.observedAvailable < 1 || e.observedAvailable !== e.observedLimit - e.observedVisibleCount))
    return blocked("REAPPEARED_RUN_CHANGED");
  if (e.planValidUntil !== null && !(date(e.planValidUntil) > +now)) return blocked("REAPPEARED_PLAN_INACTIVE");
  if (e.listingValidUntil !== null && !(date(e.listingValidUntil) > +now)) return blocked("REAPPEARED_LISTING_EXPIRED");
  return { restoreEligible: true, restoreBlockCode: null };
}
