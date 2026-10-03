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
    return params.get("plan") === LAUNCH_PLAN_ID
      || params.get("activar") === LAUNCH_PLAN_ID
      || isProfessionalPromoRequest();
  }

  function professionalPromoRegisterTarget() {
    return `/registro?plan=${LAUNCH_PLAN_ID}`;
  }

  function professionalPromoLoginTarget() {
    return `/login?plan=${LAUNCH_PLAN_ID}`;
  }

  function professionalPromoActivationTarget() {
    return `/planes?activar=${LAUNCH_PLAN_ID}`;
  }

  function professionalPromoTarget() {
    return hasToken()
      ? professionalPromoActivationTarget()
      : professionalPromoRegisterTarget();
  }

  function rememberProfessionalPromoIntent() {
    clearProfessionalPromoIntent();
    localStorage.setItem(LAUNCH_PLAN_INTENT_KEY, "true");
  }

  function clearProfessionalPromoIntent() {
    localStorage.removeItem(PROMO_INTENT_KEY);
  }

  function hasProfessionalPromoIntent() {
    return false;
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
    const professionalRequest = isProfessionalPromoRequest();

    if (isLaunchPlanRequest()) {
      clearProfessionalPromoIntent();
    }

    root.querySelectorAll("[data-professional-promo]").forEach(section => {
      section.hidden = true;
      section.setAttribute("aria-hidden", "true");
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
      notice.hidden = true;
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
