(function () {
  function resumen(data) {
    return [["Encontrados", data.snapshotCount], ["Sin cambios", data.unchangedCount],
      ["Cambiarían", data.updateCount], ["Nuevos", data.newCount], ["Faltan del feed", data.missingCount],
      ["Han reaparecido", data.reappearedCount], ["Conflictos", data.conflictCount], ["Inválidos", data.errorCount]];
  }

  function newMessage(code) {
    const messages = {
      ALREADY_EXISTS: "Este anuncio ya existe. No se ha creado un duplicado.",
      SYNC_NEW_NOT_NEW: "Alguna referencia ya no es nueva. Vuelve a simular.",
      INMOWEB_NEW_DISABLED: "Importación InmoWeb preparada. Activación pendiente.",
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

  function missingMessage(code) {
    const messages = {
      MISSING_SNAPSHOT_INCOMPLETE: "El feed está incompleto. Vuelve a simular antes de ocultar anuncios.",
      MISSING_RUN_TRUNCATED: "El resultado está truncado. Vuelve a simular con un conjunto más pequeño.",
      MISSING_PROPERTY_NOT_FOUND: "El anuncio ya no existe. Vuelve a simular.",
      MISSING_IDENTITY_AMBIGUOUS: "No se puede identificar este anuncio con seguridad. Requiere revisión.",
      MISSING_OWNER_CHANGED: "El propietario del anuncio ha cambiado. Requiere revisión.",
      MISSING_SOURCE_CHANGED: "La fuente del anuncio ha cambiado. Requiere revisión.",
      MISSING_NOT_ENROLLED: "Necesita volver a vincularse antes de ocultarse.",
      MISSING_BASELINE_INVALID: "La vinculación del anuncio requiere revisión.",
      MISSING_MANUAL_OVERRIDE: "Este anuncio tiene cambios manuales y requiere revisión.",
      MISSING_RECONCILIATION_PENDING: "Hay una importación pendiente de comprobación. Requiere revisión.",
      MISSING_RECONCILIATION_UNCHECKED: "No se pudo comprobar si hay importaciones pendientes. Vuelve a simular.",
      MISSING_ALREADY_HIDDEN: "Este anuncio ya está oculto.",
      MISSING_PREVIOUSLY_HIDDEN: "Este anuncio se ocultó anteriormente. Requiere revisión.",
      MISSING_REVISION_INVALID: "La revisión del anuncio no permite un ocultado seguro.",
      MISSING_RUN_CHANGED: "El resultado ya no permite ocultar anuncios. Vuelve a simular.",
      MISSING_RUN_EXPIRED: "La simulación ha caducado. Vuelve a simular.",
      MISSING_PROPERTY_CHANGED: "El anuncio ha cambiado desde la simulación. Vuelve a simular.",
      MISSING_FEED_CHANGED: "El feed ha cambiado. Vuelve a simular.",
      MISSING_REAPPEARED: "El anuncio vuelve a aparecer en el feed. No se ha ocultado.",
      MISSING_SELECTION_INVALID: "Selecciona entre 1 y 10 anuncios elegibles para ocultar.",
      MISSING_SELECTION_MISMATCH: "Esta simulación ya tiene otra selección registrada. Consulta su estado.",
      MISSING_OPERATION_BLOCKED: "El ocultado requiere revisión. Consulta su estado antes de continuar.",
      MISSING_USER_INACTIVE: "Esta cuenta no puede realizar el ocultado.",
      SYNC_SOURCE_BUSY: "La fuente CRM está ocupada. Consulta el estado antes de continuar.",
      SYNC_RUN_NOT_FOUND: "No se encuentra la simulación. Vuelve a simular.",
      SYNC_SOURCE_NOT_FOUND: "No se encuentra la fuente CRM. Revisa su configuración.",
      SYNC_SOURCE_NOT_CONFIGURED: "La fuente CRM requiere configuración.",
      MISSING_IN_PROGRESS: "No se ha podido confirmar el resultado. El ocultado sigue en curso. Consulta su estado; no repitas la solicitud.",
      MISSING_UNCONFIRMED: "No se ha podido confirmar el resultado. Consulta su estado antes de continuar.",
      IMPORT_TIMEOUT: "No se ha podido confirmar el resultado. Consulta su estado antes de continuar.",
      FEED_TIMEOUT: "No se ha podido confirmar el resultado. Consulta su estado antes de continuar."
    };
    return Object.hasOwn(messages, code) ? messages[code]
      : "No se pudo confirmar el ocultado. Consulta su estado y revisa la simulación antes de continuar.";
  }

  function missingResult(receipt, output) {
    const block = document.createElement("div");
    block.className = "crm-sync-missing-result";
    block.setAttribute("role", "status");
    const title = document.createElement("p");
    title.textContent = "Ocultado completado.";
    block.append(title);
    const summary = document.createElement("p");
    summary.textContent = `${receipt.countHidden} ${receipt.countHidden === 1 ? "anuncio ocultado" : "anuncios ocultados"} · ${receipt.countAlreadyHidden} ya estaban ocultos`;
    block.append(summary);
    for (const item of (receipt.results || []).slice(0, 10)) {
      const row = document.createElement("p");
      row.textContent = `${item.externalId}: ${item.status === "hidden" ? "Ocultado" : item.status === "already_hidden" ? "Ya estaba oculto" : missingMessage(item.code)}`;
      block.append(row);
    }
    const link = document.createElement("a");
    link.href = "/perfil.html#listaPropiedades";
    link.textContent = "Ver mis propiedades";
    block.append(link);
    output.append(block);
  }

  function restoreMessage(code) {
    const messages = {
      REAPPEARED_CONTENT_CHANGED: "El anuncio ha vuelto con cambios. Debes revisar la sincronización antes de publicarlo.",
      REAPPEARED_PLAN_LIMIT: "No tienes espacio disponible en tu plan para volver a publicar este anuncio.",
      REAPPEARED_PLAN_INACTIVE: "Tu plan no permite publicar este anuncio en este momento.",
      REAPPEARED_LISTING_EXPIRED: "Este anuncio está caducado y no puede volver a publicarse.",
      REAPPEARED_NO_LONGER_PRESENT: "El anuncio ya no aparece en el feed CRM.",
      REAPPEARED_REVISION_CHANGED: "El anuncio ha cambiado desde la última simulación. Vuelve a simular.",
      REAPPEARED_RECONCILIATION_PENDING: "Hay una comprobación pendiente de este anuncio. Requiere revisión antes de publicarlo.",
      REAPPEARED_RUN_EXPIRED: "La simulación ha caducado. Vuelve a simular.",
      REAPPEARED_INDETERMINATE: "No se ha podido confirmar todavía el resultado.",
      REAPPEARED_IN_PROGRESS: "No se ha podido confirmar todavía el resultado. La publicación sigue en curso.",
      SYNC_SOURCE_BUSY: "La fuente CRM está ocupada. Consulta su estado antes de continuar."
    };
    return Object.hasOwn(messages, code) ? messages[code]
      : "No se puede volver a publicar este anuncio desde este resultado. Revisa el estado y vuelve a simular.";
  }

  function restoreState(receipt, panel, onConsult) {
    panel.replaceChildren();
    const title = document.createElement("p");
    title.setAttribute("role", "status");
    title.textContent = receipt.status === "completed" ? "Publicación completada."
      : restoreMessage(receipt.status === "failed" ? receipt.errorCode : "REAPPEARED_INDETERMINATE");
    panel.append(title);
    if (receipt.status === "completed") {
      const summary = document.createElement("p");
      summary.textContent = `${receipt.countRestored} ${receipt.countRestored === 1 ? "anuncio publicado" : "anuncios publicados"} · ${receipt.countAlreadyRestored} ya estaban publicados`;
      panel.append(summary);
      for (const item of (receipt.results || []).slice(0, 10)) {
        const row = document.createElement("p");
        row.textContent = `${item.externalId}: ${item.status === "restored" ? "Publicado" : item.status === "already_restored" ? "Ya estaba publicado" : restoreMessage(item.code)}`;
        panel.append(row);
      }
    } else if (onConsult) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn-perfil green";
      button.textContent = "Consultar estado";
      button.addEventListener("click", async () => {
        if (button.disabled) return;
        button.disabled = true;
        try { await onConsult(panel); } finally { button.disabled = false; }
      });
      panel.append(button);
    }
  }

  function validRestoreReceipt(receipt, selection = receipt?.selectedExternalIds) {
    return receipt?.status === "completed" && Array.isArray(selection) && selection.length >= 1 && selection.length <= 10 &&
      new Set(selection).size === selection.length && Array.isArray(receipt.selectedExternalIds) &&
      receipt.selectedExternalIds.length === selection.length && new Set(receipt.selectedExternalIds).size === selection.length &&
      receipt.selectedExternalIds.every(ref => selection.includes(ref)) && Array.isArray(receipt.results) &&
      receipt.results.length === selection.length && receipt.results.every(item => item && typeof item === "object") &&
      new Set(receipt.results.map(item => item.externalId)).size === selection.length &&
      receipt.results.every(item => selection.includes(item.externalId) && ["restored", "already_restored"].includes(item.status)) &&
      receipt.countRestored === receipt.results.filter(item => item.status === "restored").length &&
      receipt.countAlreadyRestored === receipt.results.filter(item => item.status === "already_restored").length;
  }

  function confirmRepublication(count) {
    return new Promise(resolve => {
      const dialog = document.createElement("dialog");
      dialog.className = "crm-sync-restore-confirm";
      dialog.setAttribute("aria-labelledby", "crmRestoreConfirmTitle");
      const title = document.createElement("h2");
      title.id = "crmRestoreConfirmTitle";
      title.textContent = "Volver a publicar";
      const message = document.createElement("p");
      message.textContent = `Se volverán a publicar ${count} anuncios. Volverán a aparecer en los listados públicos y contarán para el límite de tu plan.`;
      const actions = document.createElement("div");
      actions.className = "crm-sync-restore-confirm-actions";
      const cancel = document.createElement("button"), accept = document.createElement("button");
      cancel.type = accept.type = "button";
      cancel.className = "btn-perfil";
      accept.className = "btn-perfil green";
      cancel.textContent = "Cancelar";
      accept.textContent = "Volver a publicar";
      let settled = false;
      function finish(confirmed) {
        if (settled) return;
        settled = true;
        dialog.close(); dialog.remove();
        resolve(confirmed);
      }
      cancel.addEventListener("click", () => finish(false));
      accept.addEventListener("click", () => finish(true));
      dialog.addEventListener("cancel", event => { event.preventDefault(); finish(false); });
      dialog.addEventListener("close", () => finish(false));
      actions.append(cancel); actions.append(accept);
      dialog.append(title); dialog.append(message); dialog.append(actions);
      document.body.append(dialog);
      dialog.showModal(); cancel.focus();
    });
  }

  let missingExpiryTimer, restoreExpiryTimer;
  function renderizar(data, output, onEnroll, onApply, onImportNew, onConsult, onHideMissing, onConsultMissing, onRestore, onConsultRestore) {
    if (missingExpiryTimer !== undefined && typeof clearTimeout === "function") clearTimeout(missingExpiryTimer);
    if (restoreExpiryTimer !== undefined && typeof clearTimeout === "function") clearTimeout(restoreExpiryTimer);
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
    const canApply = onApply && data.applyEligible === true && data.status === "simulated" && !data.expired && !data.reappearedRestore;
    const applyButton = canApply ? document.createElement("button") : null;
    const selectionNotice = canApply ? document.createElement("p") : null;
    const newSelected = new Set();
    const newInputs = [];
    const expiredNow = data.expired || !(Date.parse(data.expiresAt) > Date.now());
    const canImportNew = onImportNew && data.newImportEligible === true && data.status === "simulated" &&
      !expiredNow && !data.planTruncated && data.snapshotComplete === true &&
      (!data.newImport?.status || data.newImport.status === "idle") && !data.reappearedRestore;
    const newButton = canImportNew ? document.createElement("button") : null;
    const newNotice = canImportNew ? document.createElement("p") : null;
    const missingSelected = new Set();
    const missingInputs = [];
    const canHideMissing = onHideMissing && !expiredNow && data.status === "simulated" &&
      data.snapshotComplete === true && !data.planTruncated && !data.resultsTruncated &&
      !data.missingHide && (!data.newImport?.status || data.newImport.status === "idle") &&
      !data.appliedAt && !data.selectedExternalIds?.length && !data.reappearedRestore;
    const missingButton = canHideMissing ? document.createElement("button") : null;
    const missingNotice = canHideMissing ? document.createElement("p") : null;
    const restoreSelected = new Set(), restoreInputs = [], otherInputs = [];
    const canRestore = onRestore && !expiredNow && !data.blocked && !data.errorCode && (data.totalResults ?? data.results?.length ?? 0) <= 100 &&
      data.status === "simulated" && data.snapshotComplete === true &&
      !data.planTruncated && !data.resultsTruncated && !data.reappearedRestore && !data.missingHide &&
      (!data.newImport?.status || data.newImport.status === "idle") && !data.appliedAt && !data.selectedExternalIds?.length;
    const restoreButton = canRestore ? document.createElement("button") : null;
    const restoreNotice = canRestore ? document.createElement("p") : null;
    const restorePanel = document.createElement("div");
    restorePanel.className = "crm-sync-restore-result";
    let restorePending = false, restoreConsumed = false;
    function consumeRestore() {
      restoreConsumed = true;
      if (typeof clearTimeout === "function") clearTimeout(restoreExpiryTimer);
      restoreSelected.clear();
      restoreInputs.forEach(input => { input.checked = false; input.disabled = true; });
      if (restoreButton) restoreButton.disabled = true;
      if (restoreNotice) restoreNotice.textContent = "0 anuncios seleccionados / 10";
    }
    function expireRestore() {
      if (!restorePending) {
        restoreSelected.clear();
        restoreInputs.forEach(input => { input.checked = false; });
      }
      restoreInputs.forEach(input => { input.disabled = true; });
      if (restoreButton) restoreButton.disabled = true;
      if (restoreNotice) restoreNotice.textContent = restoreMessage("REAPPEARED_RUN_EXPIRED");
    }
    function expireMissing() {
      missingSelected.clear();
      missingInputs.forEach(input => { input.checked = false; input.disabled = true; });
      if (missingButton) missingButton.disabled = true;
      if (missingNotice) missingNotice.textContent = missingMessage("MISSING_RUN_EXPIRED");
    }
    for (const item of (data.results || []).slice(0, 100)) {
      const row = document.createElement("li");
      const fields = item.changedFields || Object.entries(item.changes || {}).map(([field, change]) => `${field}${change.blockedByOverride ? " (protegido por edición manual)" : ""}`);
      const state = item.reason === "PROPERTY_SYNC_DISABLED" ? "Requiere vinculación" : item.blocked === true ? "Bloqueado / requiere revisión" : item.linked ? "Vinculado" : item.type;
      row.textContent = `${item.externalId || "Sin referencia"}: ${item.type}${state !== item.type ? " · " + state : ""}${fields.length ? " · " + fields.join(", ") : ""}${item.reason && item.reason !== "PROPERTY_SYNC_DISABLED" ? " · Requiere revisión" : ""}${item.errors?.length ? " · Datos inválidos" : ""}`;
      if (item.type === "REAPPEARED") {
        const eligible = canRestore && item.restoreEligible === true;
        row.textContent = "";
        const label = document.createElement("label");
        label.className = "crm-sync-restore-label";
        const description = document.createElement("span");
        description.textContent = `${item.externalId || "Sin referencia"}: REAPPEARED · Este anuncio ha vuelto a aparecer en tu CRM. ${eligible ? "Listo para volver a publicar" : data.reappearedRestore ? "Consulta el resultado de publicación" : restoreMessage(expiredNow ? "REAPPEARED_RUN_EXPIRED" : item.restoreBlockCode)}`;
        label.append(description);
        if (eligible) {
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.setAttribute("aria-label", `Seleccionar anuncio para volver a publicar ${item.externalId}`);
          restoreInputs.push(checkbox);
          checkbox.addEventListener("change", () => {
            if (checkbox.disabled) return;
            if (!(Date.parse(data.expiresAt) > Date.now())) { expireRestore(); return; }
            if (checkbox.checked && restoreSelected.size >= 10) {
              checkbox.checked = false;
              restoreNotice.textContent = "Selecciona como máximo 10 anuncios para volver a publicar.";
              return;
            }
            if (checkbox.checked) restoreSelected.add(item.externalId); else restoreSelected.delete(item.externalId);
            restoreNotice.textContent = `${restoreSelected.size} anuncios seleccionados / 10`;
            restoreButton.disabled = restoreSelected.size === 0;
          });
          label.append(checkbox);
        }
        row.append(label);
      }
      if (item.type === "MISSING") {
        const eligible = canHideMissing && item.hideMissingEligible === true;
        const message = eligible ? "Listo para ocultar" : data.missingHide?.status === "completed"
          ? "Consulta el resultado de ocultado" : missingMessage(expiredNow ? "MISSING_RUN_EXPIRED" :
            item.hideMissingBlockCode || "MISSING_RUN_CHANGED");
        row.textContent = "";
        const label = document.createElement("label");
        label.className = "crm-sync-missing-label";
        const description = document.createElement("span");
        description.textContent = `${item.externalId || "Sin referencia"}: MISSING · Este anuncio ya no aparece en el feed CRM. ${message}`;
        label.append(description);
        if (eligible) {
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.setAttribute("aria-label", `Seleccionar anuncio para ocultar ${item.externalId}`);
          missingInputs.push(checkbox);
          otherInputs.push(checkbox);
          checkbox.addEventListener("change", () => {
            if (checkbox.disabled) return;
            if (!(Date.parse(data.expiresAt) > Date.now())) { expireMissing(); return; }
            if (checkbox.checked && missingSelected.size >= 10) {
              checkbox.checked = false;
              missingNotice.textContent = "Selecciona como máximo 10 anuncios para ocultar.";
              return;
            }
            if (checkbox.checked) missingSelected.add(item.externalId); else missingSelected.delete(item.externalId);
            missingNotice.textContent = `${missingSelected.size} anuncios seleccionados / 10`;
            missingButton.disabled = missingSelected.size === 0;
          });
          label.append(checkbox);
        }
        row.append(label);
      }
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
          otherInputs.push(checkbox);
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
        otherInputs.push(checkbox);
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
    if (restoreInputs.length) {
      restoreButton.type = "button";
      restoreButton.className = "btn-perfil green";
      restoreButton.textContent = "Volver a publicar";
      restoreButton.disabled = true;
      restoreButton.addEventListener("click", async () => {
        if (restorePending || restoreConsumed || restoreButton.disabled || !restoreSelected.size) return;
        if (!(Date.parse(data.expiresAt) > Date.now())) { expireRestore(); return; }
        restorePending = true;
        restoreButton.disabled = true;
        restoreInputs.forEach(input => { input.disabled = true; });
        const controls = [...otherInputs, applyButton, newButton, missingButton].filter(Boolean);
        const previousDisabled = controls.map(control => control.disabled);
        controls.forEach(control => { control.disabled = true; });
        try { if (await onRestore([...restoreSelected], restorePanel, consumeRestore) === true) consumeRestore(); }
        finally {
          restorePending = false;
          if (!restoreConsumed) controls.forEach((control, index) => { control.disabled = previousDisabled[index]; });
          if (!restoreConsumed && !(Date.parse(data.expiresAt) > Date.now())) expireRestore();
          else {
            restoreButton.disabled = restoreConsumed || !restoreSelected.size;
            restoreInputs.forEach(input => { input.disabled = restoreConsumed; });
          }
          if (!restoreButton.disabled) restoreButton.focus();
        }
      });
      restoreNotice.textContent = "0 anuncios seleccionados / 10";
      restoreNotice.setAttribute("aria-live", "polite");
      output.append(restoreNotice); output.append(restoreButton);
      if (typeof setTimeout === "function") restoreExpiryTimer = setTimeout(expireRestore,
        Math.min(2147483647, Math.max(0, Date.parse(data.expiresAt) - Date.now())));
    }
    if (data.reappearedRestore) restoreState(data.reappearedRestore, restorePanel, onConsultRestore);
    output.append(restorePanel);
    if (missingInputs.length) {
      missingButton.type = "button";
      missingButton.className = "btn-perfil green";
      missingButton.textContent = "Ocultar anuncios";
      missingButton.disabled = true;
      let pending = false, consumed = false;
      missingButton.addEventListener("click", async () => {
        if (pending || consumed || missingButton.disabled || !missingSelected.size) return;
        if (!(Date.parse(data.expiresAt) > Date.now())) { expireMissing(); return; }
        pending = true;
        missingButton.disabled = true;
        missingInputs.forEach(input => { input.disabled = true; });
        try { consumed = await onHideMissing([...missingSelected]) === true; }
        finally {
          pending = false;
          if (consumed) {
            missingSelected.clear();
            missingInputs.forEach(input => { input.checked = false; });
          }
          if (!(Date.parse(data.expiresAt) > Date.now())) expireMissing();
          else {
            missingButton.disabled = consumed || !missingSelected.size;
            missingInputs.forEach(input => { input.disabled = consumed; });
          }
        }
      });
      missingNotice.textContent = "0 anuncios seleccionados / 10";
      missingNotice.setAttribute("aria-live", "polite");
      output.append(missingNotice);
      output.append(missingButton);
      if (typeof setTimeout === "function") missingExpiryTimer = setTimeout(expireMissing,
        Math.min(2147483647, Math.max(0, Date.parse(data.expiresAt) - Date.now())));
    }
    if (data.missingHide?.status === "completed") missingResult(data.missingHide, output);
    else if (data.missingHide) {
      const notice = document.createElement("p");
      notice.setAttribute("role", "status");
      notice.textContent = missingMessage(data.missingHide.status === "failed"
        ? data.missingHide.errorCode : "MISSING_UNCONFIRMED");
      output.append(notice);
      if (onConsultMissing) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn-perfil green";
        button.textContent = "Consultar estado";
        button.addEventListener("click", async () => {
          if (button.disabled) return;
          button.disabled = true;
          try { await onConsultMissing(); } finally { button.disabled = false; }
        });
        output.append(button);
      }
    }
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
      let missingClosed = false;
      let restoreClosed = false;
      let restoreSelection;
      const consultRestore = panel => action(async () => {
        let state;
        try { state = await api("GET", `runs/${data.runId}`); }
        catch { throw new Error("No se pudo consultar el estado de publicación. No repitas la solicitud; vuelve a consultar el estado."); }
        const receipt = state.runId === data.runId && state.reappearedRestore;
        const confirmed = validRestoreReceipt(receipt, restoreSelection);
        const safe = confirmed || receipt?.status === "failed" ? receipt : { status: "indeterminate" };
        restoreState(safe, panel, consultRestore);
        status.textContent = confirmed ? "Publicación completada." : restoreMessage(safe.status === "failed" ? safe.errorCode : "REAPPEARED_INDETERMINATE");
      });
      const consultMissing = () => action(async () => {
        let state;
        try { state = await api("GET", `runs/${data.runId}`); }
        catch {
          throw new Error("No se pudo consultar el estado del ocultado. No repitas la solicitud; vuelve a consultar el estado.");
        }
        renderizar(state.missingHide ? state : { ...state, missingHide: { status: "indeterminate" } },
          output, null, null, null, null, null, consultMissing);
        status.textContent = state.missingHide?.status === "completed" ? "Ocultado completado."
          : missingMessage(state.missingHide?.status === "failed" ? state.missingHide.errorCode : "MISSING_UNCONFIRMED");
      });
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
      }, consult, async externalIds => {
        if (busy || missingClosed || !externalIds.length) return false;
        if (!confirm(`Se ocultarán ${externalIds.length} anuncios que ya no aparecen en el feed CRM.\n\nNo se eliminarán sus datos, fotos, favoritos ni conversaciones.\n\nPodrás seguir viéndolos en Mis propiedades.\n\n¿Continuar?`)) return false;
        if (!(Date.parse(data.expiresAt) > Date.now())) {
          status.textContent = missingMessage("MISSING_RUN_EXPIRED");
          return false;
        }
        await action(async () => {
          missingClosed = true;
          let result;
          try { result = await api("POST", "hide-missing", { runId: data.runId, externalIds }); }
          catch (error) {
            renderizar({ ...data, missingHide: { status: error.missingUnconfirmed ? "indeterminate" : "failed",
              errorCode: error.code } }, output, null, null, null, null, null, consultMissing);
            throw error;
          }
          status.textContent = "Ocultado completado.";
          output.replaceChildren();
          missingResult(result, output);
          try {
            const state = await api("GET", `runs/${data.runId}`);
            renderizar({ ...state, missingHide: result }, output);
          } catch {
            const notice = document.createElement("p");
            notice.setAttribute("role", "status");
            notice.textContent = "Los anuncios se ocultaron correctamente, pero no se pudo actualizar el estado visual. Recarga la página para comprobar el resultado.";
            output.append(notice);
          }
        });
        return true;
      }, consultMissing, async (externalIds, panel, consumeRestore) => {
        if (busy || restoreClosed || !externalIds.length) return false;
        // Reserve the UI while the modal is open; accepting never bypasses expiry.
        busy = true;
        save.disabled = simulate.disabled = input.disabled = true;
        let accepted;
        try { accepted = await confirmRepublication(externalIds.length); }
        finally { busy = false; save.disabled = input.disabled = false; simulate.disabled = !sourceId; }
        if (!accepted) return false;
        if (!(Date.parse(data.expiresAt) > Date.now())) {
          status.textContent = restoreMessage("REAPPEARED_RUN_EXPIRED");
          return false;
        }
        restoreClosed = applyClosed = newClosed = missingClosed = true;
        restoreSelection = [...externalIds];
        await action(async () => {
          let result;
          try { result = await api("POST", "restore-reappeared", { runId: data.runId, externalIds }); }
          catch (error) {
            restoreState({ status: error.restoreUnconfirmed ? "indeterminate" : "failed", errorCode: error.code }, panel, consultRestore);
            throw error;
          }
          status.textContent = "Publicación completada.";
          consumeRestore();
          data.reappearedRestore = result;
          restoreState(result, panel);
          // Preserve this confirmed receipt and the other selections even if refresh fails.
          try { await api("GET", `runs/${data.runId}`); }
          catch {
            const notice = document.createElement("p");
            notice.setAttribute("role", "status");
            notice.textContent = "Los anuncios se publicaron correctamente, pero no se pudo actualizar el estado visual. Recarga la página para comprobar el resultado.";
            panel.append(notice);
          }
        });
        return true;
      }, consultRestore);
      status.textContent = "Simulación completada. No se ha modificado ningún anuncio.";
    }
    async function api(method, path, body) {
      const token = getToken();
      if (!token) throw new Error("Inicia sesión de nuevo para continuar.");
      const unconfirmedApply = () => Object.assign(new Error("No se pudo confirmar el resultado de la aplicación. Consulta o refresca el estado de la simulación antes de volver a intentarlo."), { applyUnconfirmed: true });
      const unconfirmedNew = () => Object.assign(new Error(newMessage("INDETERMINATE")), { newUnconfirmed: true, code: "INDETERMINATE" });
      const unconfirmedMissing = () => Object.assign(new Error(missingMessage("MISSING_UNCONFIRMED")),
        { missingUnconfirmed: true, code: "MISSING_UNCONFIRMED" });
      const unconfirmedRestore = () => Object.assign(new Error(restoreMessage("REAPPEARED_INDETERMINATE")),
        { restoreUnconfirmed: true, code: "REAPPEARED_INDETERMINATE" });
      let response;
      try {
        response = await fetch(`/api/crm-import/sync/${path}`, { method,
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}) });
      } catch (error) {
        if (path === "apply") throw unconfirmedApply();
        if (path === "import-new") throw unconfirmedNew();
        if (path === "hide-missing") throw unconfirmedMissing();
        if (path === "restore-reappeared") throw unconfirmedRestore();
        throw error;
      }
      const data = await response.json().catch(() => ({})) || {};
      if (path === "restore-reappeared") {
        if ([502, 503, 504].includes(response.status) ||
          ["REAPPEARED_INDETERMINATE", "REAPPEARED_IN_PROGRESS"].includes(data.code) ||
          ["preparing", "applying", "indeterminate"].includes(data.status)) throw unconfirmedRestore();
        if (response.ok) {
          if (data.runId !== body.runId || !validRestoreReceipt(data, body.externalIds)) throw unconfirmedRestore();
        } else throw Object.assign(new Error(response.status === 401 ? "Inicia sesión de nuevo para continuar." : restoreMessage(data.code)), { code: data.code });
      }
      if (path === "hide-missing") {
        if ([502, 503, 504].includes(response.status) ||
          ["MISSING_UNCONFIRMED", "MISSING_IN_PROGRESS"].includes(data.code) ||
          ["preparing", "applying", "indeterminate"].includes(data.status)) throw unconfirmedMissing();
        if (response.ok) {
          const results = data.results;
          const selection = body.externalIds;
          if (data.status !== "completed" || data.runId !== body.runId ||
            !Array.isArray(data.selectedExternalIds) || data.selectedExternalIds.length !== selection.length ||
            new Set(data.selectedExternalIds).size !== selection.length ||
            !data.selectedExternalIds.every(ref => selection.includes(ref)) ||
            !Array.isArray(results) || results.length !== selection.length ||
            results.some(item => !item || typeof item !== "object") ||
            new Set(results.map(item => item.externalId)).size !== selection.length ||
            results.some(item => !selection.includes(item.externalId) || !["hidden", "already_hidden"].includes(item.status)) ||
            data.countHidden !== results.filter(item => item.status === "hidden").length ||
            data.countAlreadyHidden !== results.filter(item => item.status === "already_hidden").length) throw unconfirmedMissing();
        } else {
          throw Object.assign(new Error(response.status === 401 ? "Inicia sesión de nuevo para continuar." :
            missingMessage(data.code)), { code: data.code });
        }
      }
      const recognizedNewCodes = new Set([
        "INMOWEB_NEW_DISABLED", "SYNC_NEW_PLAN_LIMIT", "SYNC_NEW_PLAN_REQUIRED", "SYNC_NEW_SELECTION_INVALID", "SYNC_NEW_SELECTION_MISMATCH",
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
      if (data.feedType === "inmoweb") {
        const selector = document.getElementById("crmFeedType");
        if (selector) selector.value = "inmoweb";
      }
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
      const feedType = document.getElementById("crmFeedType")?.value;
      if (feedType === "auto") throw new Error("Selecciona XML genérico o InmoWeb para configurar la fuente.");
      const data = await api("PUT", "source", { feedUrl, ...(feedType === "inmoweb" ? { feedType } : {}) });
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
