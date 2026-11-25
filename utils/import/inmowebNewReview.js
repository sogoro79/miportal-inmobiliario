import { duplicateCandidates } from "../audit/inmowebDuplicateMatcher.js";

const text = value => String(value ?? "").replace(/<[^>]*>/g, " ")
  .replace(/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+|\S+@\S+|\S*[?&=]\S*/gi, "[omitido]")
  .replace(/\bBearer\s+\S+|\b(?:token|api[_-]?key|password|secret)\s*:\s*\S+/gi, "[omitido]")
  .replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200);
const strings = ["externalId", "referencia", "titulo", "tipoOperacion", "tipoInmueble", "localidad", "provincia"];
const numbers = ["precio", "habitaciones", "banos", "superficie", "superficieParcela"];
const features = ["garaje", "piscina", "terraza"];
const projection = ["usuarioId", "source", "importSourceId", "referencia", "titulo", "descripcion",
  "precio", "localidad", "provincia", "superficie", "superficieParcela", "habitaciones", "banos",
  "imagenes", "tipoInmueble", "tipoOperacion", "piscina", "terraza", "garaje", "ubicacionPublica"].join(" ");

export function parseNewReviewQuery(query = {}) {
  if (!Object.keys(query).length) return undefined;
  if (Object.keys(query).length !== 2 || !["ficha", "duplicates"].includes(query.review) ||
      typeof query.externalId !== "string" || !query.externalId.length || query.externalId.length > 200 ||
      /https?:\/\/|[<>&?=\u0000-\u001f]/i.test(query.externalId)) return null;
  return { review: query.review, externalId: query.externalId };
}

export async function readInmowebNewReviews(run, snapshot, PropiedadModel, request) {
  const entries = run.plan.filter(entry => entry.type === "NEW" && entry.externalId === request?.externalId);
  if (!entries.length) return [];
  // No visibility, source, age or CRM filter: include the whole owner's portfolio.
  const all = request.review === "duplicates"
    ? await PropiedadModel.find({ usuarioId: run.usuarioId }).select(projection).lean() : [];
  const existing = all.filter(p => String(p.usuarioId) === String(run.usuarioId));
  return entries.flatMap(entry => {
    const records = snapshot.properties.filter(record => record.data.externalId === entry.externalId);
    if (records.length !== 1) return [];
    if (!Array.isArray(records[0].reviewAbsent)) return [];
    const record = records[0], incoming = { ...record.data }, fields = {};
    for (const key of [...(record.reviewAbsent || []), ...(record.reviewUnknown || [])]) delete incoming[key];
    if (record.warnings.includes("INMOWEB_TITLE_NORMALIZED")) delete incoming.titulo;
    for (const key of strings) if (typeof incoming[key] === "string" && incoming[key].trim()) fields[key] = text(incoming[key]);
    for (const key of numbers) if (Number.isFinite(incoming[key])) fields[key] = incoming[key];
    for (const key of features) if (typeof incoming[key] === "boolean") fields[key] = incoming[key];
    if (Array.isArray(incoming.imagenes) && !record.warnings.includes("INMOWEB_IMAGE_URL_REJECTED"))
      fields.fotos = incoming.imagenes.length;
    let skipped = 0;
    const candidates = request.review === "duplicates"
      ? duplicateCandidates(incoming, existing, run.importSourceId, () => { skipped++; })
        .map(candidate => ({ ...candidate, reference: text(candidate.reference), title: text(candidate.title) }))
      : undefined;
    // Descriptions/images are used internally by the matcher, never returned.
    return [{ externalId: text(entry.externalId), fields, ...(candidates && { candidates, incomplete: skipped > 0 }) }];
  });
}
