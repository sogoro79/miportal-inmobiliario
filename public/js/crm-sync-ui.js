(function () {
  function resumen(data) {
    return [["Encontrados", data.snapshotCount], ["Sin cambios", data.unchangedCount],
      ["Cambiarían", data.updateCount], ["Nuevos", data.newCount], ["Faltan del feed", data.missingCount],
      ["Conflictos", data.conflictCount], ["Inválidos", data.errorCount]];
  }

  function renderizar(data, output, onEnroll, onApply) {
    output.replaceChildren();
    const summary = document.createElement("p");
    summary.textContent = resumen(data).map(([label, value]) => `${label}: ${value || 0}`).join(" · ");
    output.append(summary);
    if (typeof data.applyEligible === "boolean") {
      const eligibility = document.createElement("p");
      const messages = {
        RUN_EXPIRED: "La simulación ha caducado. Vuelve a simular para preparar un resultado vigente.",
        RUN_PLAN_TRUNCATED: "La simulación contiene más cambios de los que pueden prepararse de forma segura. Vuelve a simular con un conjunto más pequeño.",
        RUN_SNAPSHOT_INCOMPLETE: "La simulación no está completa y no puede prepararse para una futura aplicación.",
        RUN_STATUS_NOT_APPLICABLE: "El estado de esta simulación no permite una futura aplicación. Vuelve a simular.",
        RUN_BLOCKED: "La simulación está bloqueada para una futura aplicación. Revisa el resultado y vuelve a simular."
      };
      eligibility.textContent = data.applyEligible
        ? "Simulación vigente: plan completo preparado para una futura aplicación. Los conflictos individuales siguen bloqueados. No se ha modificado ningún anuncio."
        : messages[data.applyBlockedReason] || messages.RUN_BLOCKED;
      output.append(eligibility);
    }
    if (!data.snapshotComplete) {
      const warning = document.createElement("p");
      warning.textContent = "Snapshot incompleto: no se calculan anuncios que faltan del feed.";
      output.append(warning);
    }
    const list = document.createElement("ul");
    const selected = new Set();
    const canApply = onApply && data.applyEligible === true && data.status === "simulated" && !data.expired;
    const applyButton = canApply ? document.createElement("button") : null;
    const selectionNotice = canApply ? document.createElement("p") : null;
    for (const item of (data.results || []).slice(0, 100)) {
      const row = document.createElement("li");
      const fields = item.changedFields || Object.entries(item.changes || {}).map(([field, change]) => `${field}${change.blockedByOverride ? " (protegido por edición manual)" : ""}`);
      const state = item.reason === "PROPERTY_SYNC_DISABLED" ? "Requiere vinculación" : item.blocked === true ? "Bloqueado / requiere revisión" : item.linked ? "Vinculado" : item.type;
      row.textContent = `${item.externalId || "Sin referencia"}: ${item.type}${state !== item.type ? " · " + state : ""}${fields.length ? " · " + fields.join(", ") : ""}${item.reason && item.reason !== "PROPERTY_SYNC_DISABLED" ? " · Requiere revisión" : ""}${item.errors?.length ? " · Datos inválidos" : ""}`;
      if (canApply && item.type === "UPDATE" && item.blocked === false) {
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.setAttribute("aria-label", `Seleccionar cambios de ${item.externalId}`);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked && selected.size >= 10) {
            checkbox.checked = false;
            selectionNotice.textContent = "Selecciona como máximo 10 anuncios por aplicación.";
            return;
          }
          if (checkbox.checked) selected.add(item.externalId); else selected.delete(item.externalId);
          selectionNotice.textContent = `Seleccionados: ${selected.size} / 10`;
          applyButton.disabled = selected.size === 0;
        });
        row.append(checkbox);
      }
      if (onEnroll && item.enrollmentEligible === true && item.reason === "PROPERTY_SYNC_DISABLED" && data.snapshotComplete) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn-perfil green";
        button.textContent = "Vincular anuncio";
        button.addEventListener("click", () => onEnroll(item.externalId));
        row.append(button);
      }
      list.append(row);
    }
    output.append(list);
    if (canApply && (data.results || []).some(item => item.type === "UPDATE" && item.blocked === false)) {
      applyButton.type = "button";
      applyButton.className = "btn-perfil green";
      applyButton.textContent = "Aplicar cambios";
      applyButton.disabled = true;
      applyButton.addEventListener("click", () => {
        if (Date.parse(data.expiresAt) <= Date.now()) {
          selectionNotice.textContent = "Esta simulación ha caducado. Vuelve a simular.";
          applyButton.disabled = true;
          return;
        }
        onApply([...selected]);
      });
      selectionNotice.textContent = "Seleccionados: 0 / 10";
      output.append(selectionNotice);
      output.append(applyButton);
    }
    if (data.resultsTruncated) {
      const notice = document.createElement("p");
      notice.textContent = `Se muestran hasta 100 detalles de ${data.totalResults}. Los contadores incluyen todos los resultados.`;
      output.append(notice);
    }
  }

  let initialized = false;
  function iniciar(getToken) {
    if (initialized) return;
    initialized = true;
    const input = document.getElementById("crmSyncFeedUrl");
    const save = document.getElementById("crmSyncSave");
    const simulate = document.getElementById("crmSyncSimulate");
    const status = document.getElementById("crmSyncStatus");
    const masked = document.getElementById("crmSyncMasked");
    const output = document.getElementById("crmSyncResults");
    let sourceId;
    let busy = false;
    async function simulation() {
      const data = await api("POST", "simulate", { importSourceId: sourceId });
      renderizar(data, output, externalId => action(async () => {
        if (!sourceId) throw new Error("Configura primero tu fuente CRM.");
        const result = await api("POST", "enroll", { importSourceId: sourceId, externalIds: [externalId] });
        // Eligibility is recomputed by the server, not trusted from this preview.
        output.replaceChildren();
        status.textContent = result.alreadyEnrolled ? "El anuncio ya estaba vinculado. No se ha modificado su contenido."
          : "Anuncio vinculado. No se ha modificado su contenido. Vuelve a simular para ver su estado.";
      }), externalIds => {
        if (!confirm(`Se actualizarán ${externalIds.length} anuncios con los cambios mostrados. No se crearán ni eliminarán anuncios y no se modificarán fotos.`)) return;
        return action(async () => {
          const result = await api("POST", "apply", { runId: data.runId, externalIds });
          output.replaceChildren();
          const state = await api("GET", `runs/${data.runId}`);
          renderizar(state, output);
          status.textContent = `${result.appliedCount} anuncios actualizados. No se han creado ni eliminado anuncios y no se han modificado fotos.`;
        });
      });
      status.textContent = "Simulación completada. No se ha modificado ningún anuncio.";
    }
    async function api(method, path, body) {
      const token = getToken();
      if (!token) throw new Error("Inicia sesión de nuevo para continuar.");
      const response = await fetch(`/api/crm-import/sync/${path}`, { method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(response.status === 401 ? "Inicia sesión de nuevo para continuar." : data.error || "No se pudo completar la operación CRM.");
      return data;
    }
    function showSource(data) {
      sourceId = data.configured ? data.importSourceId : null;
      masked.textContent = data.feedUrlMasked ? `Fuente: ${data.feedUrlMasked}` : "No hay fuente configurada para simular.";
      simulate.disabled = !sourceId || busy;
    }
    async function action(task) {
      if (busy) return;
      busy = true;
      save.disabled = simulate.disabled = input.disabled = true;
      status.textContent = "Procesando...";
      status.classList.remove("error");
      try { await task(); }
      catch (error) { status.classList.add("error"); status.textContent = error.message; }
      finally { busy = false; save.disabled = input.disabled = false; simulate.disabled = !sourceId; }
    }
    save.addEventListener("click", () => action(async () => {
      const feedUrl = input.value.trim();
      if (!feedUrl) throw new Error("Introduce una URL pública de feed XML.");
      const data = await api("PUT", "source", { feedUrl });
      input.value = "";
      output.replaceChildren();
      showSource(data);
      status.textContent = "Fuente configurada. La sincronización automática permanece desactivada.";
    }));
    simulate.addEventListener("click", () => action(async () => {
      if (!sourceId) throw new Error("Configura primero tu fuente CRM.");
      await simulation();
    }));
    action(async () => { showSource(await api("GET", "source")); status.textContent = ""; });
  }
  window.HomeClickCrmSync = { iniciar, renderizar, resumen };
})();
