let propiedad = null;
let fotos = [];
let indexFoto = 0;
let mapa = null;

const publicado =
  new URLSearchParams(window.location.search)
    .get("publicado");

document.addEventListener("DOMContentLoaded", cargarPropiedad);

function estadoComercialBadge(estado = "Disponible") {
  const actual = estado || "Disponible";
  const estilos = {
    Disponible: "background:#f0f9e8;color:#5a9e2f;",
    Reservado: "background:#fff7ed;color:#c2410c;",
    Vendido: "background:#fef2f2;color:#dc2626;",
    Alquilado: "background:#eff6ff;color:#2563eb;"
  };
  return `<span class="estado-comercial-badge" style="${estilos[actual] || estilos.Disponible}">${actual}</span>`;
}

/* ================================
   CARGAR PROPIEDAD
================================ */
async function cargarPropiedad() {
  const id = typeof getPropiedadIdFromLocation === "function"
    ? getPropiedadIdFromLocation()
    : new URLSearchParams(window.location.search).get("id");
  if (!id) return mostrarError("ID de propiedad inválido");

  try {
    const res = await fetch(`/propiedades/${id}`);
    if (!res.ok) throw new Error("No encontrada");
    propiedad = await res.json();
  } catch (err) {
    return mostrarError("Propiedad no encontrada");
  }

  fotos = Array.isArray(propiedad.imagenes) && propiedad.imagenes.length
    ? propiedad.imagenes
    : ["https://images.unsplash.com/photo-1580587771525-78b9dba3b914?w=1200"];

  actualizarSEO();
  renderPropiedad();
  await iniciarMapa();
}

/* ================================
   SEO
================================ */
function actualizarSEO() {
  const precio = propiedad.precio?.toLocaleString("es-ES");
  const precioTexto = precio ? `${precio} €` : "precio a consultar";
  const zonaTexto = propiedad.direccion || "HomeClick24";
  const canonicalPath = typeof getPropiedadSeoUrl === "function"
    ? getPropiedadSeoUrl(propiedad)
    : `/propiedad/propiedad-${encodeURIComponent(propiedad._id)}`;
  const canonicalUrl = `https://www.homeclick24.com${canonicalPath}`;

  document.title = `${propiedad.titulo} en ${zonaTexto} | ${precioTexto} | HomeClick24`;
  
  const metaDesc = document.querySelector("meta[name='description']");
  if (metaDesc) metaDesc.setAttribute("content",
    `${propiedad.titulo} en ${zonaTexto}. Precio ${precioTexto}. Consulta fotos, detalles y contacto en HomeClick24.`
  );

  // Open Graph
  document.querySelector("meta[property='og:title']")
    ?.setAttribute("content", `${propiedad.titulo} | HomeClick24`);
  document.querySelector("meta[property='og:description']")
    ?.setAttribute("content", `${precioTexto} · ${zonaTexto}`);
  document.querySelector("meta[property='og:url']")
    ?.setAttribute("content", canonicalUrl);
  document.querySelector("meta[property='og:image']")
    ?.setAttribute("content", fotos[0] || "https://www.homeclick24.com/HomeClick-full.png");

  let canonical = document.querySelector("link[rel='canonical']");
  if (!canonical) {
    canonical = document.createElement("link");
    canonical.rel = "canonical";
    document.head.appendChild(canonical);
  }
  canonical.href = canonicalUrl;

  // Schema.org
  const schema = {
    "@context": "https://schema.org",
    "@type": "RealEstateListing",
    "name": propiedad.titulo,
    "description": propiedad.descripcion || "",
    "url": canonicalUrl,
    "price": propiedad.precio,
    "priceCurrency": "EUR",
    "address": {
      "@type": "PostalAddress",
      "streetAddress": propiedad.direccion || "",
      "addressCountry": "ES"
    },
    "numberOfRooms": propiedad.habitaciones || null,
    "image": fotos[0] || "",
    "offers": {
      "@type": "Offer",
      "price": propiedad.precio,
      "priceCurrency": "EUR",
      "availability": "https://schema.org/InStock"
    }
  };

  // Eliminar schema anterior si existe
  const schemaAnterior = document.getElementById("schema-propiedad");
  if (schemaAnterior) schemaAnterior.remove();

  const script = document.createElement("script");
  script.type = "application/ld+json";
  script.id = "schema-propiedad";
  script.textContent = JSON.stringify(schema);
  document.head.appendChild(script);

  const breadcrumbAnterior = document.getElementById("schema-breadcrumb-propiedad");
  if (breadcrumbAnterior) breadcrumbAnterior.remove();

  const tipoPath = propiedad.tipoOperacion === "alquiler" ? "alquiler" : "comprar";
  const tipoNombre = propiedad.tipoOperacion === "alquiler" ? "Alquiler" : "Comprar";
  const breadcrumb = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      {
        "@type": "ListItem",
        "position": 1,
        "name": "Inicio",
        "item": "https://www.homeclick24.com/"
      },
      {
        "@type": "ListItem",
        "position": 2,
        "name": tipoNombre,
        "item": `https://www.homeclick24.com/${tipoPath}`
      },
      {
        "@type": "ListItem",
        "position": 3,
        "name": propiedad.titulo,
        "item": canonicalUrl
      }
    ]
  };

  const breadcrumbScript = document.createElement("script");
  breadcrumbScript.type = "application/ld+json";
  breadcrumbScript.id = "schema-breadcrumb-propiedad";
  breadcrumbScript.textContent = JSON.stringify(breadcrumb);
  document.head.appendChild(breadcrumbScript);
}

