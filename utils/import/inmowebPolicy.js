import { MAX_SYNC_PROPERTIES } from "./syncSnapshot.js";

export function inmowebNewEnabled(env = process.env) {
  return env.INMOWEB_NEW_ENABLED === "true";
}

export function assertInmowebNewEnabled(feedType, env = process.env) {
  if (feedType === "inmoweb" && !inmowebNewEnabled(env)) {
    throw Object.assign(new Error("Importación InmoWeb preparada. Activación pendiente."), { code: "INMOWEB_NEW_DISABLED", status: 409 });
  }
}

export function assertInmowebNewSelectionAllowed(feedType, externalIds, env = process.env) {
  assertInmowebNewEnabled(feedType, env);
  if (feedType !== "inmoweb") return;
  const configured = env.INMOWEB_NEW_ALLOWED_EXTERNAL_IDS;
  const allowed = new Set(typeof configured === "string"
    ? configured.split(",").map(id => id.trim()).filter(id => id && !id.includes("*"))
    : []);
  if (!Array.isArray(externalIds) || !externalIds.length ||
      externalIds.some(id => typeof id !== "string" || !allowed.has(id))) {
    throw Object.assign(new Error("La selección no está autorizada para la prueba InmoWeb."), {
      code: "INMOWEB_NEW_EXTERNAL_ID_NOT_ALLOWED", status: 409
    });
  }
}

// This certifies only the received records, never that absent records can be hidden.
export function receivedNewSnapshotValid(snapshot) {
  if (snapshot.feedType !== "inmoweb") return snapshot.snapshotComplete === true;
  return snapshot.snapshotComplete === false && snapshot.structurallyComplete === true &&
    snapshot.normalizationVersion === 1 && snapshot.total > 0 && snapshot.total <= MAX_SYNC_PROPERTIES &&
    snapshot.total === snapshot.properties.length && snapshot.snapshotCount === snapshot.total &&
    snapshot.properties.every(p => p.errors.length === 0 && p.publishableByData === true) &&
    new Set(snapshot.properties.map(p => p.data.externalId)).size === snapshot.total;
}
