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
    if (!response.ok) throw new Error();
    return response.json();
  }
  async function action(fn) {
    if (busy) return;
    busy = true;
    el("Status").textContent = "Procesando…";
    try { await fn(); }
    catch { el("Status").textContent = "No se pudo confirmar la operación. Consulta el estado antes de volver a intentarlo."; }
    finally { busy = false; }
  }
  async function load() {
    source = await api("source");
    el("Target").textContent = "Estás importando inmuebles para: " + source.nombre;
    el("Source").textContent = [
      source.sourceConfigured ? "InmoWeb · " + source.feedUrlMasked : "Sin fuente InmoWeb activa",
      source.authorized ? "Autorización activa" : "Sin autorización válida",
      "Plan " + source.plan + (source.planActive ? " activo" : " inactivo"),
      "Cupo disponible: " + (source.available ?? "sin límite")
    ].join(" · ");
    el("Consent").textContent = source.grantActive ? "Revocar autorización" : "Registrar autorización expresa";
    el("Consent").disabled = !source.grantActive && (!source.sourceConfigured || !source.active);
    el("Simulate").disabled = !source.authorized;
    el("Status").textContent = "";
  }
  window.abrirCrmDelegado = id => {
    if (busy || dialog.open) return;
    userId = id; source = null;
    el("Target").textContent = ""; el("Source").textContent = "";
    el("Consent").disabled = el("Simulate").disabled = true;
    el("Results").replaceChildren();
    dialog.showModal();
    return action(load);
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
  el("Close").onclick = () => { if (!busy) dialog.close(); };
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
})();
