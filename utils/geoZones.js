import { getSeoZoneAliases, getSeoZoneSlugs } from "./seoZones.js";

function escapeRegex(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function aliasesZona(slug) {
  return getSeoZoneAliases(slug).filter(Boolean);
}

function regexZona(slug) {
  return aliasesZona(slug).map(escapeRegex).join("|");
}

function regexOtrosMunicipios(slug) {
  return getSeoZoneSlugs()
    .filter(zonaSlug => zonaSlug !== slug)
    .flatMap(aliasesZona)
    .map(escapeRegex)
    .join("|");
}

export function buildZonaMunicipalFilter(slug) {
  const zonaRegex = regexZona(slug);
  if (!zonaRegex) return null;

  const structuredMatch = {
    $or: [
      { localidad: { $regex: zonaRegex, $options: "i" } },
      { ciudad: { $regex: zonaRegex, $options: "i" } }
    ]
  };

  const legacyAddressMatch = {
    $and: [
      { $or: [
        { localidad: { $exists: false } },
        { localidad: "" },
        { localidad: null }
      ] },
      { $or: [
        { ciudad: { $exists: false } },
        { ciudad: "" },
        { ciudad: null }
      ] },
      { direccion: { $regex: zonaRegex, $options: "i" } }
    ]
  };

  const otrosMunicipiosRegex = slug === "cadiz" ? regexOtrosMunicipios(slug) : "";
  if (otrosMunicipiosRegex) {
    legacyAddressMatch.$and.push({
      direccion: { $not: { $regex: otrosMunicipiosRegex, $options: "i" } }
    });
  }

  return {
    $or: [
      structuredMatch,
      legacyAddressMatch
    ]
  };
}
