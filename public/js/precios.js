function periodicidadEfectiva(propiedad = {}) {
  if (propiedad.tipoOperacion !== "alquiler") return null;
  // Only historical persisted records may lack the field. New writes always set it.
  return propiedad.periodicidadPrecio === undefined ? "mes"
    : ["mes", "semana", "dia", "temporada"].includes(propiedad.periodicidadPrecio) ? propiedad.periodicidadPrecio : "desconocida";
}
function formatearPrecioPropiedad(precio, tipoOperacion = "", periodicidadPrecio) {
  if (precio === null || precio === undefined || String(precio).trim() === "") return "Precio a consultar";
  const numero = Number(precio);
  if (!Number.isFinite(numero)) return "Precio a consultar";
  const texto = new Intl.NumberFormat("es-ES", {
    useGrouping: "always",
    maximumFractionDigits: 2
  }).format(numero);
  const periodo = periodicidadEfectiva({ tipoOperacion, periodicidadPrecio });
  const sufijos = new Map([["mes", "/mes"], ["semana", "/semana"], ["dia", "/día"], ["temporada", "/temporada"]]);
  return `${texto} €${sufijos.get(periodo) || ""}`;
}
function especificacionPrecio(propiedad) {
  const periodo = periodicidadEfectiva(propiedad);
  if (!periodo || periodo === "desconocida") return undefined;
  const unidades = new Map([["mes", "month"], ["semana", "week"], ["dia", "day"], ["temporada", "season"]]);
  return { "@type": "UnitPriceSpecification", price: propiedad.precio, priceCurrency: "EUR",
    referenceQuantity: { "@type": "QuantitativeValue", value: 1, unitText: unidades.get(periodo) } };
}
globalThis.HomeClickPrices = { formatearPrecioPropiedad, periodicidadEfectiva, especificacionPrecio };
