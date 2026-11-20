// Values returned here are for presentation only. Never use them as an apply payload.
import { baselineValid, hasOverrides } from "./syncBaseline.js";

const fields = ["precio", "titulo", "descripcion", "habitaciones", "banos", "superficie",
  "localidad", "provincia", "tipoOperacion", "tipoInmueble", "garaje", "piscina", "terraza",
  "periodicidadPrecio", "imagenes"];

function shortText(value) {
  return String(value || "").replace(/<[^>]*>/g, "").replace(/(?:https?:\/\/|www\.)\S+|\S+[?&=]\S+|\S+@\S+/gi, "[omitido]")
    .replace(/\bBearer\s+\S+|\b(?:token|api[_-]?key|password|secret)\s*:\s*\S+/gi, "[omitido]")
    .replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 120);
}

function cell(value, field, derived = false) {
  if (value === undefined) return { kind: "absent" };
  if (value === null) return { kind: "null", derived };
  if (value === "" || value === "desconocida") return { kind: "unknown", derived };
  if (field === "descripcion") return { kind: "text" };
  if (field === "imagenes") return Array.isArray(value) ? { kind: "value", value: value.length } : { kind: "unknown" };
  if (typeof value === "string") return { kind: derived ? "derived" : "value", value: shortText(value) };
  if (typeof value === "boolean" || Number.isFinite(value)) return { kind: "value", value };
  return { kind: "unknown" };
}

const normalize = value => typeof value === "string" ? value.trim().replace(/\s+/g, " ") : value;

export function compareInmowebProperty(property, record) {
  const changes = [];
  for (const field of fields) {
    const unknown = record.reviewUnknown?.includes(field);
    if (record.reviewAbsent.includes(field) || (!unknown && !Object.hasOwn(record.data, field))) continue;
    const incoming = record.data[field], local = property[field];
    if (field === "imagenes" && Array.isArray(local) && Array.isArray(incoming) && local.length === incoming.length) continue;
    if (normalize(local) === normalize(incoming)) continue;
    const derived = field === "periodicidadPrecio" || (field === "titulo" && record.warnings.includes("INMOWEB_TITLE_NORMALIZED"));
    changes.push({ field, local: cell(local, field), crm: unknown ? { kind: "unknown" } : cell(incoming, field, derived) });
  }
  return { changes, uncertain: !baselineValid(property) || hasOverrides(property), title: shortText(property.titulo),
    reference: shortText(property.referencia) };
}

export async function readInmowebComparisons(run, snapshot, PropiedadModel) {
  const entries = run.plan.filter(e => e.propiedadId && !["INVALID", "MISSING"].includes(e.type));
  if (!entries.length) return [];
  const comparable = entries.filter(e => Number.isFinite(e.expectedContentRevision));
  const properties = comparable.length ? await PropiedadModel.find({
    usuarioId: run.usuarioId, importSourceId: run.importSourceId,
    source: "crm", externalId: { $in: comparable.map(e => e.externalId) }
  }).lean() : [];
  const rows = [];
  for (const entry of entries) {
    if (!Number.isFinite(entry.expectedContentRevision)) {
      rows.push({ externalId: entry.externalId, unavailable: true });
      continue;
    }
    const records = snapshot.properties.filter(r => r.data.externalId === entry.externalId);
    if (records.length !== 1 || records[0].errors.length) continue;
    if (!Array.isArray(records[0].reviewAbsent)) return undefined;
    const matches = properties.filter(p => p.source === "crm" && String(p.usuarioId) === String(run.usuarioId) &&
      String(p.importSourceId) === String(run.importSourceId) && p.externalId === entry.externalId);
    const p = matches[0];
    if (matches.length !== 1 || String(p._id) !== String(entry.propiedadId) ||
        (p.contentRevision ?? 0) !== entry.expectedContentRevision) {
      rows.push({ externalId: entry.externalId, stale: true });
      continue;
    }
    const diff = compareInmowebProperty(p, records[0]);
    if (diff.changes.length) rows.push({ externalId: entry.externalId, ...diff });
  }
  return rows;
}
