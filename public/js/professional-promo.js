(function () {
  const PROMO_KEY = "professional-60";
  const PROMO_INTENT_KEY = "hc24_promo_profesional_60_intent";
  const PROMO_END_ISO = "2026-10-31T22:59:59.000Z";
  const LAUNCH_PLAN_ID = "lanzamiento_2026";
  const LAUNCH_PLAN_INTENT_KEY = "hc24_launch_plan_intent";

  function promoEndDate() {
    return new Date(PROMO_END_ISO);
  }

  function isProfessionalPromoActive(now = new Date()) {
    return now.getTime() <= promoEndDate().getTime();
  }

  function hasToken() {
    const token = (localStorage.getItem("token") || "").trim();
    return Boolean(token && token !== "null" && token !== "undefined");
  }

  function isProfessionalPromoRequest() {
    return new URLSearchParams(window.location.search).get("promo") === PROMO_KEY;
  }

  function isLaunchPlanRequest() {
    const params = new URLSearchParams(window.location.search);
    return params.get("plan") === LAUNCH_PLAN_ID || params.get("activar") === LAUNCH_PLAN_ID;
  }

  function professionalPromoRegisterTarget() {
    return `/registro?promo=${PROMO_KEY}`;
  }

  function professionalPromoLoginTarget() {
    return `/login?promo=${PROMO_KEY}`;
  }

  function professionalPromoActivationTarget() {
    return `/profesionales?promo=${PROMO_KEY}`;
  }

  function professionalPromoTarget() {
    return hasToken()
      ? professionalPromoActivationTarget()
      : professionalPromoRegisterTarget();
  }

  function rememberProfessionalPromoIntent() {
    localStorage.setItem(PROMO_INTENT_KEY, "true");
  }

  function clearProfessionalPromoIntent() {
    localStorage.removeItem(PROMO_INTENT_KEY);
  }

  function clearLaunchPlanIntent() {
    localStorage.removeItem(LAUNCH_PLAN_INTENT_KEY);
  }

  function hasProfessionalPromoIntent() {
    if (isLaunchPlanRequest()) return false;
    return isProfessionalPromoRequest() || localStorage.getItem(PROMO_INTENT_KEY) === "true";
  }

  function professionalPromoLoginRedirectTarget(fallback = "/") {
    if (hasProfessionalPromoIntent()) return professionalPromoActivationTarget();
    const returnUrl = new URLSearchParams(window.location.search).get("returnUrl");
    return returnUrl && returnUrl.startsWith("/") ? returnUrl : fallback;
  }

  function handleProfessionalPromoClick(event) {
    if (event) event.preventDefault();
    rememberProfessionalPromoIntent();
    window.location.href = professionalPromoTarget();
  }

  function setupProfessionalPromo(root = document, now = new Date()) {
    const active = isProfessionalPromoActive(now);
    const professionalRequest = isProfessionalPromoRequest();

    if (isLaunchPlanRequest()) {
      clearProfessionalPromoIntent();
    } else if (professionalRequest) {
      rememberProfessionalPromoIntent();
      clearLaunchPlanIntent();
    }

    root.querySelectorAll("[data-professional-promo]").forEach(section => {
      section.hidden = !active;
      section.setAttribute("aria-hidden", active ? "false" : "true");
    });

    root.querySelectorAll("[data-professional-promo-cta]").forEach(link => {
      link.href = professionalPromoTarget();
      link.addEventListener("click", handleProfessionalPromoClick);
    });

    root.querySelectorAll("[data-professional-promo-register]").forEach(link => {
      if (professionalRequest) link.href = professionalPromoRegisterTarget();
    });

    root.querySelectorAll("[data-professional-promo-login]").forEach(link => {
      if (professionalRequest) link.href = professionalPromoLoginTarget();
    });

    root.querySelectorAll("[data-professional-promo-notice]").forEach(notice => {
      notice.hidden = !professionalRequest;
    });
  }

  window.HomeClickProfessionalPromo = {
    PROMO_KEY,
    PROMO_INTENT_KEY,
    PROMO_END_ISO,
    isProfessionalPromoActive,
    isProfessionalPromoRequest,
    isLaunchPlanRequest,
    professionalPromoRegisterTarget,
    professionalPromoLoginTarget,
    professionalPromoActivationTarget,
    professionalPromoTarget,
    rememberProfessionalPromoIntent,
    clearProfessionalPromoIntent,
    hasProfessionalPromoIntent,
    professionalPromoLoginRedirectTarget,
    handleProfessionalPromoClick,
    setupProfessionalPromo
  };

  document.addEventListener("DOMContentLoaded", () => setupProfessionalPromo());
})();