/* ================================
   RENDER
================================ */
function renderPropiedad() {
  const contenedor = document.getElementById("contenedor");
  const tipo = propiedad.tipoOperacion === "venta" ? "Venta" : "Alquiler";
  const tipoCls = propiedad.tipoOperacion === "venta" ? "tag-venta" : "tag-alquiler";
  const precio = propiedad.precio?.toLocaleString("es-ES") + " €";
  const hab = propiedad.habitaciones ? `🛏 ${propiedad.habitaciones} habitaciones` : "";
  const estadoPropiedad = propiedad.estadoPropiedad || (propiedad.estado === "obra_nueva" ? "Obra nueva" : propiedad.estado === "segunda_mano" ? "Segunda mano" : "");

  contenedor.innerHTML = `

    <a class="volver-link" href="javascript:history.back()">← Volver</a>

    ${publicado === "1" ? `

    <div class="banner-publicado">

      <div class="banner-publicado-texto">
        ✅ Tu anuncio se ha publicado correctamente
      </div>

      <div class="banner-publicado-acciones">

        <a
          href="/publicar"
          class="btn-banner-publicar"
        >
          ➕ Publicar otro
        </a>

        <button
          id="btnCompartir"
          class="btn-banner-compartir"
        >
          📤 Compartir
        </button>

      </div>

    </div>

` : ""}

    <div class="propiedad-layout">

      <!-- COLUMNA IZQUIERDA -->
      <div class="propiedad-left">

        <!-- SLIDER -->
        <div class="slider-container">
          <button class="slider-btn left" onclick="prevFoto()">‹</button>
          <img class="slider-img" src="${fotos[0]}" alt="${propiedad.titulo}"
               onclick="abrirModal('${fotos[0]}')">
          <button class="slider-btn right" onclick="nextFoto()">›</button>
          <span class="slider-count">1 / ${fotos.length}</span>
          <span class="tag-tipo ${tipoCls}">${tipo}</span>
        </div>

        <!-- MINIATURAS -->
        ${fotos.length > 1 ? `
        <div class="miniaturas">
          ${fotos.map((f, i) => `
            <img src="${f}" class="miniatura ${i === 0 ? 'active' : ''}"
                 onclick="irFoto(${i})" alt="foto ${i+1}">
          `).join("")}
        </div>` : ""}

        <!-- DESCRIPCIÓN -->
        ${propiedad.videoUrl ? `
          <div class="propiedad-video">
            <h2>Vídeo</h2>

            <div class="video-wrap">
              <iframe
                src="${convertirYoutubeEmbed(propiedad.videoUrl)}"
                title="Vídeo de la propiedad"
                frameborder="0"
                allowfullscreen>
              </iframe>
            </div>
          </div>
        ` : ""}
        <div class="propiedad-descripcion">
          <h2>Descripción</h2>
          <p>${propiedad.descripcion || "Sin descripción disponible."}</p>
        </div>

        <!-- MAPA -->
        <div class="propiedad-mapa-wrap">
          <h2>Ubicación</h2>
          <div id="mapa"></div>
        </div>

        <!-- PROPIEDADES RELACIONADAS -->
        <section class="relacionadas-section" id="propiedadesRelacionadas" hidden>
          <div class="relacionadas-header">
            <div>
              <h2>También te puede interesar</h2>
              <p>Otras viviendas similares publicadas en HomeClick24</p>
            </div>
          </div>
          <div class="relacionadas-grid" id="propiedadesRelacionadasGrid"></div>
        </section>

      </div>

      <!-- COLUMNA DERECHA -->
      <div class="propiedad-right">
        <div class="propiedad-card-info">
          <span class="tag-tipo ${tipoCls}">${tipo}</span>
          <div class="propiedad-precio">${precio}</div>
          <div style="margin:8px 0 10px;">${estadoComercialBadge(propiedad.estadoComercial)}</div>
          <h1 class="propiedad-titulo">${propiedad.titulo}</h1>
          <div class="propiedad-dir">📍 ${propiedad.direccion}</div>
          ${propiedad.referencia ? `<div class="propiedad-dir">Ref. ${propiedad.referencia}</div>` : ""}
          ${hab ? `<div class="propiedad-hab">${hab}</div>` : ""}

          <!-- CARACTERÍSTICAS -->
          <div class="propiedad-caracteristicas">
            ${propiedad.superficie ? `<div class="caract-item">📐 <span>Construida: ${propiedad.superficie} m²</span></div>` : ""}
            ${propiedad.superficieParcela ? `<div class="caract-item">🌿 <span>Parcela: ${propiedad.superficieParcela} m²</span></div>` : ""} 
            ${propiedad.banos ? `<div class="caract-item">🚿 <span>${propiedad.banos} baño${propiedad.banos > 1 ? "s" : ""}</span></div>` : ""}
            ${estadoPropiedad ? `<div class="caract-item">🏗 <span>${estadoPropiedad}</span></div>` : ""}
            ${propiedad.certificadoEnergetico ? `<div class="caract-item">⚡ <span>Certificado energético: ${propiedad.certificadoEnergetico}</span></div>` : ""}
            ${propiedad.tipoInmueble ? `<div class="caract-item">🏠 <span>${formatearTipo(propiedad.tipoInmueble)}</span></div>` : ""}

            <!-- Residencial -->
            ${propiedad.garaje ? `<div class="caract-item">🚗 <span>Garaje incluido</span></div>` : ""}
            ${propiedad.piscina ? `<div class="caract-item">🏊 <span>Piscina</span></div>` : ""}
            ${propiedad.terraza ? `<div class="caract-item">🌿 <span>Terraza / Jardín</span></div>` : ""}

            <!-- Locales y oficinas -->
            ${propiedad.usoPermitido ? `<div class="caract-item">📋 <span>Uso: ${propiedad.usoPermitido}</span></div>` : ""}
            ${mostrarPlantaPropiedad(propiedad) ? `<div class="caract-item">🏢 <span>${formatearPlanta(propiedad.plantaLocal)}</span></div>` : ""}
            ${mostrarNumeroPlantas(propiedad) ? `<div class="caract-item">🏠 <span>${formatearNumeroPlantas(propiedad.numeroPlantas)}</span></div>` : ""}
            ${mostrarSotano(propiedad) ? `<div class="caract-item">⬇️ <span>Sótano: ${propiedad.sotano === "si" ? "Sí" : "No"}</span></div>` : ""}
            ${propiedad.escaparate ? `<div class="caract-item">🪟 <span>Con escaparate</span></div>` : ""}

            <!-- Garajes -->
            ${propiedad.tipoGaraje ? `<div class="caract-item">🅿️ <span>Garaje ${propiedad.tipoGaraje}</span></div>` : ""}
            ${propiedad.alturaMaxima ? `<div class="caract-item">📏 <span>Altura máx. ${propiedad.alturaMaxima}m</span></div>` : ""}

            <!-- Trasteros -->
            ${propiedad.accesoTrastero ? `<div class="caract-item">🚪 <span>Acceso: ${propiedad.accesoTrastero}</span></div>` : ""}
          </div>

          <hr>

          <button class="chat-open-btn" onclick="contactar()">
            💬 Contactar con el anunciante
          </button>

          <a class="btn-whatsapp" href="${generarEnlaceWhatsapp()}" target="_blank" rel="noopener">
            <img src="https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg" width="20" height="20" alt="WhatsApp">
            Compartir en WhatsApp
          </a>

          <div class="propiedad-aviso">
            <p>🔒 Tus datos están protegidos</p>
            <p>✅ Anuncio verificado por HomeClick24</p>
          </div>
        </div>
      </div>

    </div>
  `;
// =========================
// COMPARTIR
// =========================

const btnCompartir =
  document.getElementById("btnCompartir");

if (btnCompartir) {

  btnCompartir.addEventListener("click", async () => {

    try {

      await navigator.share({
        title: document.title,
        text: "Mira este anuncio en HomeClick24",
        url: window.location.href
      });

    } catch(err) {

      console.log(err);

    }

  });

}

window.dispatchEvent(new Event("propiedad:renderizada"));
ajustarOffsetRelacionadas();

}

