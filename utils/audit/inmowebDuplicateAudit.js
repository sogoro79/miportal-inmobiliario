import { createProviderSnapshots } from "../import/providerSnapshots.js";
import { receivedNewSnapshotValid } from "../import/inmowebPolicy.js";
import { delegatedTargetFilter } from "../import/delegatedTarget.js";
import { duplicateReport } from "./inmowebDuplicateMatcher.js";

// Database dependency exposes only native read operations. No model initialization.
export async function auditInmowebDuplicates(owner, db, { now = Date.now, env = process.env } = {}) {
  const stop = estado => ({ estado, totalNEW: null });
  if (!await db.users.findOne(delegatedTargetFilter(owner), { projection: { _id: 1 } })) return stop("Titular no válido");
  const source = await db.sources.findOne({ usuarioId: owner, activo: true, feedType: "inmoweb" },
    { projection: { usuarioId: 1, feedType: 1, feedUrlHash: 1 } });
  if (!source) return stop("Fuente InmoWeb no disponible");
  const run = await db.runs.findOne({ usuarioId: owner, importSourceId: source._id, feedType: "inmoweb",
    delegationId: { $type: "objectId" }, actorAdminId: { $type: "objectId" } }, { sort: { startedAt: -1, _id: -1 } });
  if (!run) return stop("Sin run delegado");
  const grant = await db.grants.findOne({ _id: run.delegationId, usuarioId: owner, importSourceId: source._id,
    provider: "inmoweb", enabled: true, sourceIdentityHash: source.feedUrlHash }, { projection: { _id: 1 } });
  if (!grant) return stop("Delegación no vigente para esta fuente y run");
  if (+new Date(run.expiresAt) <= now()) return stop("Run caducado");
  if (run.status !== "simulated" || run.blocked || run.errorCode || run.snapshotComplete !== false ||
      !run.newSnapshotComplete || run.planTruncated || !Array.isArray(run.plan) || run.plan.length !== run.totalResults)
    return stop("Run incompleto o no válido");
  if (["importing", "indeterminate"].includes(run.newImport?.status)) return stop("Importación en curso o sin confirmar");
  const stamp = await db.snapshots.findOne({ runId: run._id }, { projection: { expiresAt: 1 } });
  if (!stamp) return stop("Snapshot ausente (puede haber sido eliminada por TTL)");
  if (+new Date(stamp.expiresAt) < now()) return stop("Snapshot caducada");
  const snapshots = createProviderSnapshots({ SnapshotModel: db.snapshots, now, env });
  let evidence;
  try { evidence = await snapshots.readPersisted({ run, source, usuarioId: owner }); }
  catch { return stop("Snapshot no disponible o no verificable"); }
  if (!receivedNewSnapshotValid(evidence.snapshot)) return stop("Snapshot incompleta");
  const news = run.plan.filter(p => p.type === "NEW").map(p => p.externalId);
  const data = new Map(evidence.snapshot.properties.map(p => [p.data.externalId, p.data]));
  if (news.length !== run.newCount || new Set(news).size !== news.length || news.some(id => !data.has(id)))
    return stop("Plan y snapshot inconsistentes");
  const projection = Object.fromEntries(("source importSourceId externalId referencia titulo descripcion precio localidad provincia " +
    "superficie superficieParcela habitaciones banos imagenes tipoInmueble tipoOperacion piscina terraza garaje ubicacionPublica").split(" ").map(k => [k, 1]));
  const properties = await db.properties.find({ usuarioId: owner }, { projection }).toArray();
  const done = new Set((run.newImport?.results || []).filter(r => ["imported", "already_exists"].includes(r.status)).map(r => r.externalId));
  for (const p of properties) if (p.source === "crm" && String(p.importSourceId) === String(source._id)) done.add(p.externalId);
  const pending = news.filter(id => !done.has(id));
  const report = duplicateReport(pending.map(id => data.get(id)), properties);
  if (+new Date(evidence.expiresAt) < now() || +new Date(run.expiresAt) <= now()) return stop("Snapshot o run caducado durante la auditoría");
  return { estado: "Revisión disponible", runId: String(run._id), snapshotHasta: evidence.expiresAt,
    newEnRun: news.length, excluidosYaImportadosOExistentes: news.length - pending.length,
    propiedadesComparadas: properties.length, ...report };
}
