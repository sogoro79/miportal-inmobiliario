document.addEventListener("DOMContentLoaded", () => {
  const cont = document.getElementById("main-header");
  if (!cont) return;

  async function asegurarPublishFlow() {
    if (window.HomeClickPublishFlow) return window.HomeClickPublishFlow;
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "/js/publish-flow.js";
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    }).catch(() => {});
    return window.HomeClickPublishFlow || null;
  }

  const publishFlowPromise = asegurarPublishFlow();

  // Canonical URL - evitar contenido duplicado sin pisar canonicals definidos en cada página.
  if (!document.querySelector('link[rel="canonical"]')) {
    const canonical = document.createElement('link');
    canonical.rel = 'canonical';
    canonical.href = 'https://www.homeclick24.com' + window.location.pathname + (window.location.pathname === '/propiedad' ? window.location.search : '');
    document.head.appendChild(canonical);
  }

  const raw = localStorage.getItem("usuario");
  const token = localStorage.getItem("token");
  let usuario = null;

  try {
    usuario = raw ? JSON.parse(raw) : null;
  } catch {
    usuario = null;
  }

  const nombreUsuarioInicial = typeof usuario?.nombre === "string" && usuario.nombre.trim()
    ? usuario.nombre.trim()
    : "...";

  function obtenerNombreUsuario(usuarioActual) {
    return typeof usuarioActual?.nombre === "string" && usuarioActual.nombre.trim()
      ? usuarioActual.nombre.trim()
      : "";
  }

  function normalizarUsuarioActual(data) {
    if (data?.usuario && typeof data.usuario === "object") return data.usuario;
    if (data?.user && typeof data.user === "object") return data.user;
    return data && typeof data === "object" ? data : null;
  }

  function guardarUsuarioActualizado(usuarioActualizado) {
    const usuarioFusionado = { ...(usuario || {}), ...usuarioActualizado };
    localStorage.setItem("usuario", JSON.stringify(usuarioFusionado));
    usuario = usuarioFusionado;
    return usuarioFusionado;
  }

  function pintarNombreUsuario(usuarioActual) {
    const userToggle = document.getElementById("userToggle");
    if (!userToggle) return;
    userToggle.textContent = obtenerNombreUsuario(usuarioActual) || "...";
  }

  async function refrescarUsuarioCabecera() {
    if (!token) return;

    try {
      const res = await fetch("/usuarios/me", {
        headers: { "Authorization": "Bearer " + token }
      });

      if (res.status === 401 || res.status === 403) {
        localStorage.removeItem("usuario");
        localStorage.removeItem("token");
        return;
      }

      if (!res.ok) return;

      const data = await res.json();
      const usuarioActualizado = normalizarUsuarioActual(data);
      if (!usuarioActualizado) return;

      const usuarioFusionado = guardarUsuarioActualizado(usuarioActualizado);
      pintarNombreUsuario(usuarioFusionado);
    } catch (e) {
      console.warn("No se pudo refrescar el usuario en cabecera:", e.message);
    }
  }

  const langOptions = `
    <a href="#" onclick="selectLang('🇪🇸','España')">🇪🇸 España</a>
    <a href="#" onclick="selectLang('🏴󠁧󠁢󠁣󠁴󠁿','Català')">🏴󠁧󠁢󠁣󠁴󠁿 Català</a>
    <a href="#" onclick="selectLang('🇬🇧','English')">🇬🇧 English</a>
    <a href="#" onclick="selectLang('🇩🇪','Deutsch')">🇩🇪 Deutsch</a>
    <a href="#" onclick="selectLang('🇫🇷','Français')">🇫🇷 Français</a>
    <a href="#" onclick="selectLang('🇮🇹','Italiano')">🇮🇹 Italiano</a>
    <a href="#" onclick="selectLang('🇵🇹','Português')">🇵🇹 Português</a>
    <a href="#" onclick="selectLang('🇩🇰','Dansk')">🇩🇰 Dansk</a>
    <a href="#" onclick="selectLang('🇺🇦','Українська')">🇺🇦 Українська</a>
    <a href="#" onclick="selectLang('🇫🇮','Suomi')">🇫🇮 Suomi</a>
    <a href="#" onclick="selectLang('🇳🇴','Norsk')">🇳🇴 Norsk</a>
    <a href="#" onclick="selectLang('🇳🇱','Nederlands')">🇳🇱 Nederlands</a>
    <a href="#" onclick="selectLang('🇵🇱','Polski')">🇵🇱 Polski</a>
    <a href="#" onclick="selectLang('🇷🇴','Română')">🇷🇴 Română</a>
  `;

  // Topbar — solo visible en móvil
  const topbar = `
  <div class="header-topbar">
    <div class="header-topbar-inner">
      <div class="header-logo" onclick="location.href='/index.html'" style="cursor:pointer;display:flex;align-items:center;gap:8px;">
        <img src="/HomeClick.png" alt="" style="height:32px;width:auto;">
        <span style="font-size:1.1rem;font-weight:800;color:#fff;">Home<span style="color:#7cc242;">Click24</span></span>
      </div>
      <div style="display:flex;align-items:center;gap:10px;">
        <button class="topbar-lang-btn" onclick="toggleLangMenuMobile(event)" style="font-size:0.9rem;">🇪🇸 España ▾</button>
        <div class="topbar-lang-menu" id="topbarLangMenuMobile">
          ${langOptions}
        </div>
      </div>
    </div>
  </div>
`;

  // Selector — solo visible en escritorio
  const langSelector = `
    <div class="topbar-lang header-lang-desktop" id="topbarLangDesktop">
      <button class="topbar-lang-btn" onclick="toggleLangMenuDesktop(event)">🇪🇸 ▾</button>
      <div class="topbar-lang-menu" id="topbarLangMenuDesktop">
        ${langOptions}
      </div>
    </div>
  `;

  /* ======================
     HEADER SIN SESIÓN
  ====================== */
  if (!usuario || !usuario._id) {
    cont.innerHTML = `
      <header class="header">
        ${topbar}
        <div class="header-container">
          <div class="header-logo" onclick="location.href='/index.html'">
            <img src="/HomeClick.png" alt="" class="logo-icon" />
            <span class="logo-text">Home<span class="logo-green">Click24</span></span>
          </div>
          <div class="header-actions">
            <a href="/comprar" class="btn-outline">Comprar</a>
            <a href="/alquiler" class="btn-outline">Alquilar</a>
            <a href="/planes" class="btn-publish">Pon tu anuncio</a>
            ${langSelector}
            <a href="/login" class="btn-primary">👤 Acceder</a>
          </div>
        </div>
      </header>
    `;
    iniciarScroll();
    return;
  }

  /* ======================
     HEADER CON SESIÓN
  ====================== */
  const publicarHref = "/planes";
  const publicarTexto = "+ Publicar anuncio";

  cont.innerHTML = `
    <header class="header">
      ${topbar}
      <div class="header-container">
        <div class="header-logo" onclick="location.href='/index.html'">
          <img src="/HomeClick.png" alt="" class="logo-icon" />
          <span class="logo-text">Home<span class="logo-green">Click24</span></span>
        </div>
        <div class="header-actions">
          <a href="/comprar" class="btn-outline">Comprar</a>
          <a href="/alquiler" class="btn-outline">Alquilar</a>
          <a href="${publicarHref}" class="btn-publish" id="btnHeaderPublicar">${publicarTexto}</a>
          <a href="/favoritos" class="btn-icon" title="Favoritos">❤️</a>
          <a href="/perfil#chats" class="btn-icon" title="Chats" style="position:relative;">
            💬
            <span id="chatBadge" style="
              display:none;
              position:absolute;
              top:-6px;
              right:-6px;
              background:#f87171;
              color:#fff;
              border-radius:50%;
              width:18px;
              height:18px;
              font-size:0.7rem;
              font-weight:700;
              align-items:center;
              justify-content:center;
            ">0</span>
          </a>
          <div class="notif-menu" id="notifMenu">
            <button class="btn-icon" onclick="toggleNotifMenu(event)" style="position:relative;">
              🔔
              <span id="notifBadge" style="
                display:none;
                position:absolute;
                top:-6px;
                right:-6px;
                background:#f87171;
                color:#fff;
                border-radius:50%;
                width:18px;
                height:18px;
                font-size:0.7rem;
                font-weight:700;
                align-items:center;
                justify-content:center;
              ">0</span>
            </button>
            <div class="notif-dropdown" id="notifDropdown" style="
              display:none;
              position:absolute;
              right:0;
              top:130%;
              background:#fff;
              min-width:300px;
              border-radius:12px;
              box-shadow:0 6px 24px rgba(0,0,0,0.15);
              overflow:hidden;
              z-index:9999;
            ">
              <div style="padding:14px 16px;border-bottom:1px solid #f0f0f0;font-weight:700;font-size:0.9rem;color:#222;">
                🔔 Notificaciones
              </div>
              <div id="notifLista" style="max-height:320px;overflow-y:auto;"></div>
            </div>
          </div>
          ${langSelector}
          <div class="user-menu" id="userMenu">
            <div class="user-name" id="userToggle"></div>
            <div class="dropdown" id="userDropdown">
              <a href="/perfil">Mi perfil</a>
              <a href="/favoritos">Favoritos</a>
              <a href="/perfil#chats">Conversaciones</a>
              <a href="/docs/guia-publicacion-homeclick24.pdf" target="_blank" rel="noopener">Ayuda para publicar</a>
              <a href="#" id="logoutBtn" class="logout">Cerrar sesión</a>
            </div>
          </div>
        </div>
      </div>
    </header>
  `;

  iniciarScroll();

  document.getElementById("btnHeaderPublicar")?.addEventListener("click", async event => {
    const publishFlow = window.HomeClickPublishFlow || await publishFlowPromise;
    if (publishFlow?.navegarPublicacion) {
      publishFlow.navegarPublicacion(event);
    }
  });

  /* ======================
     BADGE NOTIFICACIONES
  ====================== */
  async function actualizarBadge() {
    try {
      const token = localStorage.getItem("token");
      if (!token) return;

      const res  = await fetch(`/chat/no-leidos/${usuario._id}`, {
        headers: { "Authorization": "Bearer " + token }
      });
      if (!res.ok) {
        console.warn("No se pudo actualizar el badge de chats:", res.status);
        return;
      }
      const data = await res.json();
      const badge = document.getElementById("chatBadge");
      if (badge) {
        badge.textContent = data.count;
        badge.style.display = data.count > 0 ? "flex" : "none";
      }
    } catch(e) {
      console.warn("No se pudo actualizar el badge de chats:", e.message);
    }
  }

  actualizarBadge();
  setInterval(actualizarBadge, 10000);
  actualizarBadgeNotif();
  setInterval(actualizarBadgeNotif, 30000);

  /* ======================
     DROPDOWN MENU
  ====================== */
  const userMenu   = document.getElementById("userMenu");
  const userToggle = document.getElementById("userToggle");
  const logoutBtn  = document.getElementById("logoutBtn");

  if (!userMenu || !userToggle || !logoutBtn) return;
  userToggle.textContent = nombreUsuarioInicial;
  refrescarUsuarioCabecera();

  userToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    userMenu.classList.toggle("open");
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#topbarLangDesktop")) {
      const menu = document.getElementById("topbarLangMenuDesktop");
      if (menu) menu.style.display = "none";
    }
    if (!e.target.closest("#topbarLangMobile")) {
      const menu = document.getElementById("topbarLangMenuMobile");
      if (menu) menu.style.display = "none";
    }
    if (!e.target.closest("#userMenu")) {
      if (userMenu) userMenu.classList.remove("open");
    }
    if (!e.target.closest("#notifMenu")) {
      const dropdown = document.getElementById("notifDropdown");
      if (dropdown) dropdown.style.display = "none";
    }
  });

  logoutBtn.addEventListener("click", (e) => {
    e.preventDefault();
    localStorage.removeItem("usuario");
    localStorage.removeItem("token");
    location.href = "/index.html";
  });

  /* ======================
     HEADER SCROLL
  ====================== */
  function iniciarScroll() {
    const header = document.querySelector(".header");
    if (!header) return;
    window.addEventListener("scroll", () => {
      if (window.scrollY > 50) {
        header.classList.add("scrolled");
      } else {
        header.classList.remove("scrolled");
      }
    });
  }

});

