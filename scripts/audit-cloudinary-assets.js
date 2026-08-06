#!/usr/bin/env node
import "dotenv/config";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { v2 as cloudinary } from "cloudinary";
import Propiedad from "../models/Propiedad.js";
import {
  CLOUDINARY_IMAGE_FOLDER,
  getCloudinaryPublicIdFromUrl
} from "../utils/imageSecurity.js";

const EXACT_TRUE = "true";
const DEFAULT_MAX_CLOUDINARY_PAGES = 50;
const MAX_CLOUDINARY_RESULTS = 500;
const REQUIRED_ENV_VARS = [
  "MONGODB_URI",
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET"
];

function envFlagEnabled(value) {
  return value === EXACT_TRUE;
}

function isValidDirectPublicId(value, prefix = CLOUDINARY_IMAGE_FOLDER) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed.startsWith(`${prefix}/`)) return false;
  return trimmed
    .split("/")
    .every(segment => segment && segment !== "." && segment !== ".." && !segment.includes("\\"));
}

function safePublicIdFromText(value, prefix = CLOUDINARY_IMAGE_FOLDER) {
  if (typeof value !== "string" || !value.trim()) {
    return { publicId: null, unresolved: false };
  }

  const trimmed = value.trim();
  if (isValidDirectPublicId(trimmed, prefix)) {
    return { publicId: trimmed, unresolved: false };
  }

  const publicId = getCloudinaryPublicIdFromUrl(trimmed);
  if (publicId && isValidDirectPublicId(publicId, prefix)) {
    return { publicId, unresolved: false };
  }

  return { publicId: null, unresolved: true };
}

export function extractImageReferencesFromProperty(propiedad = {}, {
  prefix = CLOUDINARY_IMAGE_FOLDER
} = {}) {
  const imagenes = Array.isArray(propiedad?.imagenes) ? propiedad.imagenes : [];
  const references = [];
  let unresolved = 0;

  for (const item of imagenes) {
    if (typeof item === "string") {
      const parsed = safePublicIdFromText(item, prefix);
      if (parsed.publicId) {
        references.push({ publicId: parsed.publicId, deducedFromDoubtfulUrl: false });
      } else if (parsed.unresolved) {
        unresolved += 1;
      }
      continue;
    }

    if (!item || typeof item !== "object") {
      continue;
    }

    const directPublicId = [item.publicId, item.public_id, item.filename]
      .find(value => isValidDirectPublicId(value, prefix));
    if (directPublicId) {
      references.push({ publicId: directPublicId.trim(), deducedFromDoubtfulUrl: false });
      continue;
    }

    const urlCandidate = [item.secure_url, item.url, item.path]
      .find(value => typeof value === "string" && value.trim());
    const parsed = safePublicIdFromText(urlCandidate, prefix);
    if (parsed.publicId) {
      references.push({ publicId: parsed.publicId, deducedFromDoubtfulUrl: false });
    } else if (parsed.unresolved) {
      unresolved += 1;
    }
  }

  return { references, unresolved };
}

export function summarizeMongoImageReferences(propiedades = [], {
  prefix = CLOUDINARY_IMAGE_FOLDER
} = {}) {
  const publicIds = new Set();
  const totalsByPublicId = new Map();
  const propertyIndexesByPublicId = new Map();
  let referenciasMongoTotales = 0;
  let urlsMongoSinPublicId = 0;

  propiedades.forEach((propiedad, propertyIndex) => {
    const extracted = extractImageReferencesFromProperty(propiedad, { prefix });
    urlsMongoSinPublicId += extracted.unresolved;

    for (const reference of extracted.references) {
      referenciasMongoTotales += 1;
      publicIds.add(reference.publicId);
      totalsByPublicId.set(reference.publicId, (totalsByPublicId.get(reference.publicId) || 0) + 1);

      if (!propertyIndexesByPublicId.has(reference.publicId)) {
        propertyIndexesByPublicId.set(reference.publicId, new Set());
      }
      propertyIndexesByPublicId.get(reference.publicId).add(propertyIndex);
    }
  });

  const publicIdsDuplicadosEnMongo = [...totalsByPublicId.values()]
    .filter(total => total > 1)
    .reduce((total, count) => total + count - 1, 0);
  const referenciasCompartidasEntrePropiedades = [...propertyIndexesByPublicId.values()]
    .filter(indexes => indexes.size > 1)
    .length;

  return {
    propiedadesAnalizadas: propiedades.length,
    referenciasMongoTotales,
    publicIdsMongoUnicos: publicIds.size,
    urlsMongoSinPublicId,
    publicIdsDuplicadosEnMongo,
    referenciasCompartidasEntrePropiedades,
    publicIds
  };
}

