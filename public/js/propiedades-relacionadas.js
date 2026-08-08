function relacionadasEscape(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function relacionadasDireccionCorta(propiedad = {}) {
  if (propiedad.ciudad || propiedad.localidad) {
    return propiedad.ciudad || propiedad.localidad;
  }

  return String(propiedad.direccion || "")
    .split(",")
    .map(p => p.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(", ");
}

function renderPropiedadRelacionada(p) {
  const imagen = p.imagenes?.[0] || "https://images.unsplash.com/photo-1580587771525-78b9dba3b914?w=700";
  const precio = Number(p.precio || 0).toLocaleString("es-ES") + " €";
  const operacion = p.tipoOperacion === "alquiler" ? "Alquiler" : "Venta";
  const operacionClase = p.tipoOperacion === "alquiler" ? "alquiler" : "venta";
  const hab = p.habitaciones ? `${p.habitaciones} hab.` : "";
  const banos = p.banos ? `${p.banos} baño${p.banos > 1 ? "s" : ""}` : "";
  const superficie = p.superficie ? `${p.superficie} m²` : "";
  const meta = [hab, banos, superficie].filter(Boolean).join(" · ");
  const url = typeof getPropiedadSeoUrl === "function"
    ? getPropiedadSeoUrl(p)
    : `/propiedad/propiedad-${encodeURIComponent(p._id)}`;
  const direccion = relacionadasDireccionCorta(p);

  return `
    <article class="relacionada-card">
      <a href="${url}" class="relacionada-link" aria-label="${relacionadasEscape(p.titulo)}">
        <div class="relacionada-img-wrap">
          <img src="${relacionadasEscape(imagen)}" alt="${relacionadasEscape(p.titulo)}" loading="lazy">
          <span class="relacionada-op ${operacionClase}">${operacion}</span>
        </div>
        <div class="relacionada-body">
          <div class="relacionada-precio">${precio}</div>
          <h3>${relacionadasEscape(p.titulo)}</h3>
          ${direccion ? `<p class="relacionada-dir">${relacionadasEscape(direccion)}</p>` : ""}
          ${meta ? `<p class="relacionada-meta">${relacionadasEscape(meta)}</p>` : ""}
          <span class="relacionada-cta">Ver anuncio</span>
        </div>
      </a>
    </article>
  `;
}

let propiedadesRelacionadasCargadas = false;

async function cargarPropiedadesRelacionadas() {
  const seccion = document.getElementById("propiedadesRelacionadas");
  const grid = document.getElementById("propiedadesRelacionadasGrid");
  const id = typeof getPropiedadIdFromLocation === "function"
    ? getPropiedadIdFromLocation()
    : new URLSearchParams(window.location.search).get("id");

  if (!seccion || !grid || !id) return;
  if (propiedadesRelacionadasCargadas) return;
  propiedadesRelacionadasCargadas = true;

  try {
    const res = await fetch(`/propiedades/relacionadas/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error("No se pudieron cargar propiedades relacionadas");

    const propiedades = await res.json();
    if (!Array.isArray(propiedades) || !propiedades.length) {
      seccion.hidden = true;
      return;
    }

    grid.innerHTML = propiedades.slice(0, 4).map(renderPropiedadRelacionada).join("");
    seccion.hidden = false;
  } catch (err) {
    console.warn("Propiedades relacionadas:", err.message);
    seccion.hidden = true;
  }
}

document.addEventListener("DOMContentLoaded", cargarPropiedadesRelacionadas);
window.addEventListener("propiedad:renderizada", cargarPropiedadesRelacionadas);
