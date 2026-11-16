(() => {
  const labels = { precio: "Precio", titulo: "Título", descripcion: "Descripción", habitaciones: "Dormitorios",
    banos: "Baños", superficie: "Superficie construida", localidad: "Localidad", provincia: "Provincia",
    tipoOperacion: "Operación", tipoInmueble: "Tipo", garaje: "Garaje", piscina: "Piscina", terraza: "Terraza",
    periodicidadPrecio: "Periodicidad del precio", imagenes: "Fotos" };
  const euro = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 2,
    minimumFractionDigits: 0 });
  function format(cell, field) {
    if (cell.kind === "absent") return "Sin campo";
    if (cell.kind === "null") return cell.derived ? "Sin valor (derivado)" : "Sin valor";
    if (cell.kind === "unknown") return cell.derived ? "Desconocido (derivado)" : "Desconocido";
    if (cell.kind === "text") return "Con descripción";
    const v = cell.value;
    const text = typeof v === "boolean" ? (v ? "Sí" : "No") : field === "precio" ? euro.format(v)
      : field === "superficie" ? v + " m²" : String(v).replaceAll("_", " ");
    return cell.kind === "derived" ? text + " (derivado)" : text;
  }
  function append(parent, tag, text) {
    const node = document.createElement(tag);
    node.textContent = text;
    parent.append(node);
    return node;
  }
  window.renderInmowebComparisons = (output, run, reload) => {
    const section = document.createElement("section");
    output.append(section);
    append(section, "h4", "Actualizados · para revisar");
    const rows = document.createElement("div");
    section.append(rows);
    const unavailable = () => { rows.replaceChildren(); append(rows, "p", "Revisión desactualizada o no disponible."); };
    const expires = Math.min(Date.parse(run.snapshotExpiresAt), Date.parse(run.expiresAt));
    if (!Array.isArray(run.comparisons) || !(expires >= Date.now())) unavailable();
    else {
      if (!run.comparisons.length) append(rows, "p", "Sin diferencias verificables en esta revisión.");
      for (const row of run.comparisons) {
        const card = document.createElement("article");
        rows.append(card);
        if (row.stale) { append(card, "p", row.externalId + " · Revisión desactualizada"); continue; }
        append(card, "strong", [row.reference || row.externalId, row.title].filter(Boolean).join(" · "));
        append(card, "p", row.uncertain ? "Cambios detectados · origen sin determinar" : "Cambios detectados");
        const button = append(card, "button", "Ver diferencias");
        button.type = "button";
        const detail = document.createElement("div");
        card.append(detail);
        button.onclick = async () => {
          detail.replaceChildren();
          button.disabled = true;
          try {
            if (!(expires >= Date.now())) return unavailable();
            const current = await reload();
            const fresh = current.comparisons?.find(r => r.externalId === row.externalId);
            if (!current.comparisons || !(expires >= Date.now())) return unavailable();
            if (!fresh || fresh.stale) {
              card.replaceChildren();
              append(card, "p", row.externalId + " · Revisión desactualizada");
              return;
            }
            for (const { field, local, crm } of fresh.changes) {
              let value = "HomeClick24: " + format(local, field) + " · CRM: " + format(crm, field);
              if (field === "descripcion" && local.kind === "text" && crm.kind === "text") value = "Modificada";
              if (field === "imagenes") value = format(local, field) + " publicadas · " + format(crm, field) + " recibidas del CRM";
              append(detail, "p", labels[field] + ": " + value);
            }
          } catch { unavailable(); }
          finally { button.disabled = false; }
        };
      }
      if (run.comparisons.length) setTimeout(unavailable, Math.max(0, expires - Date.now() + 1));
    }
    append(section, "h4", "Desaparecidos");
    append(section, "p", "No evaluable: esta fuente no garantiza el envío del catálogo completo.");
    append(section, "h4", "Reaparecidos");
    append(section, "p", "No accionable en esta revisión.");
  };
})();