export async function listCloudinaryImageResources({
  listResources,
  prefix = CLOUDINARY_IMAGE_FOLDER,
  maxPages = DEFAULT_MAX_CLOUDINARY_PAGES
} = {}) {
  if (typeof listResources !== "function") {
    return {
      publicIds: new Set(),
      recursosCloudinaryTotales: 0,
      recursosFueraDelAmbito: 0,
      resultadosIncompletos: true
    };
  }

  const publicIds = new Set();
  const seenCursors = new Set();
  let nextCursor;
  let recursosCloudinaryTotales = 0;
  let recursosFueraDelAmbito = 0;
  let resultadosIncompletos = false;

  for (let page = 0; page < maxPages; page += 1) {
    let response;
    try {
      response = await listResources({
        type: "upload",
        resource_type: "image",
        prefix,
        max_results: MAX_CLOUDINARY_RESULTS,
        ...(nextCursor ? { next_cursor: nextCursor } : {})
      });
    } catch {
      resultadosIncompletos = true;
      break;
    }

    if (!response || !Array.isArray(response.resources)) {
      resultadosIncompletos = true;
      break;
    }

    for (const resource of response.resources) {
      const publicId = typeof resource?.public_id === "string" ? resource.public_id.trim() : "";
      if (!publicId) {
        resultadosIncompletos = true;
        continue;
      }

      recursosCloudinaryTotales += 1;
      if (isValidDirectPublicId(publicId, prefix)) {
        publicIds.add(publicId);
      } else {
        recursosFueraDelAmbito += 1;
      }
    }

    const cursor = typeof response.next_cursor === "string" && response.next_cursor
      ? response.next_cursor
      : "";
    if (!cursor) {
      nextCursor = "";
      break;
    }
    if (seenCursors.has(cursor)) {
      resultadosIncompletos = true;
      break;
    }
    seenCursors.add(cursor);
    nextCursor = cursor;
  }

  if (nextCursor && !resultadosIncompletos) {
    resultadosIncompletos = true;
  }

  return {
    publicIds,
    recursosCloudinaryTotales,
    recursosFueraDelAmbito,
    resultadosIncompletos
  };
}

