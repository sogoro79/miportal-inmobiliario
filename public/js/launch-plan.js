(function () {
  const PLAN_ID = "lanzamiento_2026";
  const INTENT_KEY = "hc24_launch_plan_intent";
  const END_ISO = "2027-01-31T22:59:59.000Z";

  function hasToken() {
    const token = (localStorage.getItem("token") || "").trim();
    return Boolean(token && token !== "null" && token !== "undefined");
  }

  function isLaunchPlanAvailable(now = new Date()) {
    return now.getTime() <= new Date(END_ISO).getTime();
  }

  function isLaunchPlanRequest() {
    const params = new URLSearchParams(window.location.search);
    return params.get("plan") === PLAN_ID || params.get("activar") === PLAN_ID;
  }

  function rememberLaunchPlanIntent() {
    localStorage.setItem(INTENT_KEY, "true");
  }

  function hasLaunchPlanIntent() {
    return isLaunchPlanRequest() || localStorage.getItem(INTENT_KEY) === "true";
  }

  function launchPlanRegisterTarget() {
    return `/registro?plan=${PLAN_ID}`;
  }

  function launchPlanLoginTarget() {
    return `/login?plan=${PLAN_ID}`;
  }

  function launchPlanActivationTarget() {
    return `/planes?activar=${PLAN_ID}`;
  }

  function launchPlanTarget() {
    return hasToken() ? launchPlanActivationTarget() : launchPlanRegisterTarget();
  }

  function launchPlanLoginRedirectTarget(fallback = "/") {
    if (hasLaunchPlanIntent()) return launchPlanActivationTarget();
    const returnUrl = new URLSearchParams(window.location.search).get("returnUrl");
    return returnUrl && returnUrl.startsWith("/") ? returnUrl : fallback;
  }

  function handleLaunchPlanClick(event) {
    if (event) event.preventDefault();
    rememberLaunchPlanIntent();
    window.location.href = launchPlanTarget();
  }

  function setupLaunchPlan(root = document, now = new Date()) {
    const active = isLaunchPlanAvailable(now);
    if (isLaunchPlanRequest()) rememberLaunchPlanIntent();

    root.querySelectorAll("[data-launch-plan]").forEach(section => {
      section.hidden = !active;
      section.setAttribute("aria-hidden", active ? "false" : "true");
    });

    root.querySelectorAll("[data-launch-plan-cta]").forEach(link => {
      link.href = launchPlanTarget();
      link.addEventListener("click", handleLaunchPlanClick);
    });

    root.querySelectorAll("[data-launch-plan-register]").forEach(link => {
      link.href = launchPlanRegisterTarget();
    });

    root.querySelectorAll("[data-launch-plan-login]").forEach(link => {
      link.href = launchPlanLoginTarget();
    });

    root.querySelectorAll("[data-launch-plan-notice]").forEach(notice => {
      notice.hidden = !hasLaunchPlanIntent();
    });
  }

  window.HomeClickLaunchPlan = {
    PLAN_ID,
    INTENT_KEY,
    END_ISO,
    isLaunchPlanAvailable,
    isLaunchPlanRequest,
    rememberLaunchPlanIntent,
    hasLaunchPlanIntent,
    launchPlanRegisterTarget,
    launchPlanLoginTarget,
    launchPlanActivationTarget,
    launchPlanTarget,
    launchPlanLoginRedirectTarget,
    handleLaunchPlanClick,
    setupLaunchPlan
  };

  document.addEventListener("DOMContentLoaded", () => setupLaunchPlan());
})();