function ajustarOffsetRelacionadas() {
  const relacionadas = document.getElementById("propiedadesRelacionadas");
  const sidebar = document.querySelector(".propiedad-card-info");
  const referencia = document.querySelector(".propiedad-mapa-wrap") || document.querySelector(".propiedad-descripcion");

  if (!relacionadas || !sidebar || !referencia || window.innerWidth <= 900) {
    if (relacionadas) relacionadas.style.setProperty("--relacionadas-offset", "0px");
    return;
  }

  const sidebarRect = sidebar.getBoundingClientRect();
  const referenciaRect = referencia.getBoundingClientRect();
  const offset = Math.max(0, Math.ceil(sidebarRect.bottom - referenciaRect.bottom));
  relacionadas.style.setProperty("--relacionadas-offset", `${offset}px`);
}

window.addEventListener("resize", ajustarOffsetRelacionadas);

/* ================================
   MAPA CON GEOCODING AUTOMÁTICO
================================ */
async function iniciarMapa() {
  let lat = propiedad.lat;
  let lng = propiedad.lng;

  // Si no tiene coordenadas, geocodifica la dirección
  if (!lat || !lng) {
    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(propiedad.direccion)}&format=json&limit=1`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.length) {
        lat = parseFloat(data[0].lat);
        lng = parseFloat(data[0].lon);
      }
    } catch (e) {
      console.warn("No se pudo geocodificar la dirección");
    }
  }

  if (!lat || !lng) return;

  if (mapa) mapa.remove();

  mapa = L.map("mapa").setView([lat, lng], 15);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(mapa);

  L.marker([lat, lng])
    .addTo(mapa)
    .bindPopup(propiedad.titulo)
    .openPopup();
}

/* ================================
   SLIDER
================================ */
function irFoto(i) {
  indexFoto = i;
  const img = document.querySelector(".slider-img");
  if (img) {
    img.src = fotos[i];
    img.onclick = () => abrirModal(fotos[i]);
  }
  const count = document.querySelector(".slider-count");
  if (count) count.textContent = `${i + 1} / ${fotos.length}`;
  document.querySelectorAll(".miniatura").forEach((m, idx) => {
    m.classList.toggle("active", idx === i);
  });
}

function nextFoto() { irFoto((indexFoto + 1) % fotos.length); }
function prevFoto()  { irFoto((indexFoto - 1 + fotos.length) % fotos.length); }

/* ================================
   MODAL
================================ */
function abrirModal(src) {
  indexFoto = fotos.indexOf(src);
  if (indexFoto === -1) indexFoto = 0;
  const modal = document.getElementById("modal");
  const img   = document.getElementById("modal-img");
  img.src = src;
  modal.style.display = "flex";
}

function cerrarModal() {
  document.getElementById("modal").style.display = "none";
}

function modalNext() {
  indexFoto = (indexFoto + 1) % fotos.length;
  document.getElementById("modal-img").src = fotos[indexFoto];
}

function modalPrev() {
  indexFoto = (indexFoto - 1 + fotos.length) % fotos.length;
  document.getElementById("modal-img").src = fotos[indexFoto];
}

function convertirYoutubeEmbed(url) {

  try {

    const videoId = new URL(url)
      .searchParams
      .get("v");

    return `https://www.youtube.com/embed/${videoId}`;

  } catch {

    return "";

  }

}

