import mongoose from "mongoose";
import { randomUUID, createHash } from "node:crypto";
import Mensaje from "../models/Mensaje.js";
import Conversacion from "../models/Conversacion.js";
import Usuario from "../models/Usuario.js";
import { enviarCorreoAutomatico } from "./email.js";
import { chatId, chatRecipient, conversationUrl, chatEmailFailure } from "./chatEmail.js";

const DAY = 24 * 60 * 60 * 1000;
const LEASE = 15 * 60 * 1000;
// No timer or connection at import time. Dependencies permit entirely offline tests.
export async function sendUnreadMessageReminders({
  MensajeModel = Mensaje, ConversacionModel = Conversacion, UsuarioModel = Usuario,
  send = enviarCorreoAutomatico, now = () => new Date(), logger = console,
  startSession = () => mongoose.startSession()
} = {}) {
  const cutoff = new Date(+now() - DAY);
  const eligible = { leido: false, reminderSentAt: null, creado: { $type: "date", $lte: cutoff } };
  const stats = { sent: 0, failed: 0, skipped: 0 };
  const conversations = await MensajeModel.aggregate([
    { $match: eligible }, { $group: { _id: "$conversacionId" } }, { $limit: 100 }
  ]);
  for (const { _id: conversationId } of conversations) {
    const token = randomUUID();
    let claimed = false;
    try {
      const conv = await ConversacionModel.findOneAndUpdate({ _id: conversationId,
        $or: [{ reminderLockUntil: null }, { reminderLockUntil: { $lte: now() } }]
      }, { $set: { reminderLockToken: token, reminderLockUntil: new Date(+now() + LEASE) } }, { new: true });
      if (!conv) { stats.skipped++; continue; }
      claimed = true;
      const messages = await MensajeModel.find({ ...eligible, conversacionId: conversationId })
        .select("_id userId creado").sort({ creado: 1, _id: 1 }).limit(500).lean();
      // One recipient/batch per conversation per execution. If both sides have
      // unread messages, the other side remains eligible for a later execution.
      const first = messages.find(m => chatRecipient(conv, m.userId));
      const recipientId = first && chatRecipient(conv, first.userId);
      if (!recipientId) { stats.skipped++; continue; }
      const recipient = await UsuarioModel.findById(recipientId);
      if (!recipient?.email || recipient.activo === false) { stats.skipped++; continue; }
      const ids = messages.filter(m => chatRecipient(conv, m.userId) === recipientId).map(m => m._id);
      // Recheck read state after recipient lookup and before external delivery.
      const pending = await MensajeModel.find({ ...eligible, conversacionId: conversationId, _id: { $in: ids } })
        .select("_id").lean();
      if (!pending.length) { stats.skipped++; continue; }
      const held = await ConversacionModel.exists({ _id: conversationId, reminderLockToken: token,
        reminderLockUntil: { $gt: now() }, hiddenFor: { $nin: [recipientId] },
        deletedParticipants: { $nin: [recipientId, first.userId] } });
      if (!held) { stats.skipped++; continue; }
      const included = pending.map(m => m._id);
      const key = createHash("sha256").update(JSON.stringify([chatId(conversationId), recipientId, included.map(chatId).sort()])).digest("hex");
      const ok = await send(recipient.email, "💬 Tienes un mensaje pendiente en HomeClick24",
        "<p>Tienes mensajes pendientes de leer en esta conversación.</p>",
        { title: "Mensaje pendiente", cta: { label: "Ver conversación", url: conversationUrl(conv) }, idempotencyKey: `chat-reminder-${key}` });
      if (ok !== true) { stats.failed++; chatEmailFailure("reminder-send", logger); continue; }
      // Fence finalization in the same transaction as message marking. A stale
      // worker cannot finalize another worker's claim after lease recovery.
      const session = await startSession();
      try {
        await session.withTransaction(async () => {
          const fenced = await ConversacionModel.updateOne({ _id: conversationId,
            reminderLockToken: token, reminderLockUntil: { $gt: now() }
          }, { $unset: { reminderLockToken: "", reminderLockUntil: "" } }, { session });
          if (!fenced.matchedCount) throw new Error("CLAIM_LOST");
          // Only the included IDs, even if read during external delivery.
          await MensajeModel.updateMany({ conversacionId: conversationId, _id: { $in: included }, reminderSentAt: null },
            { $set: { reminderSentAt: now() } }, { session });
        });
      } finally { await session.endSession(); }
      stats.sent++;
    } catch {
      stats.failed++;
      chatEmailFailure("reminder-process", logger);
    } finally {
      if (claimed) {
        try {
          await ConversacionModel.updateOne({ _id: conversationId, reminderLockToken: token },
            { $unset: { reminderLockToken: "", reminderLockUntil: "" } });
        } catch { chatEmailFailure("reminder-release", logger); }
      }
    }
  }
  return stats;
}