function createSummary({
  mongoSummary,
  cloudinarySummary,
  mongoIncomplete
}) {
  const auditoriaCompleta = !mongoIncomplete && !cloudinarySummary.resultadosIncompletos;
  const recursosReferenciados = auditoriaCompleta
    ? [...cloudinarySummary.publicIds].filter(publicId => mongoSummary.publicIds.has(publicId)).length
    : 0;
  const recursosCloudinaryHuerfanosCandidatos = auditoriaCompleta
    ? [...cloudinarySummary.publicIds].filter(publicId => !mongoSummary.publicIds.has(publicId)).length
    : 0;
  const referenciasMongoSinRecursoCloudinary = auditoriaCompleta
    ? [...mongoSummary.publicIds].filter(publicId => !cloudinarySummary.publicIds.has(publicId)).length
    : 0;
  const resultadosIncompletos = !auditoriaCompleta;
  const requiereRevision = resultadosIncompletos ||
    mongoSummary.urlsMongoSinPublicId > 0 ||
    referenciasMongoSinRecursoCloudinary > 0 ||
    mongoSummary.publicIdsDuplicadosEnMongo > 0 ||
    mongoSummary.referenciasCompartidasEntrePropiedades > 0 ||
    cloudinarySummary.recursosFueraDelAmbito > 0;

  return {
    modo: "solo_lectura",
    propiedadesAnalizadas: mongoSummary.propiedadesAnalizadas,
    referenciasMongoTotales: mongoSummary.referenciasMongoTotales,
    publicIdsMongoUnicos: mongoSummary.publicIdsMongoUnicos,
    urlsMongoSinPublicId: mongoSummary.urlsMongoSinPublicId,
    recursosCloudinaryTotales: cloudinarySummary.recursosCloudinaryTotales,
    recursosReferenciados,
    recursosCloudinaryHuerfanosCandidatos,
    referenciasMongoSinRecursoCloudinary,
    publicIdsDuplicadosEnMongo: mongoSummary.publicIdsDuplicadosEnMongo,
    referenciasCompartidasEntrePropiedades: mongoSummary.referenciasCompartidasEntrePropiedades,
    recursosFueraDelAmbito: cloudinarySummary.recursosFueraDelAmbito,
    resultadosIncompletos,
    auditoriaCompleta,
    requiereRevision,
    aplicariaCambios: false
  };
}

export async function auditCloudinaryAssets({
  PropiedadModel = Propiedad,
  listResources,
  prefix = CLOUDINARY_IMAGE_FOLDER,
  maxPages = DEFAULT_MAX_CLOUDINARY_PAGES
} = {}) {
  let propiedades = [];
  let mongoIncomplete = false;

  try {
    propiedades = await PropiedadModel
      .find({}, { imagenes: 1, _id: 0 })
      .lean();
    if (!Array.isArray(propiedades)) {
      mongoIncomplete = true;
      propiedades = [];
    }
  } catch {
    mongoIncomplete = true;
  }

  const mongoSummary = summarizeMongoImageReferences(propiedades, { prefix });
  const cloudinarySummary = await listCloudinaryImageResources({
    listResources,
    prefix,
    maxPages
  });

  return createSummary({ mongoSummary, cloudinarySummary, mongoIncomplete });
}

export function validateCloudinaryAssetAuditCli({
  env = process.env,
  argv = process.argv
} = {}) {
  if (argv.slice(2).length > 0) {
    return { ok: false, code: "argumentos_no_permitidos" };
  }
  if (!envFlagEnabled(env.AUDIT_CLOUDINARY_ASSETS)) {
    return { ok: false, code: "flag_requerida" };
  }
  for (const name of REQUIRED_ENV_VARS) {
    if (typeof env[name] !== "string" || !env[name].trim()) {
      return { ok: false, code: "configuracion_incompleta" };
    }
  }

  return { ok: true };
}

export async function runCloudinaryAssetAuditCli({
  env = process.env,
  argv = process.argv,
  stdout = console.log,
  stderr = console.error,
  mongooseClient = mongoose,
  PropiedadModel = Propiedad,
  cloudinaryClient = cloudinary
} = {}) {
  const validation = validateCloudinaryAssetAuditCli({ env, argv });
  if (!validation.ok) {
    stderr(JSON.stringify({
      ok: false,
      error: validation.code,
      aplicariaCambios: false
    }));
    return 1;
  }

  cloudinaryClient.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET
  });

  try {
    await mongooseClient.connect(env.MONGODB_URI);
    const summary = await auditCloudinaryAssets({
      PropiedadModel,
      listResources: params => cloudinaryClient.api.resources(params)
    });
    stdout(JSON.stringify(summary, null, 2));
    return 0;
  } catch {
    stderr(JSON.stringify({
      ok: false,
      error: "auditoria_no_completada",
      aplicariaCambios: false
    }));
    return 1;
  } finally {
    await mongooseClient.disconnect().catch(() => {});
  }
}

const isCliExecution = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCliExecution) {
  const code = await runCloudinaryAssetAuditCli();
  process.exitCode = code;
}
