function ultimasEscape(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function ultimasDireccionCorta(propiedad = {}) {
  if (propiedad.ciudad || propiedad.localidad) {
    return propiedad.ciudad || propiedad.localidad;
  }

  const partes = String(propiedad.direccion || "")
    .split(",")
    .map(p => p.trim())
    .filter(Boolean);

  return partes.slice(0, 2).join(", ");
}

function renderUltimaHome(p) {
  const imagen = p.imagenes?.[0] || "https://images.unsplash.com/photo-1580587771525-78b9dba3b914?w=700";
  const precio = Number(p.precio || 0).toLocaleString("es-ES") + " €";
  const tipo = p.tipoOperacion === "alquiler" ? "Alquiler" : "Venta";
  const tipoCls = p.tipoOperacion === "alquiler" ? "alquiler" : "venta";
  const hab = p.habitaciones ? `${p.habitaciones} hab.` : "";
  const banos = p.banos ? `${p.banos} baño${p.banos > 1 ? "s" : ""}` : "";
  const superficie = p.superficie ? `${p.superficie} m²` : "";
  const meta = [hab, banos, superficie].filter(Boolean).join(" · ");
  const url = typeof getPropiedadSeoUrl === "function"
    ? getPropiedadSeoUrl(p)
    : `/propiedad/propiedad-${encodeURIComponent(p._id)}`;
  const direccion = ultimasDireccionCorta(p);

  return `
    <article class="home-feature-card">
      <a href="${url}" class="home-feature-link" aria-label="${ultimasEscape(p.titulo)}">
        <div class="home-feature-img-wrap">
          <img src="${ultimasEscape(imagen)}" alt="${ultimasEscape(p.titulo)}" loading="lazy">
          <span class="home-feature-op ${tipoCls}">${tipo}</span>
        </div>
        <div class="home-feature-body">
          <div class="home-feature-price">${precio}</div>
          <h3>${ultimasEscape(p.titulo)}</h3>
          ${direccion ? `<p class="home-feature-address">${ultimasEscape(direccion)}</p>` : ""}
          ${meta ? `<p class="home-feature-meta">${ultimasEscape(meta)}</p>` : ""}
          <span class="home-feature-cta">Ver anuncio</span>
        </div>
      </a>
    </article>
  `;
}

async function cargarUltimosAnunciosHome() {
  const grid = document.getElementById("homeUltimasGrid");
  if (!grid) return;

  try {
    const res = await fetch("/propiedades/ultimas");
    if (!res.ok) throw new Error("No se pudieron cargar los últimos anuncios");
    const propiedades = await res.json();

    if (!propiedades.length) {
      grid.innerHTML = `<div class="home-feature-empty">Pronto aparecerán aquí los últimos anuncios publicados.</div>`;
      return;
    }

    grid.innerHTML = propiedades.slice(0, 8).map(renderUltimaHome).join("");
  } catch (err) {
    console.error("Últimos anuncios:", err);
    grid.innerHTML = `<div class="home-feature-empty">Pronto aparecerán aquí los últimos anuncios publicados.</div>`;
  }
}

document.addEventListener("DOMContentLoaded", cargarUltimosAnunciosHome);