/* ================================
   ERROR
================================ */
function mostrarError(msg) {
  document.getElementById("contenedor").innerHTML = `
    <div style="text-align:center;padding:60px">
      <h2>😕 ${msg}</h2>
      <a href="javascript:history.back()" style="color:#7cc242">← Volver</a>
    </div>`;
}

/* ================================
   CONTACTAR
================================ */
async function contactar() {
  const usuario = JSON.parse(localStorage.getItem("usuario"));
  const token   = localStorage.getItem("token");

  if (!usuario || !usuario._id || !token) {
    alert("Debes iniciar sesión para contactar");
    window.location.href = "/login";
    return;
  }

  if (!propiedad.usuarioId) {
    alert("Esta propiedad no tiene anunciante asignado");
    return;
  }

  const res = await fetch("/chat/conversaciones", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + token
    },
    body: JSON.stringify({
      propiedadId: propiedad._id,
      compradorId: usuario._id,
      anuncianteId: propiedad.usuarioId
    })
  });

  const data = await res.json();
  if (!res.ok || !data._id) { alert("No se pudo abrir el chat"); return; }
  window.location.href = `/chat?id=${data._id}`;
}

/* ================================
   WHATSAPP
================================ */
function generarEnlaceWhatsapp() {
  const texto = encodeURIComponent(
    `🏠 *${propiedad.titulo}*\n📍 ${propiedad.direccion}\n💶 ${propiedad.precio?.toLocaleString("es-ES")} €\n\n${window.location.href}`
  );
  return `https://wa.me/?text=${texto}`;
}

