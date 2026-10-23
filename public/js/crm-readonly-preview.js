(() => {
  const escape = value => String(value ?? "—").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function price(p) {
    if (typeof p.precio !== "number" || !Number.isFinite(p.precio)) return "—";
    return `${p.precio.toLocaleString("es-ES", { useGrouping: true })} ${p.moneda || "(moneda desconocida)"}`;
  }
  window.HomeClickCrmReadOnlyPreview = {
    summary(data) {
      return `<strong>${escape(data.total)} inmuebles encontrados · InmoWeb · Solo análisis</strong><p>No se pueden importar ni sincronizar anuncios desde este preview.${data.previewTruncated ? " Se muestra un preview limitado; no representa el catálogo completo." : ""}</p><p>Los bloqueos impedirían importar. Los avisos requieren revisión, pero no bloquean por sí solos. El catálogo completo no está certificado para ocultaciones.</p>`;
    },
    rows(data) {
      return (data.properties || []).map(p => `<tr>
        <td>Solo análisis</td>
        <td>${escape(p.externalId || "Sin ID")}<br>Referencia: ${escape(p.referencia || "—")}</td>
        <td>${escape(p.titulo || "Sin título")}<br>Tipo: ${escape(p.tipoInmueble || "Desconocido")}<br>Condición: ${escape(p.estado || "Desconocida")}<br>Dormitorios: ${escape(p.habitaciones)} · Baños: ${escape(p.banos)}<br>Superficie: ${escape(p.superficie)} m²</td>
        <td>${escape(p.tipoOperacion || "Desconocida")}${p.tipoOperacion === "alquiler" ? "<br>Periodicidad desconocida" : ""}</td>
        <td>${escape(price(p))}</td>
        <td>${escape(p.localidad || "—")}<br>${escape(p.provincia || "—")}<br>CP: ${escape(p.codigoPostal || "—")}</td>
        <td>${escape(p.fotosDisponibles)} disponibles</td>
        <td>${(p.issues || []).map(issue => `<p><strong>${issue.severity === "blocking" ? "Bloqueo" : "Aviso"}:</strong> ${escape(issue.message)}</p>`).join("") || "Listo para revisar"}</td>
      </tr>`).join("");
    }
  };
})();
