// =============================
// CONFIG INICIAL
// =============================
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";
import { scheduleVipTrialExpiration } from "./utils/trials.js";
import { schedulePendingPlanChanges } from "./utils/planChanges.js";
import { scheduleManualPlanExpirations } from "./utils/manualPlanExpirations.js";
import { scheduleProfessionalPromotionExpiration } from "./utils/professionalPromotion.js";
import { crearRutaPropiedadSeo } from "./utils/seoSlug.js";
import { getSeoZoneContext, getSeoZoneSlugs } from "./utils/seoZones.js";
import { filtroNoCaducado } from "./utils/freeListingExpiration.js";
import { envFlagEnabled } from "./utils/envFlags.js";
import { createCorsOptions, createHelmetMiddleware, securityRateLimits } from "./utils/security.js";

// =============================
// MODELOS
// =============================
import Propiedad from "./models/Propiedad.js";

// =============================
// RUTAS API
// =============================
import usuariosRoutes from "./routes/usuarios.js";
import authRoutes from "./routes/auth.js";
import chatRoutes from "./routes/chat.js";
import propiedadesRoutes from "./routes/propiedades.js";
import alertasRoutes from "./routes/alertas.js";
import notificacionesRoutes from "./routes/notificaciones.js";
import pagosRoutes from "./routes/pagos.js";
import webhookRoutes from "./routes/webhook.js";
import adminRoutes from "./routes/admin.js";
import planesRoutes from "./routes/planes.js";
import professionalPromotionRoutes from "./routes/professionalPromotion.js";

// =============================
// FIX __dirname (ES MODULES)
// =============================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================
// APP
// =============================
const app = express();
const isProduction = process.env.NODE_ENV === "production";

app.disable("x-powered-by");
app.set("trust proxy", isProduction ? 1 : false);

// =============================
// MIDDLEWARE
// =============================
// Helmet queda sin CSP estricta por ahora; preparar allowlist de scripts, estilos,
// imágenes, Cloudinary, Stripe y fuentes en un bloque posterior antes de activarla.
app.use(createHelmetMiddleware({ env: process.env.NODE_ENV }));
app.use(cors(createCorsOptions({ env: process.env.NODE_ENV })));
app.use((err, req, res, next) => {
  if (err?.statusCode === 403 && err.message === "Origen no permitido") {
    return res.status(403).json({ error: "Origen no permitido" });
  }
  return next(err);
});
// Redirigir URL antigua a dominio propio
app.use((req, res, next) => {
  if (req.hostname === 'miportal-inmobiliario-server.onrender.com' || 
      req.hostname === 'homeclick24.onrender.com') {
    return res.redirect(301, `https://www.homeclick24.com${req.originalUrl}`);
  }
  next();
});
app.use("/webhook", express.raw({ type: "application/json" }), webhookRoutes);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =============================
// FRONTEND (PUBLIC)
// =============================
const publicPath = path.resolve(__dirname, "public");
const cleanHtmlRoutes = {
  "/comprar": "comprar.html",
  "/alquiler": "alquiler.html",
  "/publicar": "publicar.html",
  "/planes": "planes.html",
  "/profesionales": "profesionales.html",
  "/integraciones": "integraciones.html",
  "/login": "login.html",
  "/registro": "registro.html",
  "/recuperar": "recuperar.html",
  "/terminos": "terminos.html"
};

const privateCleanHtmlRoutes = {
  "/admin": "admin.html",
  "/perfil": "perfil.html",
  "/chat": "chat.html",
  "/favoritos": "favoritos.html",
  "/reset-password": "reset.html",
  "/set-password": "set-password.html"
};

const seoZoneSlugs = getSeoZoneSlugs();

const SITE_URL = "https://www.homeclick24.com";
const PROPERTY_HTML_PATH = path.join(publicPath, "propiedad.html");
const FALLBACK_OG_IMAGE = `${SITE_URL}/HomeClick-full.png`;

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  })[char]);
}

