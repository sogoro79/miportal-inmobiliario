function deepFreeze(value) {
  Object.freeze(value);
  Object.values(value).forEach(item => {
    if (item && typeof item === "object" && !Object.isFrozen(item)) {
      deepFreeze(item);
    }
  });
  return value;
}

export const PLAN_CATALOG = deepFreeze({
  gratis: {
    id: "gratis",
    nombre: "Gratis",
    categoria: "particular",
    precio: "0€",
    precioDetalle: "",
    anuncios: 2,
    fotos: 7,
    duracionAnunciosDias: 15,
    dependeDeStripe: false,
    ilimitadoAnuncios: false,
    ilimitadoFotos: false,
    esTrial: false,
    planDestinoAlExpirar: null,
    visiblePublicamente: true,
    orden: 10,
    destacado: false
  },
  basico: {
    id: "basico",
    nombre: "Básico",
    categoria: "particular",
    precio: "9,90€",
    precioDetalle: "/mes",
    anuncios: 3,
    fotos: 10,
    duracionAnunciosDias: null,
    dependeDeStripe: true,
    ilimitadoAnuncios: false,
    ilimitadoFotos: false,
    esTrial: false,
    planDestinoAlExpirar: "gratis",
    visiblePublicamente: true,
    orden: 20,
    destacado: true
  },
  destacado: {
    id: "destacado",
    nombre: "Destacado",
    categoria: "particular",
    precio: "19,90€",
    precioDetalle: "/mes",
    anuncios: 4,
    fotos: 15,
    duracionAnunciosDias: null,
    dependeDeStripe: true,
    ilimitadoAnuncios: false,
    ilimitadoFotos: false,
    esTrial: false,
    planDestinoAlExpirar: "gratis",
    visiblePublicamente: true,
    orden: 30,
    destacado: false
  },
  starter: {
    id: "starter",
    nombre: "Starter",
    categoria: "profesional",
    precio: "29,90€",
    precioDetalle: "/mes",
    anuncios: 15,
    fotos: 20,
    duracionAnunciosDias: null,
    dependeDeStripe: true,
    ilimitadoAnuncios: false,
    ilimitadoFotos: false,
    esTrial: false,
    planDestinoAlExpirar: "gratis",
    visiblePublicamente: true,
    orden: 40,
    destacado: false
  },
  pro_agentes: {
    id: "pro_agentes",
    nombre: "Pro",
    categoria: "profesional",
    precio: "59,90€",
    precioDetalle: "/mes",
    anuncios: 40,
    fotos: 30,
    duracionAnunciosDias: null,
    dependeDeStripe: true,
    ilimitadoAnuncios: false,
    ilimitadoFotos: false,
    esTrial: false,
    planDestinoAlExpirar: "gratis",
    visiblePublicamente: true,
    orden: 50,
    destacado: true
  },
  agencia_basica: {
    id: "agencia_basica",
    nombre: "Agencia Básica",
    categoria: "profesional",
    precio: "79,90€",
    precioDetalle: "/mes",
    anuncios: 50,
    fotos: 40,
    duracionAnunciosDias: null,
    dependeDeStripe: true,
    ilimitadoAnuncios: false,
    ilimitadoFotos: false,
    esTrial: false,
    planDestinoAlExpirar: "gratis",
    visiblePublicamente: true,
    orden: 60,
    destacado: false
  },
  agencia_pro: {
    id: "agencia_pro",
    nombre: "Agencia Pro",
    categoria: "profesional",
    precio: "149,90€",
    precioDetalle: "/mes",
    anuncios: Infinity,
    fotos: 50,
    duracionAnunciosDias: null,
    dependeDeStripe: false,
    ilimitadoAnuncios: true,
    ilimitadoFotos: false,
    esTrial: false,
    planDestinoAlExpirar: "gratis",
    visiblePublicamente: false,
    orden: 70,
    destacado: false
  },
  vip_trial: {
    id: "vip_trial",
    nombre: "Prueba VIP",
    categoria: "interno",
    precio: "30 días gratis",
    precioDetalle: "",
    anuncios: Infinity,
    fotos: Infinity,
    duracionAnunciosDias: null,
    dependeDeStripe: false,
    ilimitadoAnuncios: true,
    ilimitadoFotos: true,
    esTrial: true,
    planDestinoAlExpirar: "gratis",
    visiblePublicamente: false,
    orden: 80,
    destacado: false
  },
  vip: {
    id: "vip",
    nombre: "VIP",
    categoria: "interno",
    precio: "VIP",
    precioDetalle: "",
    anuncios: Infinity,
    fotos: Infinity,
    duracionAnunciosDias: null,
    dependeDeStripe: false,
    ilimitadoAnuncios: true,
    ilimitadoFotos: true,
    esTrial: false,
    planDestinoAlExpirar: null,
    visiblePublicamente: false,
    orden: 90,
    destacado: false
  }
});

