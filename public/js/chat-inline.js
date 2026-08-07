let currentConv = null;
let interval = null;
let currentCanReply = true;

function authHeaders(extra = {}) {
  const token = localStorage.getItem("token");
  return token ? { ...extra, Authorization: "Bearer " + token } : extra;
}

export async function abrirChat(propiedadId, anuncianteId) {
  const usuario = JSON.parse(localStorage.getItem("usuario") || "{}");
  if (!usuario._id) {
    alert("Debes iniciar sesión para escribir");
    location.href = "login";
    return;
  }

  const res = await fetch("/chat/conversaciones", {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      propiedadId,
      compradorId: usuario._id,
      anuncianteId,
    }),
  });

  currentConv = await res.json();
  if (!res.ok) {
    alert(currentConv.error || "No se pudo abrir el chat");
    return;
  }
  currentCanReply = currentConv.puedeResponder !== false;
  mostrarChatUI();
  cargarMensajes();

  interval = setInterval(cargarMensajes, 2000);
}

async function cargarMensajes() {
  if (!currentConv) return;

  const res = await fetch(
    `/chat/conversaciones/${currentConv._id}/mensajes`,
    { headers: authHeaders() }
  );
  const msgs = await res.json();

  const cont = document.getElementById("chatMensajes");
  cont.innerHTML = "";

  const usuario = JSON.parse(localStorage.getItem("usuario"));

  if (!Array.isArray(msgs)) return;

  msgs.forEach((m) => {
    const div = document.createElement("div");
    div.className = "msg " + (m.userId === usuario._id ? "me" : "them");
    div.textContent = m.texto;
    cont.appendChild(div);
  });

  cont.scrollTop = cont.scrollHeight;
}

async function enviarMensaje() {
  if (!currentCanReply) return;
  const input = document.getElementById("chatTexto");
  const texto = input.value.trim();
  if (!texto) return;

  const usuario = JSON.parse(localStorage.getItem("usuario"));

  await fetch(`/chat/conversaciones/${currentConv._id}/mensajes`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      userId: usuario._id,
      texto,
    }),
  });

  input.value = "";
  cargarMensajes();
}

function mostrarChatUI() {
  document.getElementById("chatBox").style.display = "block";
}

window.enviarMensaje = enviarMensaje;