function textoPlano(value = "") {
  return String(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function resumirDescripcion(propiedad = {}) {
  const base = textoPlano(propiedad.descripcion)
    || [
      propiedad.titulo,
      propiedad.direccion ? `en ${propiedad.direccion}` : "",
      propiedad.precio ? `Precio ${Number(propiedad.precio).toLocaleString("es-ES")} €` : ""
    ].filter(Boolean).join(". ");

  return base.length > 165 ? `${base.slice(0, 162).trim()}...` : base;
}

function extraerIdPropiedadDesdeSlug(slug = "") {
  const match = String(slug).match(/([a-f0-9]{24})$/i);
  return match ? match[1] : "";
}

function urlAbsolutaHttps(url = "") {
  if (!url) return "";
  const limpia = String(url).trim();
  if (/^https?:\/\//i.test(limpia)) {
    return limpia.replace(/^http:\/\//i, "https://");
  }
  return new URL(limpia.startsWith("/") ? limpia : `/${limpia}`, SITE_URL).href;
}

function optimizarImagenCloudinary(url = "") {
  if (!/res\.cloudinary\.com\/.+\/image\/upload\//i.test(url)) return url;
  if (/\/upload\/[^/]*(c_|w_|h_|q_|f_)/i.test(url)) return url;
  return url.replace("/upload/", "/upload/c_fill,w_1200,h_630,g_auto,q_auto,f_auto/");
}

function imagenOgPropiedad(propiedad = {}) {
  const primera = Array.isArray(propiedad.imagenes) ? propiedad.imagenes.find(Boolean) : "";
  if (!primera) return FALLBACK_OG_IMAGE;
  return optimizarImagenCloudinary(urlAbsolutaHttps(primera));
}

function construirMetaPropiedad(propiedad = {}) {
  const canonicalPath = crearRutaPropiedadSeo(propiedad);
  const canonicalUrl = `${SITE_URL}${canonicalPath}`;
  const title = `${propiedad.titulo || "Propiedad"} | HomeClick24`;
  const description = resumirDescripcion(propiedad);
  const imageUrl = imagenOgPropiedad(propiedad);
  const escapedTitle = escapeHtml(propiedad.titulo || "Propiedad en HomeClick24");
  const escapedDescription = escapeHtml(description);
  const escapedCanonical = escapeHtml(canonicalUrl);
  const escapedImage = escapeHtml(imageUrl);

  return `  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapedDescription}">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="${escapedCanonical}">

  <meta property="og:type" content="website">
  <meta property="og:title" content="${escapedTitle}">
  <meta property="og:description" content="${escapedDescription}">
  <meta property="og:url" content="${escapedCanonical}">
  <meta property="og:image" content="${escapedImage}">
  <meta property="og:image:secure_url" content="${escapedImage}">
  <meta property="og:image:alt" content="${escapedTitle} en HomeClick24">

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapedTitle}">
  <meta name="twitter:description" content="${escapedDescription}">
  <meta name="twitter:image" content="${escapedImage}">`;
}

function inyectarMetaPropiedad(html, propiedad) {
  return html.replace(
    /  <!-- SEO dinámico[\s\S]*?  <meta name="twitter:image" content="[^"]*">/,
    construirMetaPropiedad(propiedad)
  );
}

function inyectarCanonicalAbsoluto(html, canonicalUrl) {
  const escapedCanonical = escapeHtml(canonicalUrl);
  return html
    .replace(
      /<link rel="canonical" href="[^"]*">/,
      `<link rel="canonical" href="${escapedCanonical}">`
    )
    .replace(
      /<meta property="og:url" content="[^"]*">/,
      `<meta property="og:url" content="${escapedCanonical}">`
    );
}

function escapeJsonForHtml(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function inyectarSeoZona(html, context) {
  const escapedTitle = escapeHtml(context.title);
  const escapedDescription = escapeHtml(context.description);
  const escapedH1 = escapeHtml(context.h1);
  const escapedIntro = escapeHtml(context.intro);
  const escapedLocalTitle = escapeHtml(context.localContentTitle);
  const escapedLocalContent = escapeHtml(context.localContent);
  const contextScript = `  <script id="seo-zone-context" type="application/json">${escapeJsonForHtml(context)}</script>\n`;

  return inyectarCanonicalAbsoluto(html, context.canonical)
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapedTitle}</title>`)
    .replace(/<meta name="description" content="[^"]*">/i, `<meta name="description" content="${escapedDescription}">`)
    .replace(/<meta name="twitter:title" content="[^"]*">/i, `<meta name="twitter:title" content="${escapedTitle}">`)
    .replace(/<meta name="twitter:description" content="[^"]*">/i, `<meta name="twitter:description" content="${escapedDescription}">`)
    .replace(
      /<meta property="og:title" content="[^"]*">/i,
      `<meta property="og:title" content="${escapedTitle}">`
    )
    .replace(
      /<meta property="og:description" content="[^"]*">/i,
      `<meta property="og:description" content="${escapedDescription}">`
    )
    .replace(/<h1>[\s\S]*?<\/h1>/i, `<h1>${escapedH1}</h1>`)
    .replace(
      /<p class="page-header-intro"([^>]*)>[\s\S]*?<\/p>/i,
      `<p class="page-header-intro"$1>${escapedIntro}</p>`
    )
    .replace(
      /<section class="zona-contenido-local" id="seoZonaContenido" hidden>[\s\S]*?<\/section>/i,
      `<section class="zona-contenido-local" id="seoZonaContenido" aria-labelledby="seoZonaContenidoTitulo">
  <h2 id="seoZonaContenidoTitulo">${escapedLocalTitle}</h2>
  <p id="seoZonaContenidoTexto">${escapedLocalContent}</p>
</section>`
    )
    .replace("</head>", `${contextScript}</head>`);
}

function enviarHtmlPropiedad(res, propiedad = null) {
  const html = fs.readFileSync(PROPERTY_HTML_PATH, "utf8");
  res.type("html").send(propiedad ? inyectarMetaPropiedad(html, propiedad) : html);
}

function enviar404(res) {
  res.status(404).sendFile(path.join(publicPath, "404.html"));
}

async function buscarPropiedadPublicaPorId(id) {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return Propiedad.findOne({
    _id: id,
    visiblePublicamente: { $ne: false },
    ...filtroNoCaducado()
  }).lean();
}

app.get("/propiedad", async (req, res) => {
  const id = req.query.id;
  if (!id) return enviar404(res);

  try {
    const propiedad = await buscarPropiedadPublicaPorId(id);
    if (propiedad) return res.redirect(301, crearRutaPropiedadSeo(propiedad));
  } catch (err) {
    console.warn("No se pudo resolver propiedad legacy:", err.message);
  }

  enviar404(res);
});

app.get("/propiedad.html", async (req, res) => {
  const id = req.query.id;

  if (!id) return enviar404(res);

  try {
    const propiedad = await buscarPropiedadPublicaPorId(id);
    if (propiedad) return res.redirect(301, crearRutaPropiedadSeo(propiedad));
  } catch (err) {
    console.warn("No se pudo resolver slug legacy de propiedad:", err.message);
  }

  enviar404(res);
});

Object.keys(cleanHtmlRoutes).forEach(route => {
  app.get(`${route}.html`, (req, res) => {
    const query = req.url.slice(req.path.length);
    res.redirect(301, `${route}${query}`);
  });

  app.get(route, (req, res) => {
    res.sendFile(path.join(publicPath, cleanHtmlRoutes[route]));
  });
});

Object.keys(privateCleanHtmlRoutes).forEach(route => {
  app.get(`${route}.html`, (req, res) => {
    const query = req.url.slice(req.path.length);
    res.redirect(301, `${route}${query}`);
  });

  app.get(route, (req, res) => {
    res.sendFile(path.join(publicPath, privateCleanHtmlRoutes[route]));
  });
});

app.get(["/reset", "/reset.html"], (req, res) => {
  const query = req.url.slice(req.path.length);
  res.redirect(301, `/reset-password${query}`);
});

const legacyPublicarRoutes = new Set([
  "/añadir",
  "/añadir.html",
  "/anadir",
  "/anadir.html",
  "/a%C3%B1adir",
  "/a%C3%B1adir.html"
]);

app.use((req, res, next) => {
  const queryIndex = req.originalUrl.indexOf("?");
  const rawPath = queryIndex === -1 ? req.originalUrl : req.originalUrl.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : req.originalUrl.slice(queryIndex);
  let decodedPath = rawPath;

  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch (err) {
    decodedPath = rawPath;
  }

  if (legacyPublicarRoutes.has(rawPath) || legacyPublicarRoutes.has(decodedPath)) {
    return res.redirect(301, `/publicar${query}`);
  }

  next();
});

app.get(["/comprar/:zona", "/alquiler/:zona"], (req, res, next) => {
  const operacionPath = req.path.startsWith("/comprar/") ? "comprar" : "alquiler";
  const context = getSeoZoneContext({ operacionPath, slug: req.params.zona, siteUrl: SITE_URL });
  if (!context) return next();
  const htmlFile = req.path.startsWith("/comprar/")
    ? "comprar.html"
    : "alquiler.html";

  const html = fs.readFileSync(path.join(publicPath, htmlFile), "utf8");
  res.type("html").send(inyectarSeoZona(html, context));
});

app.get("/propiedad/:slug", async (req, res, next) => {
  const id = extraerIdPropiedadDesdeSlug(req.params.slug);
  if (!id) return next();

  try {
    const propiedad = await buscarPropiedadPublicaPorId(id);
    if (!propiedad) return next();

    const canonicalPath = crearRutaPropiedadSeo(propiedad);
    if (req.path !== canonicalPath) {
      return res.redirect(301, canonicalPath);
    }

    return enviarHtmlPropiedad(res, propiedad);
  } catch (err) {
    console.error("Error generando HTML SEO de propiedad:", err.message);
    return res.status(500).send("Error generando propiedad");
  }
});

app.use(express.static(publicPath));

// =============================
// UPLOADS
// =============================
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// =============================
// ROBOTS.TXT
// =============================
app.get("/robots.txt", (req, res) => {
  res.type("text/plain");
  res.send(`User-agent: *
Allow: /

Sitemap: https://www.homeclick24.com/sitemap.xml`);
});

