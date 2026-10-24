export const BEDROOM_STATES = Object.freeze(["informado", "desconocido", "no_aplicable"]);
export const NON_RESIDENTIAL_BEDROOM_TYPES = new Set([
  "local", "local_comercial", "oficina", "nave", "terreno", "solar_urbano", "parcela",
  "garaje", "plaza_aparcamiento", "trastero"
]);
export const RESIDENTIAL_BEDROOM_TYPES = new Set([
  "piso", "apartamento", "atico", "duplex", "estudio", "casa", "chalet", "adosado", "casa_campo", "casa_madera"
]);
export const validBedroomNumber = value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export function bedroomDataValid(property) {
  const { habitaciones: value, habitacionesEstado: state } = property;
  if (state === undefined) return value === undefined || validBedroomNumber(value);
  if (state === "informado") return validBedroomNumber(value);
  if (state === "desconocido") return value === null || value === undefined;
  return state === "no_aplicable" && (value === null || value === undefined) && NON_RESIDENTIAL_BEDROOM_TYPES.has(property.tipoInmueble);
}
export function bedroomCreateData(body) {
  const raw = body.habitaciones;
  const value = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw) : raw;
  return { habitaciones: value === undefined ? null : value,
    habitacionesEstado: body.habitacionesEstado ?? (validBedroomNumber(value) ? "informado" : "desconocido") };
}
export function applyBedroomEdit(property, body) {
  if (body.habitaciones === undefined && body.habitacionesEstado === undefined) return;
  const next = { ...property, tipoInmueble: body.tipoInmueble ?? property.tipoInmueble,
    habitaciones: body.habitaciones !== undefined ? body.habitaciones
      : ["desconocido", "no_aplicable"].includes(body.habitacionesEstado) ? null : property.habitaciones,
    habitacionesEstado: body.habitacionesEstado ?? (body.habitaciones !== undefined
      ? validBedroomNumber(body.habitaciones) ? "informado" : "desconocido" : property.habitacionesEstado) };
  if (!bedroomDataValid(next)) throw Object.assign(new Error("Datos de habitaciones inválidos."), { status: 400, code: "INVALID_BEDROOMS" });
  property.habitaciones = next.habitaciones ?? null;
  // Keep legacy numeric-only edits numeric-only; never materialize state on a partial edit.
  if (property.habitacionesEstado !== undefined || body.habitacionesEstado !== undefined || next.habitaciones == null) {
    property.habitacionesEstado = next.habitacionesEstado;
  }
}