export const PLAN_LIMITS = Object.freeze(Object.fromEntries(
  Object.entries(PLAN_CATALOG).map(([id, plan]) => [
    id,
    Object.freeze({
      anuncios: plan.anuncios,
      fotos: plan.fotos,
      duracionAnunciosDias: plan.duracionAnunciosDias
    })
  ])
));

export const KNOWN_PLAN_IDS = Object.freeze(Object.keys(PLAN_CATALOG));

export function getPlanLimits(plan = "gratis") {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.gratis;
}

export function getPlanConfig(plan = "gratis") {
  return PLAN_CATALOG[plan] || PLAN_CATALOG.gratis;
}

export function getKnownPlanIds() {
  return [...KNOWN_PLAN_IDS];
}

export function getStripePlanIds() {
  return KNOWN_PLAN_IDS.filter(plan => PLAN_CATALOG[plan].dependeDeStripe);
}

export function getPlanDisplayName(plan = "gratis") {
  return getPlanConfig(plan).nombre;
}

export function getLimiteAnunciosPlan(plan = "gratis") {
  return getPlanLimits(plan).anuncios;
}

export function getLimiteFotosPlan(plan = "gratis") {
  return getPlanLimits(plan).fotos;
}

export function planTieneLimiteFotos(plan = "gratis") {
  return Number.isFinite(getLimiteFotosPlan(plan));
}

export function getDuracionAnunciosDiasPlan(plan = "gratis") {
  return getPlanLimits(plan).duracionAnunciosDias || null;
}

export function calcularFechaExpiracionPlan(plan = "gratis", desde = new Date()) {
  const dias = getDuracionAnunciosDiasPlan(plan);
  if (!Number.isFinite(dias) || dias <= 0) return null;

  return new Date(new Date(desde).getTime() + dias * 24 * 60 * 60 * 1000);
}

function valorPublicoLimite(value) {
  return Number.isFinite(value) ? value : null;
}

export function getPublicPlanCatalog() {
  return KNOWN_PLAN_IDS
    .map(id => PLAN_CATALOG[id])
    .sort((a, b) => a.orden - b.orden)
    .map(plan => ({
      id: plan.id,
      nombre: plan.nombre,
      categoria: plan.categoria,
      precio: plan.precio,
      precioDetalle: plan.precioDetalle,
      anuncios: valorPublicoLimite(plan.anuncios),
      fotos: valorPublicoLimite(plan.fotos),
      duracionAnunciosDias: plan.duracionAnunciosDias,
      dependeDeStripe: plan.dependeDeStripe,
      ilimitadoAnuncios: plan.ilimitadoAnuncios,
      ilimitadoFotos: plan.ilimitadoFotos,
      esTrial: plan.esTrial,
      planDestinoAlExpirar: plan.planDestinoAlExpirar,
      visiblePublicamente: plan.visiblePublicamente,
      destacado: plan.destacado
    }));
}
