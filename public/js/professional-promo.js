(function () {
  const PROMO_KEY = "professional-60";
  const PROMO_INTENT_KEY = "hc24_promo_profesional_60_intent";
  const PROMO_END_ISO = "2026-10-31T22:59:59.000Z";

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

  function hasProfessionalPromoIntent() {
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
    if (isProfessionalPromoRequest()) rememberProfessionalPromoIntent();

    root.querySelectorAll("[data-professional-promo]").forEach(section => {
      section.hidden = !active;
      section.setAttribute("aria-hidden", active ? "false" : "true");
    });

    root.querySelectorAll("[data-professional-promo-cta]").forEach(link => {
      link.href = professionalPromoTarget();
      link.addEventListener("click", handleProfessionalPromoClick);
    });

    root.querySelectorAll("[data-professional-promo-register]").forEach(link => {
      link.href = professionalPromoRegisterTarget();
    });

    root.querySelectorAll("[data-professional-promo-login]").forEach(link => {
      link.href = professionalPromoLoginTarget();
    });

    root.querySelectorAll("[data-professional-promo-notice]").forEach(notice => {
      notice.hidden = !hasProfessionalPromoIntent();
    });
  }

  window.HomeClickProfessionalPromo = {
    PROMO_KEY,
    PROMO_INTENT_KEY,
    PROMO_END_ISO,
    isProfessionalPromoActive,
    isProfessionalPromoRequest,
    professionalPromoRegisterTarget,
    professionalPromoLoginTarget,
    professionalPromoActivationTarget,
    professionalPromoTarget,
    rememberProfessionalPromoIntent,
    hasProfessionalPromoIntent,
    professionalPromoLoginRedirectTarget,
    handleProfessionalPromoClick,
    setupProfessionalPromo
  };

  document.addEventListener("DOMContentLoaded", () => setupProfessionalPromo());
})();
