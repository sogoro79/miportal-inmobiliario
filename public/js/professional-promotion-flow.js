(function () {
  const PROMO_PARAM = "professional-60";
  const STATUS_URL = "/api/promocion-profesional/estado";
  const ACTIVATE_URL = "/api/promocion-profesional/activar";

  function hasPromoIntent() {
    const params = new URLSearchParams(window.location.search);
    return params.get("promo") === PROMO_PARAM ||
      localStorage.getItem("hc24_promo_profesional_60_intent") === "true";
  }

  function authToken() {
    const token = (localStorage.getItem("token") || "").trim();
    return token && token !== "null" && token !== "undefined" ? token : "";
  }

  function text(node, value) {
    if (node) node.textContent = value;
  }

  function setPanelState(panel, state) {
    panel.querySelectorAll("[data-promo-state]").forEach(item => {
      item.hidden = item.getAttribute("data-promo-state") !== state;
    });
  }

  function renderInactiveCopy(panel) {
    text(panel.querySelector("[data-promo-title]"), "Activa tu Promoción Profesional 60 días");
    text(
      panel.querySelector("[data-promo-description]"),
      "Disfruta de un plan profesional sin límites durante 60 días. Es gratis, sin tarjeta, sin permanencia y sin renovación automática."
    );
    const requirements = panel.querySelector("[data-promo-requirements]");
    if (requirements) {
      requirements.hidden = false;
      requirements.textContent = "La activación requiere email verificado, móvil, NIF/DNI/NIE profesional y aceptación expresa de condiciones.";
    }
  }

  function renderActiveCopy(panel, endsAt = "") {
    text(panel.querySelector("[data-promo-title]"), "Tu Promoción Profesional 60 días está activa");
    text(
      panel.querySelector("[data-promo-description]"),
      endsAt
        ? `Disfruta de prestaciones profesionales sin límites hasta el ${endsAt}.`
        : "Disfruta de prestaciones profesionales sin límites durante el periodo promocional."
    );
    const requirements = panel.querySelector("[data-promo-requirements]");
    if (requirements) requirements.hidden = true;
    text(
      panel.querySelector("[data-promo-active-description]"),
      endsAt
        ? `Fecha de fin: ${endsAt}.`
        : "Fecha de fin visible en el estado de la promoción."
    );
  }

  async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data.error || "No se pudo procesar la promoción.");
      error.code = data.code || "error";
      throw error;
    }
    return data;
  }

  function formData(form) {
    return {
      nombreComercial: form.nombreComercial.value.trim(),
      responsableNombre: form.responsableNombre.value.trim(),
      tipoProfesional: form.tipoProfesional.value,
      telefonoMovil: form.telefonoMovil.value.trim(),
      documento: form.documento.value.trim(),
      aceptaCondiciones: form.aceptaCondiciones.checked
    };
  }

  function prefillForm(form, usuario = {}) {
    if (!form || !usuario) return;
    if (!form.nombreComercial.value) form.nombreComercial.value = usuario.nombreComercial || "";
    if (!form.responsableNombre.value) form.responsableNombre.value = usuario.nombre || "";
    if (!form.tipoProfesional.value) form.tipoProfesional.value = usuario.tipoProfesional || "";
    if (!form.telefonoMovil.value) form.telefonoMovil.value = usuario.telefonoMovil || "";
    if (!form.documento.value) form.documento.value = usuario.numDoc || "";
  }

  function renderStatus(panel, status) {
    const message = panel.querySelector("[data-promo-message]");
    const endsAt = status.endsAt ? new Date(status.endsAt).toLocaleDateString("es-ES") : "";
    if (status.promocionActiva) {
      setPanelState(panel, "active");
      renderActiveCopy(panel, endsAt);
      text(message, endsAt ? `Ya disfrutas de la Promoción Profesional 60 días hasta el ${endsAt}.` : "Ya disfrutas de la Promoción Profesional 60 días.");
      return;
    }
    renderInactiveCopy(panel);
    if (!status.campaignActive) {
      setPanelState(panel, "blocked");
      text(message, "Esta promoción ya ha finalizado.");
      return;
    }
    if (status.planPagoIncompatible) {
      setPanelState(panel, "blocked");
      text(message, "Ya tienes un plan activo.");
      return;
    }
    if (status.emailNoVerificado) {
      setPanelState(panel, "blocked");
      text(message, "Verifica tu correo electrónico antes de activar la promoción.");
      return;
    }
    if (status.promocionYaUtilizada || status.documentoYaUsado || status.movilYaUsado || status.adminNoElegible) {
      setPanelState(panel, "blocked");
      text(message, "No es posible activar esta promoción con los datos facilitados.");
      return;
    }
    setPanelState(panel, "form");
    text(message, "Completa tus datos profesionales para continuar.");
  }

  async function initProfessionalPromotionFlow() {
    const panel = document.querySelector("[data-professional-promotion-flow]");
    if (!panel || !hasPromoIntent()) return;
    panel.hidden = false;

    const token = authToken();
    if (!token) {
      setPanelState(panel, "visitor");
      return;
    }

    const form = panel.querySelector("form");
    const message = panel.querySelector("[data-promo-message]");
    try {
      const usuario = await fetchJson("/usuarios/me", {
        headers: { Authorization: `Bearer ${token}` }
      });
      prefillForm(form, usuario);
      const status = await fetchJson(STATUS_URL, {
        headers: { Authorization: `Bearer ${token}` }
      });
      renderStatus(panel, status);
    } catch (error) {
      setPanelState(panel, "blocked");
      text(message, error.message || "No se pudo consultar el estado de la promoción.");
    }

    form?.addEventListener("submit", async event => {
      event.preventDefault();
      const confirmation = "Activarás la Promoción Profesional 60 días. Es gratuita, no requiere tarjeta y no se renovará automáticamente.\n\nEsta promoción solo puede utilizarse una vez por profesional o empresa.";
      if (!window.confirm(confirmation)) return;

      const button = form.querySelector("button[type='submit']");
      const previousText = button.textContent;
      button.disabled = true;
      button.textContent = "Activando...";
      try {
        const result = await fetchJson(ACTIVATE_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(formData(form))
        });
        setPanelState(panel, "active");
        const endsAt = result.endsAt ? new Date(result.endsAt).toLocaleDateString("es-ES") : "";
        text(message, endsAt ? `Promoción activada hasta el ${endsAt}.` : "Promoción activada.");
      } catch (error) {
        text(message, error.message || "No es posible activar esta promoción con los datos facilitados.");
      } finally {
        button.disabled = false;
        button.textContent = previousText;
      }
    });
  }

  document.addEventListener("DOMContentLoaded", initProfessionalPromotionFlow);
})();
