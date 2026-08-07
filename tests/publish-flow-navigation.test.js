import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  filtroPropiedadesValidasVisibles,
  getEstadoPublicacionUsuario,
  getPlanParaLimites,
  usuarioTienePlanActivoParaPublicar
} from "../utils/publishEligibility.js";

const headerJs = fs.readFileSync(new URL("../public/js/header.js", import.meta.url), "utf8");
const publishFlowJs = fs.readFileSync(new URL("../public/js/publish-flow.js", import.meta.url), "utf8");
const planesHtml = fs.readFileSync(new URL("../public/planes.html", import.meta.url), "utf8");
const perfilHtml = fs.readFileSync(new URL("../public/perfil.html", import.meta.url), "utf8");
const publicarHtml = fs.readFileSync(new URL("../public/publicar.html", import.meta.url), "utf8");
const usuariosRoutes = fs.readFileSync(new URL("../routes/usuarios.js", import.meta.url), "utf8");
const propiedadesRoutes = fs.readFileSync(new URL("../routes/propiedades.js", import.meta.url), "utf8");

test("estado de publicación deriva límites desde catálogo central", () => {
  const gratis0 = getEstadoPublicacionUsuario({ plan: "gratis" }, 0);
  const gratis1 = getEstadoPublicacionUsuario({ plan: "gratis" }, 1);
  const gratis2 = getEstadoPublicacionUsuario({ plan: "gratis" }, 2);

  assert.equal(gratis0.limiteAnuncios, 2);
  assert.equal(gratis0.puedePublicarAhora, true);
  assert.equal(gratis1.puedePublicarAhora, true);
  assert.equal(gratis2.puedePublicarAhora, false);
  assert.equal(gratis2.motivo, "limite_anuncios");

  const basico = getEstadoPublicacionUsuario({ plan: "basico", planActivo: true }, 2);
  assert.equal(basico.limiteAnuncios, 3);
  assert.equal(basico.puedePublicarAhora, true);
});

test("planes inactivos y vip_trial no aceptado no pueden publicar", () => {
  assert.equal(usuarioTienePlanActivoParaPublicar({ plan: "gratis" }), true);
  assert.equal(usuarioTienePlanActivoParaPublicar({ plan: "basico", planActivo: false }), false);
  assert.equal(usuarioTienePlanActivoParaPublicar({ plan: "basico", planActivo: true }), true);
  assert.equal(usuarioTienePlanActivoParaPublicar({ plan: "vip_trial", planActivo: true, trialAccepted: false }), false);
  assert.equal(getPlanParaLimites({ plan: "vip_trial", planActivo: false, trialAccepted: false }), "gratis");
});

test("filtro de cupo usa las mismas propiedades válidas que publicación backend", () => {
  assert.deepEqual(filtroPropiedadesValidasVisibles("user-1"), {
    usuarioId: "user-1",
    visiblePublicamente: { $ne: false },
    activo: { $ne: false },
    eliminada: { $ne: true },
    oculto: { $ne: true },
    estadoComercial: { $nin: ["Vendido", "Alquilado", "Reservado", "No disponible"] }
  });
});

