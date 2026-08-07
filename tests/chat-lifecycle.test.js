import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.JWT_SECRET = "test-secret";
process.env.RESEND_API_KEY = "re_test";

const chatSource = fs.readFileSync(new URL("../routes/chat.js", import.meta.url), "utf8");
const chatHtml = fs.readFileSync(new URL("../public/chat.html", import.meta.url), "utf8");
const perfilHtml = fs.readFileSync(new URL("../public/perfil.html", import.meta.url), "utf8");
const perfilJs = fs.readFileSync(new URL("../public/js/perfil.js", import.meta.url), "utf8");
const adminSource = fs.readFileSync(new URL("../routes/admin.js", import.meta.url), "utf8");

const {
  esParticipante,
  usuarioEliminoConversacion,
  participanteFueEliminado
} = await import("../routes/chat.js");

test("helpers de conversación identifican participantes, ocultos y eliminados", () => {
  const conv = {
    compradorId: "507f1f77bcf86cd799439011",
    anuncianteId: "507f1f77bcf86cd799439022",
    hiddenFor: ["507f1f77bcf86cd799439011"],
    deletedParticipants: [{ _id: "507f1f77bcf86cd799439022" }]
  };

  assert.equal(esParticipante(conv, "507f1f77bcf86cd799439011"), true);
  assert.equal(esParticipante(conv, "507f1f77bcf86cd799439033"), false);
  assert.equal(usuarioEliminoConversacion(conv, "507f1f77bcf86cd799439011"), true);
  assert.equal(usuarioEliminoConversacion(conv, "507f1f77bcf86cd799439033"), false);
  assert.equal(participanteFueEliminado(conv, "507f1f77bcf86cd799439022"), true);
});

test("rutas de chat eliminan solo mensajes propios con filtro condicional", () => {
  const messageDeleteBlock = chatSource.match(/router\.delete\("\/conversaciones\/:id\/mensajes\/:mensajeId"[\s\S]*?^\}\);/m)?.[0] || "";
  assert.match(chatSource, /router\.delete\("\/conversaciones\/:id\/mensajes\/:mensajeId", requireAuth/);
  assert.match(messageDeleteBlock, /String\(mensaje\.userId\) !== String\(req\.user\.id\)/);
  assert.match(messageDeleteBlock, /Mensaje\.deleteOne\(\{ _id: req\.params\.mensajeId, conversacionId: req\.params\.id, userId: req\.user\.id \}\)/);
  assert.doesNotMatch(messageDeleteBlock, /Mensaje\.deleteMany/);
});

test("borrar conversación oculta para el usuario y solo borra físicamente si todos la ocultaron", () => {
  assert.match(chatSource, /router\.delete\("\/conversaciones\/:id", requireAuth/);
  assert.match(chatSource, /\$addToSet: \{ hiddenFor: req\.user\.id \}/);
  assert.match(chatSource, /participantes\.every\(participanteId => hidden\.has\(participanteId\)\)/);
  assert.match(chatSource, /Mensaje\.deleteMany\(\{ conversacionId: req\.params\.id \}\)/);
  assert.match(chatSource, /Conversacion\.deleteOne\(\{ _id: req\.params\.id \}\)/);
});

test("lecturas y no leídos excluyen conversaciones ocultas del historial propio", () => {
  assert.match(chatSource, /hiddenFor: \{ \$nin: \[userId\] \}/);
  assert.match(chatSource, /usuarioEliminoConversacion\(conv, req\.user\.id\)/);
  assert.match(chatSource, /usuarioEliminoConversacion\(conv, userId\)/);
  assert.match(chatSource, /Conversacion\.find\(\{\s*\$or: \[\{ anuncianteId: userId \}, \{ compradorId: userId \}\],\s*hiddenFor: \{ \$nin: \[userId\] \}/);
});

test("chat bloquea respuestas hacia participantes eliminados o conversaciones ocultas", () => {
  assert.match(chatSource, /export async function puedeResponderConversacion/);
  assert.match(chatSource, /usuarioEliminoConversacion\(conv, userId\)/);
  assert.match(chatSource, /participanteFueEliminado\(conv, userId\)/);
  assert.match(chatSource, /No se puede responder a esta conversación/);
  assert.match(chatSource, /La cuenta no está disponible/);
});

test("propiedad eliminada e interlocutor eliminado se exponen con etiquetas genéricas", () => {
  assert.match(chatSource, /Anuncio no disponible/);
  assert.match(chatSource, /Usuario eliminado/);
  assert.match(chatSource, /interlocutorEliminado/);
  assert.match(chatSource, /propiedadDisponible/);
  assert.doesNotMatch(chatSource.match(/router\.get\("\/conversaciones\/:id"[\s\S]*?^\}\);/m)?.[0] || "", /email:/);
});

test("interfaz de chat permite borrar mensaje propio y conversación del historial propio", () => {
  assert.match(chatHtml, /Eliminar mensaje/);
  assert.match(chatHtml, /Eliminar conversación/);
  assert.match(chatHtml, /method: "DELETE"/);
  assert.match(chatHtml, /data-delete-message/);
  assert.match(chatHtml, /La otra persona podrá seguir conservando su copia/);
  assert.match(chatHtml, /escapeHtml\(m\.texto\)/);
});

test("interfaz desactiva envío cuando el otro participante fue eliminado", () => {
  assert.match(chatHtml, /Usuario eliminado/);
  assert.match(chatHtml, /puedeResponderActual/);
  assert.match(chatHtml, /desactivarEnvio/);
  assert.match(chatHtml, /No se puede responder a un usuario eliminado/);
});

test("perfil renderiza usuarios eliminados de forma genérica y escapa nombres", () => {
  assert.match(perfilHtml, /c\.interlocutorEliminado/);
  assert.match(perfilHtml, /Usuario eliminado/);
  assert.match(perfilHtml, /escapeHtml\(nombreInterlocutor\)/);
  assert.match(perfilJs, /c\.interlocutorEliminado/);
  assert.match(perfilJs, /escapeHtml\(nombreInterlocutor\)/);
});

test("eliminación administrativa preserva mensajes ajenos y marca participante eliminado", () => {
  const deleteBlock = adminSource.match(/export async function eliminarUsuarioDesactivadoSeguro[\s\S]*?^}/m)?.[0] || "";
  assert.match(adminSource, /deletedParticipants: targetUserId, hiddenFor: targetUserId/);
  assert.match(adminSource, /models\.Mensaje\.deleteMany\(\{ conversacionId, userId: targetUserId \}\)/);
  assert.match(adminSource, /contarDocumento\(models\.Mensaje, \{ conversacionId \}, session\)/);
  assert.match(adminSource, /models\.Conversacion\.deleteOne/);
  assert.doesNotMatch(deleteBlock, /models\.Mensaje\.deleteMany\(\{ conversacionId \}\)/);
  assert.doesNotMatch(deleteBlock, /stripe\.|subscriptions\.|new Stripe/);
});
