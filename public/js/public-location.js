((root) => {
  const clean = value => typeof value === "string" ? value.trim() : "";
  const key = value => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  function joinLocation(...parts) {
    const seen = new Set();
    return parts.flatMap(part => clean(part).split(",")).map(part => part.trim()).filter(part => {
      const normalized = key(part);
      if (!part || seen.has(normalized)) return false;
      seen.add(normalized); return true;
    }).join(", ");
  }
  const isApproximate = p => p?.precisionUbicacion === "aproximada";
  function buildPublicLocation(p = {}) {
    if (clean(p.ubicacionPublica)) return joinLocation(p.ubicacionPublica);
    // Missing precision on legacy documents retains their existing address display.
    if (!isApproximate(p) && clean(p.direccion)) return clean(p.direccion);
    if (clean(p.zona) && clean(p.localidad)) return joinLocation(p.zona, p.localidad);
    return joinLocation(p.localidad, p.provincia) || "Ubicación no disponible";
  }
  function buildPostalAddress(p = {}) {
    return { "@type": "PostalAddress",
      ...(!isApproximate(p) && clean(p.direccion) ? { streetAddress: clean(p.direccion) } : {}),
      ...(clean(p.localidad) ? { addressLocality: clean(p.localidad) } : {}),
      ...(clean(p.provincia) ? { addressRegion: clean(p.provincia) } : {}),
      ...(clean(p.codigoPostal) ? { postalCode: clean(p.codigoPostal) } : {}),
      addressCountry: clean(p.pais) || "ES" };
  }
  const locationHtml = p => buildPublicLocation(p).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  root.HomeClickLocation = Object.freeze({ buildPublicLocation, joinLocation, isApproximate, buildPostalAddress, locationHtml });
})(typeof window !== "undefined" ? window : globalThis);
