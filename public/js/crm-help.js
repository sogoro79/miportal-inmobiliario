(() => {
  let authenticated = false;
  try {
    const usuario = JSON.parse(localStorage.getItem("usuario") || "null");
    authenticated = Boolean(usuario?._id && localStorage.getItem("token"));
  } catch {
    // The login link remains usable when browser storage is unavailable.
  }
  if (authenticated) {
    document.querySelectorAll("[data-connect-crm]").forEach(link => {
      link.href = "/perfil#crmImportCard";
    });
  }
})();
