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

  function professionalPromoTarget() {
    return hasToken()
      ? `/profesionales?promo=${PROMO_KEY}`
      : `/registro?promo=${PROMO_KEY}`;
  }

  function rememberProfessionalPromoIntent() {
    localStorage.setItem(PROMO_INTENT_KEY, "true");
  }

  function handleProfessionalPromoClick(event) {
    if (event) event.preventDefault();
    rememberProfessionalPromoIntent();
    window.location.href = professionalPromoTarget();
  }

  function setupProfessionalPromo(root = document, now = new Date()) {
    const active = isProfessionalPromoActive(now);
    root.querySelectorAll("[data-professional-promo]").forEach(section => {
      section.hidden = !active;
      section.setAttribute("aria-hidden", active ? "false" : "true");
    });

    root.querySelectorAll("[data-professional-promo-cta]").forEach(link => {
      link.href = professionalPromoTarget();
      link.addEventListener("click", handleProfessionalPromoClick);
    });
  }

  window.HomeClickProfessionalPromo = {
    PROMO_KEY,
    PROMO_INTENT_KEY,
    PROMO_END_ISO,
    isProfessionalPromoActive,
    professionalPromoTarget,
    rememberProfessionalPromoIntent,
    handleProfessionalPromoClick,
    setupProfessionalPromo
  };

  document.addEventListener("DOMContentLoaded", () => setupProfessionalPromo());
})();
