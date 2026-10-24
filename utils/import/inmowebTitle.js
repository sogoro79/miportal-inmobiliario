const typeLabels = new Map(Object.entries({
  apartamento: "Apartamento", chalet: "Chalet", finca_rustica: "Finca rústica",
  local_comercial: "Local comercial", casa_campo: "Casa de campo", casa: "Casa",
  adosado: "Adosado", duplex: "Dúplex", piso: "Piso"
}));
const operationLabels = new Map([["venta", "en venta"], ["alquiler", "en alquiler"]]);
const locationText = value => typeof value === "string" && !/[<>\u0000-\u001f]|https?:\/\/|@/i.test(value)
  ? value.trim().replace(/\s+/g, " ") : "";
const identity = value => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export function canonicalizeInmowebTitle(property = {}) {
  const original = typeof property.titulo === "string" ? property.titulo : "";
  if (!original.trim() || original.length <= 160) return { titulo: original, normalized: false };
  const type = typeLabels.get(property.tipoInmueble);
  const operation = operationLabels.get(property.tipoOperacion);
  const locality = locationText(property.localidad), province = locationText(property.provincia);
  const zone = locationText(property.zona);
  // A location is required even when only the short type/operation fallback fits.
  if (!type || !operation || !(locality || province)) return { titulo: original, normalized: false };
  const base = `${type} ${operation}`;
  const zonedLocality = zone && locality && identity(zone) !== identity(locality)
    ? `${zone}, ${locality}` : locality;
  const candidates = [...new Set([zonedLocality, locality, province].filter(Boolean))]
    .map(location => `${base} en ${location}`);
  return { titulo: [...candidates, base].find(title => title.length <= 160), normalized: true };
}
