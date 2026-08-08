function homeEscape(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function homeDireccionCorta(direccion = "") {
  const partes = String(direccion).split(",").map(p => p.trim()).filter(Boolean);
  return partes.slice(0, 2).join(", ") || direccion;
}

function renderDestacadaHome(p) {
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

  return `
    <article class="home-feature-card">
      <a href="${url}" class="home-feature-link" aria-label="${homeEscape(p.titulo)}">
        <div class="home-feature-img-wrap">
          <img src="${homeEscape(imagen)}" alt="${homeEscape(p.titulo)}" loading="lazy">
          <span class="home-feature-op ${tipoCls}">${tipo}</span>
        </div>
        <div class="home-feature-body">
          <div class="home-feature-price">${precio}</div>
          <h3>${homeEscape(p.titulo)}</h3>
          <p class="home-feature-address">${homeEscape(homeDireccionCorta(p.direccion || ""))}</p>
          ${meta ? `<p class="home-feature-meta">${homeEscape(meta)}</p>` : ""}
          <span class="home-feature-cta">Ver anuncio</span>
        </div>
      </a>
    </article>
  `;
}

async function cargarViviendasDestacadasHome() {
  const grid = document.getElementById("homeDestacadasGrid");
  if (!grid) return;

  try {
    const res = await fetch("/propiedades/destacadas");
    if (!res.ok) throw new Error("No se pudieron cargar las viviendas destacadas");
    const propiedades = await res.json();

    if (!propiedades.length) {
      grid.innerHTML = `<div class="home-feature-empty">Pronto verás aquí viviendas destacadas.</div>`;
      return;
    }

    grid.innerHTML = propiedades.slice(0, 8).map(renderDestacadaHome).join("");
  } catch (err) {
    console.error("Viviendas destacadas:", err);
    grid.innerHTML = `<div class="home-feature-empty">Pronto verás aquí viviendas destacadas.</div>`;
  }
}

document.addEventListener("DOMContentLoaded", cargarViviendasDestacadasHome);
