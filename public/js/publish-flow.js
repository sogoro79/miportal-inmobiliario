(function () {
  const SELECCION_PREFIX = "hc24_plan_publicacion_seleccionado:";

  function tokenActual() {
    const token = (localStorage.getItem("token") || "").trim();
    return token && token !== "null" && token !== "undefined" ? token : null;
  }

  function usuarioLocal() {
    try {
      return JSON.parse(localStorage.getItem("usuario") || "null");
    } catch {
      return null;
    }
  }

  function seleccionKey(usuario) {
    return usuario?._id ? `${SELECCION_PREFIX}${usuario._id}` : null;
  }

  function tieneSeleccionLocal(usuario) {
    const key = seleccionKey(usuario);
    return Boolean(key && localStorage.getItem(key) === "true");
  }

  function marcarSeleccionLocal(usuario) {
    const key = seleccionKey(usuario || usuarioLocal());
    if (key) localStorage.setItem(key, "true");
  }

  async function fetchJsonSeguro(url, options = {}) {
    const res = await fetch(url, options);
    let data = {};
    try {
      data = await res.json();
    } catch {}
    return { res, data };
  }

  async function cargarUsuarioAutenticado(token) {
    const { res, data } = await fetchJsonSeguro("/usuarios/me", {
      headers: { Authorization: "Bearer " + token }
    });
    if (!res.ok) return usuarioLocal();
    localStorage.setItem("usuario", JSON.stringify(data));
    return data;
  }

  async function cargarEstadoPublicacion(token) {
    const { res, data } = await fetchJsonSeguro("/usuarios/me/publicacion-estado", {
      headers: { Authorization: "Bearer " + token }
    });
    if (!res.ok) return null;
    return data;
  }

  function usuarioTienePlanSeleccionado(usuario, estado) {
    if (!usuario?._id) return false;
    if (tieneSeleccionLocal(usuario)) return true;
    if (Number(estado?.anunciosActuales || 0) > 0) return true;
    const plan = estado?.plan || usuario.plan || "gratis";
    if (plan !== "gratis" && estado?.planActivoParaPublicar === true) return true;
    return false;
  }

  async function resolverDestinoPublicacion() {
    const token = tokenActual();
    if (!token) return "/planes";

    const usuario = await cargarUsuarioAutenticado(token);
    if (!usuario?._id) return "/planes";

    const estado = await cargarEstadoPublicacion(token);
    if (!estado?.puedePublicarAhora) return "/planes";

    return usuarioTienePlanSeleccionado(usuario, estado) ? "/publicar" : "/planes";
  }

  async function navegarPublicacion(event) {
    if (event) event.preventDefault();
    window.location.href = await resolverDestinoPublicacion();
  }

  function marcarSeleccionYPublicar(usuario) {
    marcarSeleccionLocal(usuario);
    window.location.href = "/publicar";
  }

  window.HomeClickPublishFlow = {
    tokenActual,
    usuarioLocal,
    tieneSeleccionLocal,
    marcarSeleccionLocal,
    cargarUsuarioAutenticado,
    cargarEstadoPublicacion,
    resolverDestinoPublicacion,
    navegarPublicacion,
    marcarSeleccionYPublicar
  };
})();
