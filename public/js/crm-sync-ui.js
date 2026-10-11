(function () {
  function resumen(data) {
    return [["Encontrados", data.snapshotCount], ["Sin cambios", data.unchangedCount],
      ["Cambiarían", data.updateCount], ["Nuevos", data.newCount], ["Faltan del feed", data.missingCount],
      ["Conflictos", data.conflictCount], ["Inválidos", data.errorCount]];
  }

  function newMessage(code) {
    const messages = {
      ALREADY_EXISTS: "Este anuncio ya existe. No se ha creado un duplicado.",
      SYNC_NEW_NOT_NEW: "Alguna referencia ya no es nueva. Vuelve a simular.",
      PLAN_LIMIT: "No hay cupo suficiente en tu plan para importar estos anuncios.",
      SYNC_NEW_PLAN_LIMIT: "No hay cupo suficiente en tu plan para importar estos anuncios.",
      SYNC_NEW_PLAN_REQUIRED: "Necesitas activar un plan para importar estos anuncios.",
      RUN_EXPIRED: "La simulación ha caducado. Vuelve a simular.",
      SOURCE_BUSY: "La fuente CRM está ocupada. Consulta su estado antes de continuar.",
      SYNC_SOURCE_BUSY: "La fuente CRM está ocupada. Consulta su estado antes de continuar.",
      RECONCILIATION_PENDING: "Hay una importación pendiente de comprobación. Consulta su estado antes de continuar.",
      SYNC_NEW_RECONCILIATION_PENDING: "Hay una importación pendiente de comprobación. Consulta su estado antes de continuar.",
      INDETERMINATE: "No se pudo confirmar el resultado de la importación. Consulta o refresca el estado antes de volver a intentarlo.",
      SYNC_NEW_UNCONFIRMED: "No se pudo confirmar el resultado de la importación. Consulta o refresca el estado antes de volver a intentarlo.",
      SYNC_NEW_IN_PROGRESS: "La importación está en curso. Consulta o refresca su estado; no la repitas.",
      SYNC_NEW_ALREADY_ATTEMPTED: "Esta simulación ya tiene una importación iniciada. Consulta su resultado antes de continuar.",
      SYNC_NEW_SELECTION_MISMATCH: "La selección no coincide con la importación iniciada. Consulta el resultado o vuelve a simular.",
      RUN_PLAN_TRUNCATED: "El resultado está truncado. Vuelve a simular con un conjunto más pequeño.",
      RUN_SNAPSHOT_INCOMPLETE: "El feed no está completo. Vuelve a simular antes de importar.",
      SYNC_NEW_FEED_CHANGED: "El feed ha cambiado. Vuelve a simular antes de importar.",
      SYNC_NEW_RUN_CHANGED: "Vuelve a simular para obtener un resultado vigente con elegibilidad de importación.",
      SYNC_NEW_SELECTION_INVALID: "Selecciona entre 1 y 10 referencias NEW elegibles de esta simulación.",
      SYNC_NEW_INVALID_DATA: "Hay datos que no permiten publicar alguno de los anuncios. Revisa el feed y vuelve a simular."
    };
    return messages[code] || "No se pueden importar nuevos anuncios desde este resultado. Revisa el estado, el feed y el cupo de tu plan y vuelve a simular.";
  }

  function importResult(receipt, output) {
    const block = document.createElement("div");
    block.className = "crm-sync-new-result";
    block.setAttribute("role", "status");
    const counts = receipt.counts || {};
    const summary = document.createElement("p");
    summary.textContent = `${counts.imported || 0} ${counts.imported === 1 ? "anuncio importado" : "anuncios importados"} · ${(counts.skipped || 0) + (counts.alreadyExists || 0)} omitidos`;
    block.append(summary);
    if (Number.isSafeInteger(counts.importedImages) && Number.isSafeInteger(counts.skippedImages)) {
      const images = document.createElement("p");
      images.textContent = `${counts.importedImages} imágenes importadas · ${counts.skippedImages} imágenes omitidas`;
      block.append(images);
    }
    const labels = { imported: "Importado", already_exists: "Ya existe; no se ha duplicado", skipped: "Omitido", indeterminate: "Pendiente de confirmación" };
    for (const item of (receipt.results || []).slice(0, 10)) {
      const row = document.createElement("p");
      row.textContent = `${item.externalId}: ${labels[item.status] || "Consulta el estado"}${item.reason === "ALREADY_EXISTS" ? " · Ya existe" : item.reason === "RECONCILIATION_REQUIRED" ? " · Pendiente de comprobación" : ""}`;
      block.append(row);
    }
    if (counts.imported > 0) {
      const link = document.createElement("a");
      link.href = "/perfil.html#listaPropiedades";
      link.textContent = "Ver mis propiedades";
      block.append(link);
    }
    output.append(block);
  }

  function renderizar(data, output, onEnroll, onApply, onImportNew, onConsult) {
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
      eligibility.textContent = data.status === "applied"
        ? "Los cambios seleccionados ya se han aplicado. Para preparar otros cambios, vuelve a simular."
        : data.applyEligible
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
    const newSelected = new Set();
    const newInputs = [];
    const expiredNow = data.expired || !(Date.parse(data.expiresAt) > Date.now());
    const canImportNew = onImportNew && data.newImportEligible === true && data.status === "simulated" &&
      !expiredNow && !data.planTruncated && data.snapshotComplete === true &&
      (!data.newImport?.status || data.newImport.status === "idle");
    const newButton = canImportNew ? document.createElement("button") : null;
    const newNotice = canImportNew ? document.createElement("p") : null;
    for (const item of (data.results || []).slice(0, 100)) {
      const row = document.createElement("li");
      const fields = item.changedFields || Object.entries(item.changes || {}).map(([field, change]) => `${field}${change.blockedByOverride ? " (protegido por edición manual)" : ""}`);
      const state = item.reason === "PROPERTY_SYNC_DISABLED" ? "Requiere vinculación" : item.blocked === true ? "Bloqueado / requiere revisión" : item.linked ? "Vinculado" : item.type;
      row.textContent = `${item.externalId || "Sin referencia"}: ${item.type}${state !== item.type ? " · " + state : ""}${fields.length ? " · " + fields.join(", ") : ""}${item.reason && item.reason !== "PROPERTY_SYNC_DISABLED" ? " · Requiere revisión" : ""}${item.errors?.length ? " · Datos inválidos" : ""}`;
      if (item.type === "NEW") {
        // NEW is blocked for UPDATE by design; only the server's NEW eligibility applies here.
        const eligible = canImportNew && item.importNewEligible === true && !item.errors?.length &&
          (!item.reason || item.reason === "NEW_REQUIRES_MANUAL_IMPORT");
        row.textContent = `${item.externalId || "Sin referencia"}: NEW · ${eligible ? "listo para importar" : data.newImport?.status === "completed" ? "Consulta el resultado de importación" : newMessage(expiredNow ? "RUN_EXPIRED" : data.newImportBlockedReason || item.importNewBlockCode || item.reason)}`;
        if (eligible) {
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.setAttribute("aria-label", `Seleccionar nuevo anuncio ${item.externalId}`);
          newInputs.push(checkbox);
          checkbox.addEventListener("change", () => {
            if (checkbox.disabled) return;
            if (Date.parse(data.expiresAt) <= Date.now()) {
              newNotice.textContent = newMessage("RUN_EXPIRED");
              newButton.disabled = true;
              newInputs.forEach(input => { input.disabled = true; });
              return;
            }
            if (checkbox.checked && newSelected.size >= 10) {
              checkbox.checked = false;
              newNotice.textContent = "Selecciona como máximo 10 nuevos anuncios por lote.";
              return;
            }
            if (checkbox.checked) newSelected.add(item.externalId); else newSelected.delete(item.externalId);
            newNotice.textContent = `${newSelected.size} nuevos seleccionados / 10`;
            newButton.disabled = newSelected.size === 0;
          });
          row.append(checkbox);
        }
      }
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
        return onApply([...selected]);
      });
      selectionNotice.textContent = "Seleccionados: 0 / 10";
      output.append(selectionNotice);
      output.append(applyButton);
    }
    if (newInputs.length) {
      newButton.type = "button";
      newButton.className = "btn-perfil green";
      newButton.textContent = "Importar nuevos";
      newButton.disabled = true;
      let pending = false;
      newButton.addEventListener("click", async () => {
        if (pending || newButton.disabled || newSelected.size === 0) return;
        if (Date.parse(data.expiresAt) <= Date.now()) {
          newNotice.textContent = newMessage("RUN_EXPIRED");
          newButton.disabled = true;
          newInputs.forEach(input => { input.disabled = true; });
          return;
        }
        pending = true;
        newButton.disabled = true;
        newInputs.forEach(input => { input.disabled = true; });
        try { await onImportNew([...newSelected]); }
        finally {
          pending = false;
          newButton.disabled = newSelected.size === 0;
          newInputs.forEach(input => { input.disabled = false; });
        }
      });
      newNotice.textContent = "0 nuevos seleccionados / 10";
      output.append(newNotice);
      output.append(newButton);
    }
    if (data.newImport?.status === "completed") importResult(data.newImport, output);
    else if (["importing", "indeterminate", "failed"].includes(data.newImport?.status)) {
      const notice = document.createElement("p");
      notice.textContent = newMessage(data.newImport.status === "importing" ? "SYNC_NEW_IN_PROGRESS" : data.newImport.status === "indeterminate" ? "INDETERMINATE" : "SYNC_NEW_ALREADY_ATTEMPTED");
      output.append(notice);
      if (data.newImport.results?.length) importResult(data.newImport, output);
    }
    if (onConsult && ["importing", "indeterminate", "failed"].includes(data.newImport?.status)) {
      const consultButton = document.createElement("button");
      consultButton.type = "button";
      consultButton.className = "btn-perfil green";
      consultButton.textContent = "Consultar estado";
      consultButton.addEventListener("click", async () => {
        if (consultButton.disabled) return;
        consultButton.disabled = true;
        try { await onConsult(); }
        finally { consultButton.disabled = false; }
      });
      output.append(consultButton);
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
      let applyClosed = false;
      let newClosed = false;
      const consult = () => action(async () => {
        let state;
        try { state = await api("GET", `runs/${data.runId}`); }
        catch { throw new Error("No se pudo consultar el estado. Mantén esta página abierta y vuelve a pulsar Consultar estado. No se ha repetido la importación."); }
        renderizar(state, output, null, null, null, consult);
        const operation = state.newImport;
        status.textContent = operation?.status === "completed" ? "Importación confirmada. Se muestra el resultado guardado."
          : operation?.status === "importing" ? newMessage("SYNC_NEW_IN_PROGRESS")
          : operation?.status === "indeterminate" ? newMessage("INDETERMINATE")
          : newMessage(operation?.failureCode || state.newImportBlockedReason);
      });
      renderizar(data, output, externalId => action(async () => {
        if (!sourceId) throw new Error("Configura primero tu fuente CRM.");
        const result = await api("POST", "enroll", { importSourceId: sourceId, externalIds: [externalId] });
        // Eligibility is recomputed by the server, not trusted from this preview.
        output.replaceChildren();
        status.textContent = result.alreadyEnrolled ? "El anuncio ya estaba vinculado. No se ha modificado su contenido."
          : "Anuncio vinculado. No se ha modificado su contenido. Vuelve a simular para ver su estado.";
      }), externalIds => {
        if (busy || applyClosed) return;
        if (!confirm(`Se actualizarán ${externalIds.length} anuncios con los cambios mostrados. No se crearán ni eliminarán anuncios y no se modificarán fotos.`)) return;
        return action(async () => {
          let result;
          try {
            result = await api("POST", "apply", { runId: data.runId, externalIds });
          } catch (error) {
            if (error.applyUnconfirmed) {
              applyClosed = true;
              output.replaceChildren();
            }
            throw error;
          }
          applyClosed = true;
          status.textContent = `${result.appliedCount} anuncios actualizados. No se han creado ni eliminado anuncios y no se han modificado fotos.`;
          output.replaceChildren();
          // A refresh failure cannot undo or obscure an acknowledged apply.
          try {
            const state = await api("GET", `runs/${data.runId}`);
            renderizar(state, output);
          } catch {
            const notice = document.createElement("p");
            notice.setAttribute("role", "status");
            notice.textContent = "Los cambios se aplicaron correctamente, pero no se pudo actualizar el estado visual. Recarga la página para comprobar el resultado.";
            output.append(notice);
          }
        });
      }, externalIds => {
        if (busy || newClosed || !externalIds.length) return;
        if (!confirm(`Se crearán ${externalIds.length} anuncios nuevos y consumirán cupo de tu plan.\nLas imágenes se importarán según disponibilidad y límites.\nNo se modificarán anuncios existentes.\n¿Continuar?`)) return;
        return action(async () => {
          let result;
          try { result = await api("POST", "import-new", { runId: data.runId, externalIds }); }
          catch (error) {
            if (error.newUnconfirmed || ["SYNC_NEW_IN_PROGRESS", "SYNC_NEW_RECONCILIATION_PENDING", "RECONCILIATION_PENDING", "RUN_EXPIRED", "SYNC_NEW_ALREADY_ATTEMPTED", "SYNC_NEW_FAILED", "SYNC_NEW_PLAN_LIMIT", "SYNC_NEW_PLAN_REQUIRED"].includes(error.code)) {
              newClosed = true;
              renderizar({ ...data, newImportEligible: false, newImportBlockedReason: error.code,
                newImport: { status: error.code === "SYNC_NEW_IN_PROGRESS" ? "importing" : error.newUnconfirmed ? "indeterminate" : "failed" }
              }, output, null, null, null, consult);
            }
            throw error;
          }
          newClosed = true;
          status.textContent = "Importación completada. Consulta el resultado confirmado de cada referencia.";
          output.replaceChildren();
          importResult(result.newImport, output);
          try {
            const state = await api("GET", `runs/${data.runId}`);
            // Keep the POST receipt even if the refreshed view is stale or incomplete.
            renderizar({ ...state, newImport: result.newImport }, output);
          } catch {
            const notice = document.createElement("p");
            notice.setAttribute("role", "status");
            notice.textContent = "La importación se confirmó correctamente, pero no se pudo actualizar el estado visual. Recarga la página para comprobar el resultado.";
            output.append(notice);
          }
        });
      }, consult);
      status.textContent = "Simulación completada. No se ha modificado ningún anuncio.";
    }
    async function api(method, path, body) {
      const token = getToken();
      if (!token) throw new Error("Inicia sesión de nuevo para continuar.");
      const unconfirmedApply = () => Object.assign(new Error("No se pudo confirmar el resultado de la aplicación. Consulta o refresca el estado de la simulación antes de volver a intentarlo."), { applyUnconfirmed: true });
      const unconfirmedNew = () => Object.assign(new Error(newMessage("INDETERMINATE")), { newUnconfirmed: true, code: "INDETERMINATE" });
      let response;
      try {
        response = await fetch(`/api/crm-import/sync/${path}`, { method,
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}) });
      } catch (error) {
        if (path === "apply") throw unconfirmedApply();
        if (path === "import-new") throw unconfirmedNew();
        throw error;
      }
      const data = await response.json().catch(() => ({})) || {};
      const recognizedNewCodes = new Set([
        "SYNC_NEW_PLAN_LIMIT", "SYNC_NEW_PLAN_REQUIRED", "SYNC_NEW_SELECTION_INVALID", "SYNC_NEW_SELECTION_MISMATCH",
        "SYNC_NEW_SOURCE_CHANGED", "SYNC_NEW_RUN_CHANGED", "SYNC_NEW_FEED_CHANGED", "SYNC_NEW_NOT_NEW",
        "SYNC_NEW_INVALID_DATA", "SYNC_NEW_RECONCILIATION_PENDING", "SYNC_NEW_IN_PROGRESS", "SYNC_NEW_UNCONFIRMED",
        "SYNC_NEW_ALREADY_ATTEMPTED", "SYNC_NEW_FAILED", "SYNC_RUN_NOT_FOUND", "SYNC_SOURCE_NOT_FOUND",
        "SYNC_SOURCE_BUSY", "SYNC_SOURCE_NOT_CONFIGURED", "RUN_EXPIRED", "RUN_PLAN_TRUNCATED",
        "RUN_SNAPSHOT_INCOMPLETE", "RUN_STATUS_NOT_APPLICABLE", "RUN_BLOCKED", "IMPORT_TIMEOUT", "FEED_TIMEOUT"
      ]);
      if (path === "import-new" && [502, 503, 504].includes(response.status) && !recognizedNewCodes.has(data.code)) throw unconfirmedNew();
      if (path === "apply" && (data.code === "SYNC_APPLY_UNCONFIRMED" ||
        response.ok && (data.ok !== true || !Number.isSafeInteger(data.appliedCount) || data.appliedCount < 1 || data.appliedCount > 10))) {
        throw unconfirmedApply();
      }
      if (path === "import-new" && (data.code === "SYNC_NEW_UNCONFIRMED" || data.code === "INDETERMINATE" ||
        response.ok && (data.ok !== true || data.newImport?.status !== "completed" || !data.newImport.counts || !Array.isArray(data.newImport.results)))) throw unconfirmedNew();
      if (!response.ok) throw Object.assign(new Error(response.status === 401 ? "Inicia sesión de nuevo para continuar." : path === "import-new" ? newMessage(data.code) : data.error || "No se pudo completar la operación CRM."), { code: data.code });
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
      try { return await task(); }
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