// =============================
// SITEMAP.XML
// =============================
app.get("/sitemap.xml", async (req, res) => {
  try {
    const propiedades = await Propiedad.find(
      {
        visiblePublicamente: { $ne: false },
        ...filtroNoCaducado(),
        estadoComercial: { $nin: ["Vendido", "Alquilado"] }
      },
      { _id: 1, titulo: 1, updatedAt: 1 }
    ).lean();

    const urls = [
      { loc: "/", priority: "1.0" },
      { loc: "/comprar", priority: "0.9" },
      { loc: "/alquiler", priority: "0.9" },
      ...seoZoneSlugs.flatMap(slug => [
        { loc: `/comprar/${slug}`, priority: "0.8" },
        { loc: `/alquiler/${slug}`, priority: "0.8" }
      ]),
      { loc: "/publicar", priority: "0.8" },
      { loc: "/planes", priority: "0.8" },
      { loc: "/profesionales", priority: "0.7" },
      { loc: "/integraciones", priority: "0.4" },
      { loc: "/terminos", priority: "0.3" },
      ...propiedades.map(p => ({
        loc: crearRutaPropiedadSeo(p),
        priority: "0.8",
        lastmod: p.updatedAt ? p.updatedAt.toISOString().split("T")[0] : ""
      }))
    ];

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>https://www.homeclick24.com${u.loc}</loc>
    ${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}
    <priority>${u.priority}</priority>
  </url>`).join("\n")}
</urlset>`;

    res.type("application/xml");
    res.send(xml);
  } catch(e) {
    res.status(500).send("Error generando sitemap");
  }
});

