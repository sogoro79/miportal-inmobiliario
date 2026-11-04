// Admin session only. Ownership is chosen and verified by the server.
(() => {
  const el = id => document.getElementById("crmDelegated" + id);
  const dialog = el("Dialog");
  let userId, source, busy = false;
  async function api(path, method = "GET", body) {
    const response = await fetch(`/api/crm-import/admin/users/${encodeURIComponent(userId)}/${path}`, {
      method, cache: "no-store", headers: { Authorization: "Bearer " + adminToken, "Content-Type": "application/json" },
      ...(body && { body: JSON.stringify(body) })
    });
    if (!response.ok) {
      const body = await Promise.resolve().then(() => response.json()).catch(() => ({}));
      throw Object.assign(new Error(), { status: response.status, code: body.code });
    }
    return response.json();
  }
  async function action(fn, failureMessage) {
    if (busy) return;
    busy = true;
    el("Status").textContent = "Procesando…";
    try { await fn(); }
    catch (error) {
      const common = { 401: "La sesión ha caducado. Vuelve a entrar en el panel.",
        403: "No tienes autorización para realizar esta acción con este titular.",
        404: "No se encontró el titular o la revisión solicitada." };
      const targetMessages = { CRM_TARGET_NOT_FOUND: "No se encontró el titular.",
        CRM_TARGET_NOT_ALLOWED: "Este titular no está autorizado para la importación delegada.",
        CRM_TARGET_INACTIVE: "El titular está inactivo." };
      el("Status").textContent = targetMessages[error.code] || common[error.status] || failureMessage || "No se pudo confirmar la operación. Consulta el estado antes de volver a intentarlo.";
    }
    finally { busy = false; }
  }
  async function load() {
    source = await api("source");
    resetSetup();
    el("Target").textContent = "Estás importando inmuebles para: " + source.nombre;
    el("Source").textContent = [
      source.active ? "Usuario activo" : "Usuario inactivo",
      source.sourceConfigured ? "InmoWeb · " + source.feedUrlMasked : source.sourceState === "other_or_inactive"
        ? "Ya existe otra fuente CRM o una fuente inactiva." : "Este usuario todavía no tiene una fuente CRM configurada.",
      source.authorized ? "Autorización activa" : source.grantActive ? "Autorización no aplicable" : "Autorización no registrada",
      "Plan " + source.plan + (source.planActive ? " activo" : " inactivo"),
      "Cupo disponible: " + (source.available ?? "sin límite")
    ].join(" · ");
    el("Consent").textContent = source.grantActive ? "Revocar autorización" : "Registrar autorización expresa";
    el("Configure").hidden = !(source.active && source.sourceState === "missing" && !source.grantActive);
    el("Consent").disabled = !source.grantActive && (!source.sourceConfigured || !source.active);
    el("Simulate").disabled = !source.authorized;
    el("Status").textContent = "";
  }
  window.abrirCrmDelegado = id => {
    if (busy || dialog.open) return;
    userId = id; source = null;
    resetSetup(); el("Configure").hidden = true;
    el("Target").textContent = ""; el("Source").textContent = "";
    el("Consent").disabled = el("Simulate").disabled = true;
    el("Results").replaceChildren();
    dialog.showModal();
    return action(load, "No se pudo cargar el estado CRM del titular. Cierra y vuelve a abrir la ventana.");
  };
  function render(run) {
    const output = el("Results"); output.replaceChildren();
    const summary = document.createElement("p");
    summary.textContent = `${run.snapshotCount} encontrados · ${run.newCount} nuevos.`;
    output.append(summary);
    if (run.newImportBlockedReason && !run.newImport) {
      const reason = document.createElement("p");
      const explanations = {
        INMOWEB_NEW_DISABLED: "La importación InmoWeb no está activada.",
        INMOWEB_NEW_EXTERNAL_ID_NOT_ALLOWED: "Ninguna referencia está habilitada para importación.",
        INMOWEB_FRESH_SNAPSHOT_REQUIRED: "La revisión ha caducado o ya no está disponible."
      };
      reason.textContent = explanations[run.newImportBlockedReason] || "Esta revisión no permite importar.";
      output.append(reason);
    }
    const selection = [];
    for (const row of run.results.filter(row => row.type === "NEW")) {
      const label = document.createElement("label");
      label.style.display = "block";
      if (run.newImportEligible && row.importNewEligible && source.planActive && source.available !== 0) {
        const input = document.createElement("input"); input.type = "checkbox"; input.value = row.externalId;
        selection.push(input); label.append(input);
      }
      label.append(document.createTextNode(row.externalId + (row.importNewEligible ? "" : " · No habilitado para importación")));
      output.append(label);
    }
    if (run.newImport) {
      const receipt = document.createElement("p");
      receipt.textContent = "Estado de importación: " + run.newImport.status +
        " · Anuncios importados: " + (run.newImport.counts?.imported ?? 0);
      output.append(receipt);
      const outcomes = { imported: "Importado", skipped: "Omitido", already_exists: "Ya existe", indeterminate: "Pendiente de comprobación" };
      for (const item of run.newImport.results || []) {
        const detail = document.createElement("p");
        detail.textContent = item.externalId + " · " + (outcomes[item.status] || "Consulta el estado");
        output.append(detail);
      }
    }
    const consult = document.createElement("button"); consult.textContent = "Consultar estado";
    consult.onclick = () => action(async () => { render(await api("runs/" + run.runId)); el("Status").textContent = ""; });
    output.append(consult);
    if (!selection.length) return;
    const button = document.createElement("button"); button.textContent = "Importar seleccionados";
    button.onclick = () => action(async () => {
      const ids = selection.filter(input => input.checked).map(input => input.value);
      if (!ids.length || ids.length > 10 || (source.available != null && ids.length > source.available)) {
        el("Status").textContent = "Selecciona entre 1 y 10 anuncios dentro del cupo disponible."; return;
      }
      if (!(Date.parse(run.snapshotExpiresAt) >= Date.now()) || !(Date.parse(run.expiresAt) > Date.now())) {
        button.disabled = true; el("Status").textContent = "La revisión ha caducado. Vuelve a simular."; return;
      }
      if (!confirm(`Estás importando inmuebles para: ${source.nombre}. Los anuncios se crearán directamente en su cuenta. ¿Importar ${ids.length}?`)) {
        el("Status").textContent = ""; return;
      }
      button.disabled = true;
      selection.forEach(input => { input.disabled = true; });
      const result = await api("import-new", "POST", { runId: run.runId, externalIds: ids });
      render({ ...run, newImportEligible: false, newImport: result.newImport });
      el("Status").textContent = "Consulta el resultado de la importación.";
    });
    output.append(button);
  }
  el("Simulate").onclick = () => action(async () => {
    el("Results").replaceChildren();
    render(await api("simulate", "POST", {}));
    el("Status").textContent = "Simulación completada.";
  });
  el("Consent").onclick = () => action(async () => {
    const enabled = !source.grantActive;
    const message = enabled ? `Confirmo que ${source.nombre} ha autorizado expresamente la publicación de sus inmuebles de InmoWeb por HomeClick24.`
      : `¿Revocar la autorización de ${source.nombre}?`;
    if (!confirm(message)) { el("Status").textContent = ""; return; }
    await api("authorization", "PUT", enabled ? { enabled, expressConsentConfirmed: true } : { enabled });
    el("Results").replaceChildren(); await load();
  });
  function resetSetup() {
    el("Url").value = ""; el("Attest").checked = false; el("Setup").hidden = true;
  }
  el("Configure").onclick = () => {
    if (!busy && !el("Configure").hidden) el("Setup").hidden = false;
  };
  el("Save").onclick = () => action(async () => {
    if (!source?.active || source.sourceState !== "missing" || source.grantActive) return;
    const feedUrl = el("Url").value.trim();
    if (!feedUrl || !el("Attest").checked) {
      el("Status").textContent = "Indica la URL y confirma la autorización expresa del titular."; return;
    }
    resetSetup(); el("Configure").hidden = true;
    try {
      await api("source", "POST", { feedType: "inmoweb", feedUrl, expressConsentConfirmed: true });
    } catch (error) {
      // A lost response may follow a successful commit. Only read the state again.
      await load();
      if (source.authorized) {
        el("Status").textContent = "Ya existe una fuente autorizada. Comprueba la fuente mostrada.";
        return;
      }
      if (error.status === 400) { el("Status").textContent = "Revisa la URL pública de InmoWeb y la autorización."; return; }
      throw error;
    }
    await load();
    el("Status").textContent = "Fuente configurada y autorización registrada.";
  }, "No se pudo confirmar la configuración. Revisa el estado del titular y la URL indicada.");
  dialog.addEventListener("close", resetSetup);
  el("Close").onclick = () => { if (!busy) dialog.close(); };
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
})();
