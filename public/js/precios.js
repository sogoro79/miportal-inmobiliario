function formatearPrecioPropiedad(precio, tipoOperacion = "") {
  if (precio === null || precio === undefined || String(precio).trim() === "") return "Precio a consultar";
  const numero = Number(precio);
  if (!Number.isFinite(numero)) return "Precio a consultar";
  const texto = new Intl.NumberFormat("es-ES", {
    useGrouping: "always",
    maximumFractionDigits: 2
  }).format(numero);
  return `${texto} €${tipoOperacion === "alquiler" ? "/mes" : ""}`;
}