// =============================
// RUTAS API
// =============================
app.use("/auth", authRoutes);
app.use("/chat", chatRoutes);
app.use("/propiedades", propiedadesRoutes);
app.use("/usuarios", usuariosRoutes);
app.use("/alertas", alertasRoutes);
app.use("/notificaciones", notificacionesRoutes);
app.use("/api/planes", planesRoutes);
app.use("/api/promocion-profesional", professionalPromotionRoutes);
app.use("/pagos", pagosRoutes);
app.use("/admin", adminRoutes);

// =============================
// INDEX
// =============================
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// =============================
// 404
// =============================
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, "public", "404.html"));
});

// =============================
// START
// =============================
const PORT = process.env.PORT || 3000;

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  mongoose
    .connect(process.env.MONGODB_URI)
    .then(() => {
      console.log("✅ MongoDB conectado");
      scheduleVipTrialExpiration();
      scheduleProfessionalPromotionExpiration();
      if (envFlagEnabled("ENABLE_PENDING_PLAN_CHANGES")) {
        schedulePendingPlanChanges();
      } else {
        console.log("Cambios de plan programados desactivados por configuración");
      }
      if (envFlagEnabled("ENABLE_MANUAL_PLAN_EXPIRATIONS")) {
        scheduleManualPlanExpirations();
      } else {
        console.log("Expiraciones de planes manuales desactivadas por configuración");
      }
      app.listen(PORT, () => {
        console.log(`🚀 Servidor activo en http://localhost:${PORT}`);
      });
    })
    .catch(err => {
      console.error("❌ Error MongoDB:", err);
      process.exit(1);
    });
}

export default app;
