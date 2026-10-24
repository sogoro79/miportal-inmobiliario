import "../public/js/public-location.js";

export const { buildPublicLocation, joinLocation, isApproximate, buildPostalAddress } = globalThis.HomeClickLocation;

export function publicPropertyLocation(property) {
  if (!property) return property;
  const data = typeof property.toObject === "function" ? property.toObject() : { ...property };
  if (!isApproximate(data)) return data;
  return { ...data, ubicacionPublica: buildPublicLocation(data), direccion: "", lat: null, lng: null };
}

export function publicPropertyLocations(data) {
  return Array.isArray(data) ? data.map(publicPropertyLocation) : publicPropertyLocation(data);
}

export function applyLocationEdit(property, body) {
  const previousAddress = property.direccion;
  if (body.direccion !== undefined) property.direccion = body.direccion;
  if (body.ubicacionPublica !== undefined) property.ubicacionPublica = body.ubicacionPublica;
  else if (body.precisionUbicacion === "aproximada" && property.precisionUbicacion !== "aproximada") property.ubicacionPublica = "";
  else if (body.direccion !== undefined && previousAddress !== body.direccion &&
      property.precisionUbicacion !== "aproximada" && property.ubicacionPublica === previousAddress) property.ubicacionPublica = body.direccion;
  if (body.precisionUbicacion !== undefined) property.precisionUbicacion = body.precisionUbicacion;
}
