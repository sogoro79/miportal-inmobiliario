function normalizarEstadoComercial(valor = "") {
  return String(valor || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function tieneOcultacionManualSeparada(propiedad = {}) {
  return Boolean(
    propiedad.activo === false ||
    propiedad.eliminada === true ||
    propiedad.oculto === true ||
    propiedad.oculta === true ||
    propiedad.ocultoManual === true ||
    propiedad.ocultaManual === true ||
    propiedad.ocultoPorAdmin === true ||
    propiedad.ocultaPorAdmin === true
  );
}

export function tieneEstadoNoDisponible(propiedad = {}) {
  const estado = normalizarEstadoComercial(propiedad.estadoComercial || "Disponible");
  const estadosNoDisponibles = new Set([
    "vendido",
    "alquilado",
    "reservado",
    "no disponible"
  ]);

  return estadosNoDisponibles.has(estado);
}

export function propiedadDisponiblePublicamente(propiedad = {}, { incluirOcultas = false } = {}) {
  if (!propiedad || tieneOcultacionManualSeparada(propiedad)) return false;
  if (!incluirOcultas && propiedad.visiblePublicamente === false) return false;

  return !tieneEstadoNoDisponible(propiedad);
}

export function filtroEstadoDisponibleMongo() {
  return {
    activo: { $ne: false },
    eliminada: { $ne: true },
    oculto: { $ne: true },
    oculta: { $ne: true },
    ocultoManual: { $ne: true },
    ocultaManual: { $ne: true },
    ocultoPorAdmin: { $ne: true },
    ocultaPorAdmin: { $ne: true },
    estadoComercial: {
      $nin: [
        "Reservado",
        "reservado",
        "Vendido",
        "vendido",
        "Alquilado",
        "alquilado",
        "No disponible",
        "no disponible"
      ]
    }
  };
}
