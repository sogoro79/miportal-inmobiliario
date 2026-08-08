function readSeoZoneContext() {
  const script = document.getElementById("seo-zone-context");
  if (!script?.textContent) return null;

  try {
    const context = JSON.parse(script.textContent);
    if (!context || typeof context !== "object") return null;
    if (!context.slug || !context.operacionPath || !context.canonical) return null;
    return context;
  } catch {
    return null;
  }
}

function getSeoZoneContext() {
  const context = readSeoZoneContext();
  if (!context) return null;

  const expectedPath = `/${context.operacionPath}/${context.slug}`;
  return window.location.pathname === expectedPath ? context : null;
}

function setMetaContent(selector, value) {
  const el = document.querySelector(selector);
  if (el) el.setAttribute("content", value);
}

function setCanonicalUrl(url) {
  let canonical = document.querySelector("link[rel='canonical']");
  if (!canonical) {
    canonical = document.createElement("link");
    canonical.rel = "canonical";
    document.head.appendChild(canonical);
  }
  canonical.href = url;
}

function addJsonLd(id, data) {
  document.getElementById(id)?.remove();
  const script = document.createElement("script");
  script.type = "application/ld+json";
  script.id = id;
  script.textContent = JSON.stringify(data);
  document.head.appendChild(script);
}

function addBaseStructuredData() {
  addJsonLd("schema-organization", {
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": "HomeClick24",
    "url": "https://www.homeclick24.com/",
    "logo": "https://www.homeclick24.com/HomeClick-full.png"
  });

  addJsonLd("schema-website", {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "name": "HomeClick24",
    "url": "https://www.homeclick24.com/",
    "potentialAction": {
      "@type": "SearchAction",
      "target": "https://www.homeclick24.com/comprar?search={search_term_string}",
      "query-input": "required name=search_term_string"
    }
  });
}

function addZoneBreadcrumbSchema(context) {
  addJsonLd("schema-breadcrumb", {
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
        "name": context.parentName,
        "item": context.parentUrl
      },
      {
        "@type": "ListItem",
        "position": 3,
        "name": context.zona.nombreSeo,
        "item": context.canonical
      }
    ]
  });
}

function renderSeoZoneLinks(containerId, operacionPath) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const context = readSeoZoneContext();
  const links = Array.isArray(context?.zoneLinks) ? context.zoneLinks : [];
  if (!links.length) return;

  container.replaceChildren(...links.map(zona => {
    const link = document.createElement("a");
    link.href = `/${operacionPath}/${zona.slug}`;
    link.textContent = zona.nombre;
    return link;
  }));
}

const seoZoneContext = readSeoZoneContext();
window.SEO_ZONAS = seoZoneContext?.zoneLinks || [];
window.SEO_ZONA_LINKS = seoZoneContext?.zoneLinks || [];
window.SEO_ZONE_CONTEXT = seoZoneContext;
window.getSeoZoneContext = getSeoZoneContext;
window.addBaseStructuredData = addBaseStructuredData;
window.addZoneBreadcrumbSchema = addZoneBreadcrumbSchema;
window.renderSeoZoneLinks = renderSeoZoneLinks;
window.setMetaContent = setMetaContent;
window.setCanonicalUrl = setCanonicalUrl;
