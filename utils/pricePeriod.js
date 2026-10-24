import "../public/js/precios.js";
import { validBedroomNumber } from "./bedrooms.js";

export const PRICE_PERIODS = Object.freeze(["mes", "semana", "dia", "temporada", "desconocida"]);
export const { formatearPrecioPropiedad, periodicidadEfectiva, especificacionPrecio } = globalThis.HomeClickPrices;

export function pricePeriodFilter(period = "mes") {
  return period === "mes" ? { $or: [{ periodicidadPrecio: "mes" }, { periodicidadPrecio: { $exists: false } }] }
    : period === "desconocida" ? { $or: [{ periodicidadPrecio: "desconocida" }, { periodicidadPrecio: { $type: 10 } }] }
    : { periodicidadPrecio: period };
}

export function priceAlertFilter(property) {
  return { activa: true, tipoOperacion: property.tipoOperacion,
    precioMax: { $gte: property.precio },
    $and: [{ $or: [{ habitaciones: { $exists: false } }, { habitaciones: null },
      validBedroomNumber(property.habitaciones) ? { habitaciones: { $lte: property.habitaciones } } : { habitaciones: 0 }] }],
    ...(property.tipoOperacion === "alquiler" ? pricePeriodFilter(periodicidadEfectiva(property)) : {}) };
}

export function applyPricePeriodEdit(property, body) {
  const operation = body.tipoOperacion ?? property.tipoOperacion;
  if (operation === "venta") {
    if (body.periodicidadPrecio !== undefined || property.periodicidadPrecio !== undefined || property.tipoOperacion !== "venta") property.periodicidadPrecio = null;
    return;
  }
  if (body.periodicidadPrecio !== undefined) property.periodicidadPrecio = body.periodicidadPrecio ?? "desconocida";
  else if (body.tipoOperacion === "alquiler" && property.tipoOperacion !== "alquiler") property.periodicidadPrecio = "desconocida";
}
