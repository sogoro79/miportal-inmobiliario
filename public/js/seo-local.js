function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function estadoComercialLocal(estado = "Disponible") {
  const actual = estado || "Disponible";
  const estilos = {
    Disponible: "background:#f0f9e8;color:#5a9e2f;",
    Reservado: "background:#fff7ed;color:#c2410c;",
    Vendido: "background:#fef2f2;color:#dc2626;",
    Alquilado: "background:#eff6ff;color:#2563eb;"
  };
  return `<span class="seo-local-badge" style="${estilos[actual] || estilos.Disponible}">${escapeHtml(actual)}</span>`;
}

function renderPropiedadLocal(p) {
  const img = p.imagenes?.[0] || "https://images.unsplash.com/photo-1580587771525-78b9dba3b914?w=600";
  const precio = Number(p.precio || 0).toLocaleString("es-ES") + " €";
  const hab = p.habitaciones ? `${p.habitaciones} hab.` : "";
  const banos = p.banos ? `${p.banos} baño${p.banos > 1 ? "s" : ""}` : "";
  const superficie = p.superficie ? `${p.superficie} m²` : "";

  const url = typeof getPropiedadSeoUrl === "function"
    ? getPropiedadSeoUrl(p)
    : `/propiedad/propiedad-${encodeURIComponent(p._id)}`;

  return `
    <article class="seo-local-card">
      <a href="${escapeHtml(url)}" aria-label="${escapeHtml(p.titulo)}">
        <img src="${escapeHtml(img)}" alt="${escapeHtml(p.titulo)}" loading="lazy">
        <div class="seo-local-card-body">
          <div class="seo-local-price">${precio}</div>
          ${estadoComercialLocal(p.estadoComercial)}
          <h2>${escapeHtml(p.titulo)}</h2>
          <p class="seo-local-address">${escapeHtml(p.direccion || "")}</p>
          <p class="seo-local-meta">${[hab, banos, superficie].filter(Boolean).join(" · ")}</p>
        </div>
      </a>
    </article>
  `;
}

async function cargarSeoLocal() {
  const config = window.LOCAL_SEO_CONFIG || {};
  const cont = document.getElementById("seo-local-list");
  const count = document.getElementById("seo-local-count");
  if (!cont) return;

  cont.innerHTML = "<p class='seo-local-muted'>Cargando anuncios disponibles...</p>";

  try {
    const params = new URLSearchParams();
    if (config.tipo) params.set("tipo", config.tipo);
    if (config.texto) params.set("texto", config.texto);

    const res = await fetch(`/propiedades?${params.toString()}`);
    if (!res.ok) throw new Error("No se pudieron cargar las propiedades");

    const propiedades = await res.json();
    if (count) {
      count.textContent = `${propiedades.length} anuncio${propiedades.length !== 1 ? "s" : ""} disponible${propiedades.length !== 1 ? "s" : ""}`;
    }

    if (!propiedades.length) {
      cont.innerHTML = `
        <div class="seo-local-empty">
          <h2>${escapeHtml(config.emptyTitle || "Todavía no hay anuncios publicados en esta zona")}</h2>
          <p>${escapeHtml(config.emptyText || "Estamos incorporando nuevos inmuebles. Puedes consultar las búsquedas generales o publicar tu anuncio para aparecer en esta página local.")}</p>
          <div class="seo-local-actions">
            <a href="/comprar">Ver viviendas en venta</a>
            <a href="/alquiler">Ver alquileres</a>
            <a href="/planes">Publicar anuncio</a>
          </div>
        </div>
      `;
      return;
    }

    cont.innerHTML = propiedades.map(renderPropiedadLocal).join("");
  } catch (err) {
    console.error("SEO local:", err);
    cont.innerHTML = "<p class='seo-local-muted'>No se han podido cargar los anuncios ahora mismo.</p>";
  }
}

document.addEventListener("DOMContentLoaded", cargarSeoLocal);
