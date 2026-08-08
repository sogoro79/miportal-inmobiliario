const API_BASE = location.hostname.includes("localhost")
  ? "http://localhost:3000"
  : "https://www.homeclick24.com";

function mostrarMensaje(texto, color = "red") {
  const el = document.getElementById("mensaje");
  if (el) { el.textContent = texto; el.style.color = color; }
}

/* ================================
   REGISTRO
================================ */
async function registro() {
  const nombre = document.getElementById("nombre").value.trim();
  const email  = document.getElementById("email").value.trim();
  const pass   = document.getElementById("pass").value.trim();
  const btn    = document.getElementById("btnRegistro");

  if (!nombre || !email || !pass) {
    mostrarMensaje("⚠️ Rellena todos los campos");
    return;
  }

  if (pass.length < 6) {
    mostrarMensaje("⚠️ La contraseña debe tener al menos 6 caracteres");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Creando cuenta...";

  const res  = await fetch(`${API_BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nombre, email, password: pass })
  });

  const data = await res.json();

  if (!res.ok) {
    mostrarMensaje(data.error || "Error al registrarte");
    btn.disabled = false;
    btn.textContent = "Crear cuenta";
    return;
  }

  mostrarMensaje("✅ Cuenta creada. Redirigiendo...", "green");
  setTimeout(() => location.href = "/login", 1500);
}

/* ================================
   LOGIN
================================ */
async function login() {
  const email = document.getElementById("email").value.trim();
  const pass  = document.getElementById("pass").value.trim();
  const btn   = document.getElementById("btnLogin");

  if (!email || !pass) {
    mostrarMensaje("⚠️ Rellena todos los campos");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Entrando...";

  const res  = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: pass })
  });

  const data = await res.json();

  if (!res.ok) {
    mostrarMensaje(data.error || "Credenciales incorrectas");
    btn.disabled = false;
    btn.textContent = "Iniciar sesión";
    return;
  }

  const token = (data.token || "").trim();
  if (!token || token === "null" || token === "undefined") {
    localStorage.removeItem("token");
    localStorage.removeItem("usuario");
    mostrarMensaje("No se ha podido iniciar sesión correctamente. Inténtalo de nuevo.");
    btn.disabled = false;
    btn.textContent = "Iniciar sesión";
    return;
  }

  localStorage.setItem("token", token);
  localStorage.setItem("usuario", JSON.stringify(data.usuario));

  mostrarMensaje("✅ Sesión iniciada. Redirigiendo...", "green");
  const destino = window.HomeClickProfessionalPromo?.professionalPromoLoginRedirectTarget
    ? window.HomeClickProfessionalPromo.professionalPromoLoginRedirectTarget("/")
    : (() => {
        const returnUrl = new URLSearchParams(window.location.search).get("returnUrl");
        return returnUrl && returnUrl.startsWith("/") ? returnUrl : "/";
      })();
  setTimeout(() => location.href = destino, 1000);
}
