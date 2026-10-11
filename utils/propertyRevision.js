export function propertyRevisionError(status = 409) {
  return Object.assign(new Error(status === 400 ? "Revisión de anuncio inválida."
    : "El anuncio ha cambiado. Recarga la ficha antes de guardar."), { code: "PROPERTY_REVISION_CONFLICT", status });
}

export function guardManualPropertyRevision(property, expected) {
  const current = property.contentRevision ?? 0;
  const requested = expected === undefined ? current
    : typeof expected === "string" && /^\d+$/.test(expected) ? Number(expected) : expected;
  if (!Number.isSafeInteger(requested) || requested < 0) throw propertyRevisionError(400);
  if (requested !== current) throw propertyRevisionError();
  const condition = current === 0 ? { $or: [{ contentRevision: 0 }, { contentRevision: { $exists: false } }] }
    : { contentRevision: current };
  // Mongoose merges document.$where into the actual save update filter (not server-side JS).
  property.$where = property.$where ? { $and: [property.$where, condition] } : condition;
}

export function isPropertyRevisionConflict(error) {
  return error?.code === "PROPERTY_REVISION_CONFLICT" || ["DocumentNotFoundError", "VersionError"].includes(error?.name);
}
