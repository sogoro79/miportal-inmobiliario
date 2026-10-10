(function () {
  function resumen(data) {
    return [["Encontrados", data.snapshotCount], ["Sin cambios", data.unchangedCount],
      ["Cambiarían", data.updateCount], ["Nuevos", data.newCount], ["Faltan del feed", data.missingCount],
      ["Conflictos", data.conflictCount], ["Inválidos", data.errorCount]];
  }

  function renderizar(data, output) {
    output.replaceChildren();
    const summary = document.createElement("p");
    summary.textContent = resumen(data).map(([label, value]) => `${label}: ${value || 0}`).join(" · ");
    output.append(summary);
    if (!data.snapshotComplete) {
      const warning = document.createElement("p");
      warning.textContent = "Snapshot incompleto: no se calculan anuncios que faltan del feed.";
      output.append(warning);
    }
    const list = document.createElement("ul");
    for (const item of (data.results || []).slice(0, 100)) {
      const row = document.createElement("li");
      const fields = Object.entries(item.changes || {}).map(([field, change]) => `${field}${change.blockedByOverride ? " (protegido por edición manual)" : ""}`);
      row.textContent = `${item.externalId || "Sin referencia"}: ${item.type}${fields.length ? " · " + fields.join(", ") : ""}${item.reason ? " · Requiere revisión" : ""}${item.errors?.length ? " · Datos inválidos" : ""}`;
      list.append(row);
    }
    output.append(list);
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
      const data = await api("POST", "simulate", { importSourceId: sourceId });
      renderizar(data, output);
      status.textContent = "Simulación completada. No se ha modificado ningún anuncio.";
    }));
    action(async () => { showSource(await api("GET", "source")); status.textContent = ""; });
  }
  window.HomeClickCrmSync = { iniciar, renderizar, resumen };
})();