/* ======================
   SELECTOR DE IDIOMA - ESCRITORIO
====================== */
window.topbarLangMenuMobile = function(e) {
  e.stopPropagation();
  e.preventDefault();
  const menu = document.getElementById("topbarLangMenuDesktop");
  if (!menu) return;
  if (menu.style.display === "block") {
    menu.style.display = "none";
  } else {
    menu.style.display = "block";
    menu.style.position = "fixed";
    menu.style.top = "75px";
    menu.style.right = "20px";
    menu.style.zIndex = "999999";
    menu.style.minWidth = "180px";
    menu.style.background = "#1a2332";
    menu.style.borderRadius = "10px";
    menu.style.boxShadow = "0 8px 24px rgba(0,0,0,0.3)";
    menu.style.overflow = "hidden";
  }
};

/* ======================
   SELECTOR DE IDIOMA - MÓVIL
====================== */
window.toggleLangMenuMobile = function(e) {
  e.stopPropagation();
  e.preventDefault();
  const menu = document.getElementById("topbarLangMenuMobile");
  const btn = e.currentTarget;
  if (!menu) return;
  if (menu.style.display === "block") {
    menu.style.display = "none";
  } else {
    const rect = btn.getBoundingClientRect();
    menu.style.display = "block";
    menu.style.position = "fixed";
    menu.style.top = (rect.bottom + 6) + "px";
    menu.style.left = (rect.left - 100) + "px";
    menu.style.right = "auto";
    menu.style.zIndex = "999999";
    menu.style.minWidth = "180px";
    menu.style.background = "#1a2332";
    menu.style.borderRadius = "10px";
    menu.style.boxShadow = "0 8px 24px rgba(0,0,0,0.3)";
    menu.style.overflow = "hidden";
  }
};