function formatearTipo(tipo) {
  const tipos = {
    piso: "Piso",
    apartamento: "Apartamento",
    atico: "Ático",
    duplex: "Dúplex",
    estudio: "Estudio",
    casa: "Casa",
    chalet: "Chalet",
    adosado: "Adosado",
    casa_campo: "Casa de campo",
    casa_madera: "Casa de madera",
    local: "Local comercial",
    local_comercial: "Local comercial",
    oficina: "Oficina",
    nave: "Nave",
    hotel: "Hotel",
    edificio: "Edificio",
    negocio: "Negocio",
    terreno: "Terreno",
    solar_urbano: "Solar urbano",
    parcela: "Parcela",
    finca_rustica: "Finca rústica",
    finca_urbana: "Finca urbana",
    garaje: "Garaje",
    plaza_aparcamiento: "Plaza de aparcamiento",
    trastero: "Trastero",
    otro: "Otro"
  };
  return tipos[tipo] || tipo;
}

function mostrarPlantaPropiedad(propiedad) {
  if (!propiedad?.plantaLocal) return false;
  return [
    "piso", "apartamento", "atico", "duplex", "estudio",
    "local", "local_comercial", "oficina"
  ].includes(propiedad.tipoInmueble);
}

function tipoViviendaCompleta(tipo) {
  return ["casa", "chalet", "adosado", "casa_campo", "casa_madera"].includes(tipo);
}

function mostrarNumeroPlantas(propiedad) {
  return Boolean(propiedad?.numeroPlantas && tipoViviendaCompleta(propiedad.tipoInmueble));
}

function mostrarSotano(propiedad) {
  return Boolean(propiedad?.sotano && tipoViviendaCompleta(propiedad.tipoInmueble));
}

function formatearNumeroPlantas(valor) {
  const plantas = {
    "1": "1 planta",
    "2": "2 plantas",
    "3": "3 plantas",
    "4_mas": "4 o más plantas"
  };
  return plantas[valor] || valor;
}

function formatearPlanta(planta) {
  const plantas = {
    planta_baja: "Planta baja", semisotano: "Semisótano",
    sotano: "Sótano", primera: "Primera planta"
  };
  return plantas[planta] || planta;
}
