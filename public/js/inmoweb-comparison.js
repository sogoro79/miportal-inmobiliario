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
  window.renderInmowebNewReview = (output, run, externalId, reload) => {
    const box = document.createElement("div");
    output.append(box);
    const detail = document.createElement("div");
    detail.setAttribute("aria-live", "polite");
    const unavailable = () => {
      detail.replaceChildren();
      append(detail, "p", "Revisión no disponible. Vuelve a simular.");
    };
    const expires = Math.min(Date.parse(run.snapshotExpiresAt), Date.parse(run.expiresAt));
    const buttons = [];
    for (const [caption, candidates] of [["Ver ficha", false], ["Revisar posibles duplicados", true]]) {
      const button = append(box, "button", caption);
      button.type = "button";
      buttons.push(button);
      button.onclick = async () => {
        detail.replaceChildren();
        buttons.forEach(b => { b.disabled = true; });
        try {
          if (!(Date.now() < expires) || typeof reload !== "function") return unavailable();
          const current = await reload();
          const fresh = current?.newReviews?.find(row => row.externalId === externalId);
          const currentExpiry = Math.min(Date.parse(current?.snapshotExpiresAt), Date.parse(current?.expiresAt));
          if (current?.runId !== run.runId || !fresh || !(Date.now() < Math.min(expires, currentExpiry))) return unavailable();
          if (!candidates) {
            const names = { ...labels, externalId: "ExternalId", referencia: "Referencia",
              superficieParcela: "Parcela", fotos: "Número de fotos" };
            for (const [field, value] of Object.entries(fresh.fields)) {
              if (!Object.hasOwn(names, field)) continue;
              append(detail, "p", names[field] + ": " + format({ kind: "value", value }, field));
            }
          } else {
            append(detail, "h5", "Posibles coincidencias");
            append(detail, "p", "Ayuda para revisión humana. El score no es una probabilidad ni una autorización para importar.");
            if (!fresh.candidates.length) append(detail, "p", "No se han encontrado coincidencias fuertes en la cartera actual.");
            for (const candidate of fresh.candidates) {
              append(detail, "strong", [candidate.reference, candidate.title].filter(Boolean).join(" · "));
              append(detail, "p", "Score interno: " + candidate.score);
              append(detail, "p", "Coincidencias: " + candidate.evidence.join("; "));
              append(detail, "p", "Contradicciones: " + (candidate.contradictions.join("; ") || "Ninguna detectada en los datos comparables."));
            }
          }
        } catch { unavailable(); }
        finally { buttons.forEach(b => { b.disabled = false; }); }
      };
    }
    box.append(detail);
    if (Date.now() < expires) setTimeout(unavailable, Math.max(0, expires - Date.now() + 1));
  };
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
        if (row.unavailable) { append(card, "p", row.externalId + " · Revisión no disponible para este anuncio"); continue; }
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
            if (!fresh || fresh.stale || fresh.unavailable) {
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
