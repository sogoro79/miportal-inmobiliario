import Usuario from "../models/Usuario.js";
import Propiedad from "../models/Propiedad.js";
import { enviarCorreoAutomatico, escapeEmailHtml, textToEmailHtml } from "./email.js";

export const chatId = value => value == null ? "" : String(value._id || value);
export function chatRecipient(conv, sender) {
  const from = chatId(sender), buyer = chatId(conv?.compradorId), owner = chatId(conv?.anuncianteId);
  if (!from || !buyer || !owner || buyer === owner) return null;
  const recipient = from === buyer ? owner : from === owner ? buyer : null;
  if (!recipient || (conv.deletedParticipants || []).some(id => [from, recipient].includes(chatId(id))) ||
      (conv.hiddenFor || []).some(id => chatId(id) === recipient)) return null;
  return recipient;
}
export function chatEmailFailure(phase, logger = console) {
  logger.warn("[Chat email]", { phase, provider: "email", safeCode: "CHAT_EMAIL_FAILED" });
}
export const conversationUrl = conv => `https://www.homeclick24.com/chat?id=${encodeURIComponent(chatId(conv._id))}`;

// Called only after Mensaje.create succeeds. Delivery can never undo the message.
export async function notifyChatMessage(conv, message, {
  UsuarioModel = Usuario, PropiedadModel = Propiedad, send = enviarCorreoAutomatico, logger = console
} = {}) {
  try {
    const recipientId = chatRecipient(conv, message.userId);
    if (!recipientId) return false;
    const recipient = await UsuarioModel.findById(recipientId);
    if (!recipient?.email || recipient.activo === false) return false;
    const sender = await UsuarioModel.findById(message.userId);
    const property = await PropiedadModel.findById(conv.propiedadId);
    const reply = chatId(message.userId) === chatId(conv.anuncianteId);
    const subject = reply ? "💬 Has recibido una respuesta en HomeClick24" : "💬 Tienes un nuevo mensaje en HomeClick24";
    const ok = await send(recipient.email, subject,
      `<p><strong>${escapeEmailHtml(sender?.nombre || "Un usuario")}</strong> te ha escrito sobre ${escapeEmailHtml(property?.titulo || "el anuncio")}.</p><p>${textToEmailHtml(String(message.texto || "").slice(0, 400))}</p>`,
      { title: reply ? "Nueva respuesta" : "Nuevo mensaje", cta: { label: reply ? "Ver conversación" : "Ver mensaje", url: conversationUrl(conv) } });
    if (ok !== true) chatEmailFailure("immediate-send", logger);
    return ok === true;
  } catch {
    chatEmailFailure("immediate-send", logger);
    return false;
  }
}