test("endpoint de estado de publicación reutiliza requireAuth, catálogo central y conteo real", () => {
  assert.match(usuariosRoutes, /router\.get\("\/me\/publicacion-estado", requireAuth/);
  assert.match(usuariosRoutes, /Propiedad\.countDocuments\(filtroPropiedadesValidasVisibles\(req\.user\.id\)\)/);
  assert.match(usuariosRoutes, /getEstadoPublicacionUsuario\(usuario, anunciosActuales\)/);
});

test("backend de publicar conserva comprobación segura de límites", () => {
  assert.match(propiedadesRoutes, /usuarioTienePlanActivoParaPublicar\(usuario\)/);
  assert.match(propiedadesRoutes, /getEstadoPublicacionUsuario\(usuario, totalAnuncios\)/);
  assert.match(propiedadesRoutes, /!estadoPublicacion\.puedePublicarAhora/);
  assert.match(propiedadesRoutes, /Has alcanzado el límite de anuncios/);
});

test("helper frontend distingue visitante, primera selección y cupo agotado", () => {
  assert.match(publishFlowJs, /if \(!token\) return "\/planes"/);
  assert.match(publishFlowJs, /\/usuarios\/me\/publicacion-estado/);
  assert.match(publishFlowJs, /if \(!estado\?\.puedePublicarAhora\) return "\/planes"/);
  assert.match(publishFlowJs, /usuarioTienePlanSeleccionado\(usuario, estado\) \? "\/publicar" : "\/planes"/);
  assert.match(publishFlowJs, /Number\(estado\?\.anunciosActuales \|\| 0\) > 0/);
  assert.match(publishFlowJs, /plan !== "gratis" && estado\?\.planActivoParaPublicar === true/);
});

test("helper marca selección local por usuario sin inventar migraciones", () => {
  assert.match(publishFlowJs, /hc24_plan_publicacion_seleccionado:/);
  assert.match(publishFlowJs, /marcarSeleccionLocal/);
  assert.match(publishFlowJs, /localStorage\.setItem\(key, "true"\)/);
  assert.doesNotMatch(usuariosRoutes, /planSeleccionado|firstPublication|primeraPublicacion/);
});

test("cabecera usa la decisión compartida para Pon tu anuncio", () => {
  assert.match(headerJs, /\/js\/publish-flow\.js/);
  assert.match(headerJs, /btnHeaderPublicar/);
  assert.match(headerJs, /publishFlow\.navegarPublicacion\(event\)/);
  assert.doesNotMatch(headerJs, /usuario\.planActivo === true[\s\S]*\/publicar/);
});

test("perfil reutiliza la misma regla que la cabecera", () => {
  assert.match(perfilHtml, /\/js\/publish-flow\.js/);
  assert.match(perfilHtml, /id="btnPerfilPublicar"/);
  assert.match(perfilHtml, /id="btnPerfilPublicarVacio"/);
  assert.match(perfilHtml, /HomeClickPublishFlow\.navegarPublicacion\(event\)/);
});

test("planes autenticado no envía Gratis a registro y sí a publicar", () => {
  const renderBlock = planesHtml.match(/function renderPlanCard\(plan\) \{[\s\S]*?^}/m)?.[0] || "";
  assert.doesNotMatch(renderBlock, /href = "\/registro"/);
  assert.match(planesHtml, /plan === "gratis"[\s\S]*marcarSeleccionYPublicar\(usuario\)/);
  assert.match(planesHtml, /btn\.textContent = puedePublicar \? "Publicar anuncio" : "Plan actual"/);
});

test("planes mantiene visitantes y pagos en flujos existentes sin perder sesión", () => {
  assert.match(planesHtml, /localStorage\.setItem\("planPendiente", plan\)/);
  assert.match(planesHtml, /\/login\?returnUrl=\/planes/);
  assert.match(planesHtml, /const endpoint = usuarioConSuscripcion\(usuario\) \? "\/pagos\/cambiar-plan" : "\/pagos\/crear-sesion"/);
  assert.match(planesHtml, /Authorization': 'Bearer ' \+ token/);
  assert.doesNotMatch(planesHtml, /localStorage\.removeItem\("token"\)[\s\S]*plan === "gratis"/);
});

test("publicar sigue protegido para visitantes y marca selección solo tras sesión válida", () => {
  assert.match(publicarHtml, /if \(!token\)[\s\S]*redirigirLoginPublicar\(\)/);
  assert.match(publicarHtml, /refrescarUsuarioPublicar\(token\)/);
  assert.match(publicarHtml, /marcarSeleccionLocal\(usuario\)/);
  assert.match(publicarHtml, /\/api\/planes\/catalogo/);
});