/* ======================
   SELECCIONAR IDIOMA
====================== */
window.selectLang = function(flag, name) {
  const btns = document.querySelectorAll(".topbar-lang-btn");
  btns.forEach(btn => {
    const text = btn.textContent.includes("España") || btn.textContent.length > 5
      ? `${flag} ${name} ▾`
      : `${flag} ▾`;
    btn.textContent = text;
  });
  const menus = document.querySelectorAll(".topbar-lang-menu");
  menus.forEach(m => m.style.display = "none");
  if (name !== "España") {
    alert(`La versión en ${name} estará disponible próximamente 🌍`);
  }
};

window.toggleNotifMenu = function(e) {
  e.stopPropagation();
  const dropdown = document.getElementById("notifDropdown");
  if (!dropdown) return;
  const abierto = dropdown.style.display === "block";
  dropdown.style.display = abierto ? "none" : "block";
  if (!abierto) cargarNotificaciones();
};

async function cargarNotificaciones() {
  const usuario = JSON.parse(localStorage.getItem("usuario"));
  const token = localStorage.getItem("token");
  if (!usuario || !token) return;

  const res = await fetch(`/notificaciones/${usuario._id}`, {
    headers: { "Authorization": "Bearer " + token }
  });
  const notifs = await res.json();

  const lista = document.getElementById("notifLista");
  const badge = document.getElementById("notifBadge");
  if (!lista) return;

  const noLeidas = notifs.filter(n => !n.leida).length;
  if (badge) {
    badge.textContent = noLeidas;
    badge.style.display = noLeidas > 0 ? "flex" : "none";
  }

  if (notifs.length === 0) {
    lista.innerHTML = `<div style="padding:20px;text-align:center;color:#aaa;font-size:0.88rem;">Sin notificaciones</div>`;
    return;
  }

  lista.innerHTML = notifs.map(n => `
    <div onclick="marcarLeida('${n._id}', '${n.propiedadId?._id || ''}')"
      style="padding:12px 16px;border-bottom:1px solid #f5f5f5;cursor:pointer;
      background:${n.leida ? '#fff' : '#f0f9e8'};transition:background 0.2s;">
      <div style="font-size:0.85rem;color:#222;margin-bottom:4px;">${n.mensaje}</div>
      <div style="font-size:0.75rem;color:#aaa;">${new Date(n.createdAt).toLocaleDateString('es-ES')}</div>
    </div>
  `).join("");
}

window.marcarLeida = async function(id, propiedadId) {
  const token = localStorage.getItem("token");
  await fetch(`/notificaciones/${id}/leida`, {
    method: "PUT",
    headers: token ? { "Authorization": "Bearer " + token } : {}
  });
  if (propiedadId) window.location.href = `/propiedad?id=${propiedadId}`;
  else cargarNotificaciones();
};

async function actualizarBadgeNotif() {
  const usuario = JSON.parse(localStorage.getItem("usuario"));
  const token = localStorage.getItem("token");
  if (!usuario || !token) return;
  try {
    const res = await fetch(`/notificaciones/${usuario._id}`, {
      headers: { "Authorization": "Bearer " + token }
    });
    const notifs = await res.json();
    const noLeidas = notifs.filter(n => !n.leida).length;
    const badge = document.getElementById("notifBadge");
    if (badge) {
      badge.textContent = noLeidas;
      badge.style.display = noLeidas > 0 ? "flex" : "none";
    }
  } catch(e) {}
}
