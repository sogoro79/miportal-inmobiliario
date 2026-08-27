import express from "express";
import mongoose from "mongoose";
import { Resend } from "resend";
import Propiedad from "../models/Propiedad.js";
import EstadisticaAnuncio from "../models/EstadisticaAnuncio.js";
import Usuario from "../models/Usuario.js";
import Conversacion from "../models/Conversacion.js";
import Mensaje from "../models/Mensaje.js";
import { requireAuth } from "../middleware/auth.js";
import { cleanString, isObjectId, objectId, validateBody, z } from "../utils/validation.js";
import { securityRateLimits } from "../utils/security.js";

const router = express.Router();

/* ======================
   NODEMAILER
====================== */
const resend = new Resend(process.env.RESEND_API_KEY);

/* ======================
   SCHEMAS
====================== */
const crearConversacionSchema = z.object({
  propiedadId: objectId,
  anuncianteId: objectId.optional(),
  compradorId: objectId.optional()
}).strict();

const mensajeSchema = z.object({
  userId: objectId.optional(),
  texto: cleanString(2000)
}).strict();

const leerSchema = z.object({
  userId: objectId.optional()
}).strict();

export function esParticipante(conv, userId) {
  return String(conv.anuncianteId) === userId || String(conv.compradorId) === userId;
}

function idStr(value) {
  return String(value?._id || value || "");
}

function idsIncluyen(lista = [], userId) {
  const actual = idStr(userId);
  return (lista || []).some(item => idStr(item) === actual);
}

export function usuarioEliminoConversacion(conv, userId) {
  return idsIncluyen(conv?.hiddenFor, userId);
}

export function participanteFueEliminado(conv, userId) {
  return idsIncluyen(conv?.deletedParticipants, userId);
}

function participantesConversacion(conv) {
  return [idStr(conv.compradorId), idStr(conv.anuncianteId)].filter(Boolean);
}

function otroParticipanteId(conv, userId) {
  return String(conv.compradorId) === String(userId) ? idStr(conv.anuncianteId) : idStr(conv.compradorId);
}

async function cargarParticipanteSeguro(conv, participanteId, nombreFallback) {
  const eliminadoMarcado = participanteFueEliminado(conv, participanteId);
  if (eliminadoMarcado) {
    return { nombre: "Usuario eliminado", eliminado: true };
  }
  try {
    const usuario = await Usuario.findById(participanteId);
    if (!usuario || usuario.activo === false) {
      return { nombre: "Usuario eliminado", eliminado: true };
    }
    return { nombre: usuario.nombre || nombreFallback, eliminado: false };
  } catch {
    return { nombre: "Usuario eliminado", eliminado: true };
  }
}

async function cargarOtroParticipante(conv, userId) {
  const otherId = otroParticipanteId(conv, userId);
  if (!otherId || participanteFueEliminado(conv, otherId)) {
    return { eliminado: true, usuario: null };
  }
  try {
    const usuario = await Usuario.findById(otherId);
    if (!usuario || usuario.activo === false) return { eliminado: true, usuario: null };
    return { eliminado: false, usuario };
  } catch {
    return { eliminado: true, usuario: null };
  }
}

export async function puedeResponderConversacion(conv, userId) {
  if (!conv || !esParticipante(conv, String(userId))) return false;
  if (usuarioEliminoConversacion(conv, userId)) return false;
  if (participanteFueEliminado(conv, userId)) return false;
  const otro = await cargarOtroParticipante(conv, userId);
  return !otro.eliminado;
}

function aplicarSesion(queryOrPromise, session) {
  return queryOrPromise && session && typeof queryOrPromise.session === "function"
    ? queryOrPromise.session(session)
    : queryOrPromise;
}

async function runTransaction(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

function inicioDia(fecha = new Date()) {
  const dia = new Date(fecha);
  dia.setHours(0, 0, 0, 0);
  return dia;
}

/* ======================
   CREAR / OBTENER CONVERSACIÓN
====================== */
router.post("/conversaciones", requireAuth, validateBody(crearConversacionSchema), async (req, res) => {
  try {
    const { propiedadId } = req.body;
    const compradorId = req.user.id;

    if (req.body.compradorId && String(req.body.compradorId) !== compradorId) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const propiedad = await Propiedad.findById(propiedadId);
    if (!propiedad) return res.status(404).json({ error: "Propiedad no encontrada" });
    if (!propiedad.usuarioId) {
      return res.status(403).json({ error: "Esta propiedad no tiene anunciante asignado" });
    }

    const anuncianteId = propiedad.usuarioId;
    if (String(anuncianteId) === compradorId) {
      return res.status(403).json({ error: "Este anuncio es tuyo." });
    }

    const anunciante = await Usuario.findById(anuncianteId);
    if (!anunciante || anunciante.activo === false) {
      return res.status(403).json({ error: "La cuenta no está disponible" });
    }

    let conv = await Conversacion.findOne({ propiedadId, anuncianteId, compradorId });
    if (!conv) {
      conv = await Conversacion.create({ propiedadId, anuncianteId, compradorId });
      // Incrementar contactos solo cuando es una conversación nueva
      await Propiedad.findByIdAndUpdate(propiedadId, {
        $inc: { contactos: 1 },
        $set: { ultimoContacto: new Date() }
      });
      await EstadisticaAnuncio.updateOne(
        { propiedadId, fecha: inicioDia() },
        {
          $setOnInsert: { usuarioId: propiedad.usuarioId },
          $inc: { contactos: 1 }
        },
        { upsert: true }
      );
    } else if (usuarioEliminoConversacion(conv, compradorId)) {
      await Conversacion.updateOne(
        { _id: conv._id, compradorId },
        { $pull: { hiddenFor: compradorId } }
      );
      conv = await Conversacion.findById(conv._id);
    }

    res.json(conv);
  } catch(e) {
    res.status(400).json({ error: "Datos de conversación inválidos" });
  }
});

/* ======================
   MENSAJES
====================== */
router.get("/conversaciones/:id/mensajes", requireAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) {
      return res.status(400).json({ error: "ID inválido" });
    }

    const conv = await Conversacion.findById(req.params.id);
    if (!conv) return res.status(404).json({ error: "No encontrada" });
    if (!esParticipante(conv, req.user.id)) return res.status(403).json({ error: "No autorizado" });
    if (usuarioEliminoConversacion(conv, req.user.id)) return res.status(404).json({ error: "No encontrada" });

    const msgs = await Mensaje.find({ conversacionId: req.params.id }).sort({ creado: 1 });
    res.json(msgs);
  } catch(e) {
    res.status(400).json({ error: "ID inválido" });
  }
});

router.post("/conversaciones/:id/mensajes", requireAuth, securityRateLimits.chatMessage, validateBody(mensajeSchema), async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) {
      return res.status(400).json({ error: "ID inválido" });
    }

    const { texto } = req.body;
    const userId = req.user.id;
    if (req.body.userId && String(req.body.userId) !== userId) {
      return res.status(403).json({ error: "No autorizado" });
    }
    const conv = await Conversacion.findById(req.params.id);
    if (!conv) return res.status(404).json({ error: "No encontrada" });
    if (!esParticipante(conv, userId)) return res.status(403).json({ error: "No autorizado" });
    if (!(await puedeResponderConversacion(conv, userId))) {
      return res.status(403).json({ error: "No se puede responder a esta conversación" });
    }

    const msg = await Mensaje.create({ conversacionId: req.params.id, userId, texto });

    // ── Notificación por email al anunciante ──
    try {
      // Solo notificar si quien escribe es el comprador (no el anunciante a sí mismo)
      if (conv && conv.anuncianteId !== userId) {
        const anunciante = await Usuario.findById(conv.anuncianteId);
        const comprador  = await Usuario.findById(userId);
        const propiedad  = await Propiedad.findById(conv.propiedadId);

        if (anunciante?.email) {
          await resend.emails.send({
            from: 'HomeClick24 <contacto@homeclick24.com>',
            to: anunciante.email,
            subject: "💬 Tienes un nuevo mensaje en HomeClick24",
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 500px; margin: auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;">
                <div style="background: #7cc242; padding: 20px; text-align: center;">
                  <h2 style="color: white; margin: 0;">HomeClick24</h2>
                </div>
                <div style="padding: 24px;">
                  <p style="font-size: 16px;">Hola <strong>${anunciante.nombre || "anunciante"}</strong>,</p>
                  <p>Has recibido un nuevo mensaje sobre tu propiedad:</p>
                  <div style="background: #f3f4f6; border-radius: 6px; padding: 12px; margin: 16px 0;">
                    <p style="margin: 0; font-weight: bold;">🏠 ${propiedad?.titulo || "Tu propiedad"}</p>
                  </div>
                  <div style="background: #f0fae5; border-left: 4px solid #7cc242; padding: 12px; border-radius: 4px; margin: 16px 0;">
                    <p style="margin: 0; color: #4a7c24;"><strong>${comprador?.nombre || "Un usuario"}:</strong></p>
                    <p style="margin: 8px 0 0;">"${texto}"</p>
                  </div>
                  <a href="https://www.homeclick24.com/chat"
                     style="display: inline-block; background: #7cc242; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; margin-top: 8px;">
                   Ver mensaje
                  </a>
                  <p style="font-size: 12px; color: #9ca3af; margin-top: 24px;">HomeClick24 · No respondas a este email</p>
                </div>
              </div>
            `
          });
        }
      }
    } catch(emailErr) {
      console.error("Error enviando email:", emailErr);
      // No bloqueamos la respuesta aunque falle el email
    }

    res.json(msg);
  } catch(e) {
    res.status(500).json({ error: "Error al enviar mensaje" });
  }
});

router.delete("/conversaciones/:id/mensajes/:mensajeId", requireAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id) || !isObjectId(req.params.mensajeId)) {
      return res.status(400).json({ error: "ID inválido" });
    }

    const conv = await Conversacion.findById(req.params.id);
    if (!conv) return res.status(404).json({ error: "No encontrada" });
    if (!esParticipante(conv, req.user.id)) return res.status(403).json({ error: "No autorizado" });
    if (usuarioEliminoConversacion(conv, req.user.id)) return res.status(404).json({ error: "No encontrada" });

    const mensaje = await Mensaje.findById(req.params.mensajeId);
    if (!mensaje || String(mensaje.conversacionId) !== String(req.params.id)) {
      return res.status(404).json({ error: "Mensaje no encontrado" });
    }
    if (String(mensaje.userId) !== String(req.user.id)) {
      return res.status(403).json({ error: "No autorizado" });
    }

    await Mensaje.deleteOne({ _id: req.params.mensajeId, conversacionId: req.params.id, userId: req.user.id });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Error al eliminar mensaje" });
  }
});

router.delete("/conversaciones/:id", requireAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) {
      return res.status(400).json({ error: "ID inválido" });
    }

    const result = await runTransaction(async session => {
      const conv = await aplicarSesion(Conversacion.findById(req.params.id), session);
      if (!conv) return { status: 404, body: { error: "No encontrada" } };
      if (!esParticipante(conv, req.user.id)) return { status: 403, body: { error: "No autorizado" } };

      const participantes = participantesConversacion(conv);
      const hidden = new Set((conv.hiddenFor || []).map(idStr));
      hidden.add(String(req.user.id));

      if (participantes.every(participanteId => hidden.has(participanteId))) {
        await aplicarSesion(Mensaje.deleteMany({ conversacionId: req.params.id }), session);
        await aplicarSesion(Conversacion.deleteOne({ _id: req.params.id }), session);
        return { status: 200, body: { ok: true, eliminadaDefinitivamente: true } };
      }

      await aplicarSesion(
        Conversacion.updateOne({ _id: req.params.id }, { $addToSet: { hiddenFor: req.user.id } }),
        session
      );
      return { status: 200, body: { ok: true, eliminadaDefinitivamente: false } };
    });

    res.status(result.status).json(result.body);
  } catch {
    res.status(500).json({ error: "Error al eliminar conversación" });
  }
});

/* ======================
   LISTAR CONVERSACIONES CON TÍTULO
====================== */
router.get("/mis-conversaciones/:userId", requireAuth, async (req, res) => {
  const { userId } = req.params;
  if (!isObjectId(userId)) return res.status(400).json({ error: "ID inválido" });
  if (String(userId) !== req.user.id) return res.status(403).json({ error: "No autorizado" });

  const convs = await Conversacion.find({
    $or: [{ anuncianteId: userId }, { compradorId: userId }],
    hiddenFor: { $nin: [userId] }
  }).sort({ creado: -1 });

  const convsConTitulo = await Promise.all(convs.map(async c => {
    let propiedadTitulo = "Anuncio no disponible";
    let anuncianteNombre = "Anunciante";
    let compradorNombre = "Interesado";
    let anuncianteEliminado = false;
    let compradorEliminado = false;

    try {
      const prop = await Propiedad.findById(c.propiedadId);
      if (prop) propiedadTitulo = prop.titulo;
    } catch(e) {}

    const anunciante = await cargarParticipanteSeguro(c, c.anuncianteId, "Anunciante");
    anuncianteNombre = anunciante.nombre;
    anuncianteEliminado = anunciante.eliminado;

    const comprador = await cargarParticipanteSeguro(c, c.compradorId, "Interesado");
    compradorNombre = comprador.nombre;
    compradorEliminado = comprador.eliminado;

    const noLeidos = await Mensaje.countDocuments({
      conversacionId: c._id.toString(),
      userId: { $ne: userId },
      leido: false
    });

    const ultimo = await Mensaje.findOne({ conversacionId: c._id.toString() }).sort({ creado: -1 });
    const ultimaActividad = ultimo?.creado || c.creado;

    return {
      ...c.toObject(),
      propiedadTitulo,
      anuncianteNombre,
      compradorNombre,
      anuncianteEliminado,
      compradorEliminado,
      interlocutorEliminado: String(c.anuncianteId) === String(userId) ? compradorEliminado : anuncianteEliminado,
      puedeResponder: await puedeResponderConversacion(c, userId),
      noLeidos,
      ultimoMensaje: ultimo?.texto || "Conversación iniciada",
      ultimaActividad
    };
  }));

  convsConTitulo.sort((a, b) => new Date(b.ultimaActividad) - new Date(a.ultimaActividad));
  res.json(convsConTitulo);
});

/* ======================
   OBTENER CONVERSACIÓN POR ID
====================== */
router.get("/conversaciones/:id", requireAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) {
      return res.status(400).json({ error: "ID inválido" });
    }

    const conv = await Conversacion.findById(req.params.id);
    if (!conv) return res.status(404).json({ error: "No encontrada" });
    if (!esParticipante(conv, req.user.id)) return res.status(403).json({ error: "No autorizado" });
    if (usuarioEliminoConversacion(conv, req.user.id)) return res.status(404).json({ error: "No encontrada" });

    let propiedadTitulo = "Anuncio no disponible";
    let propiedad = null;
    let propiedadDisponible = false;
    try {
      const prop = await Propiedad.findById(conv.propiedadId);
      if (prop) {
        propiedadTitulo = prop.titulo;
        propiedadDisponible = true;
        propiedad = {
          _id: prop._id,
          titulo: prop.titulo,
          precio: prop.precio,
          direccion: prop.direccion,
          imagen: prop.imagenes?.[0] || ""
        };
      }
    } catch(e) {}

    const anunciante = await cargarParticipanteSeguro(conv, conv.anuncianteId, "Anunciante");
    const comprador = await cargarParticipanteSeguro(conv, conv.compradorId, "Interesado");
    const anuncianteEliminado = anunciante.eliminado;
    const compradorEliminado = comprador.eliminado;

    res.json({
      ...conv.toObject(),
      propiedadTitulo,
      propiedad,
      propiedadDisponible,
      anuncianteNombre: anunciante.nombre,
      compradorNombre: comprador.nombre,
      anuncianteEliminado,
      compradorEliminado,
      interlocutorEliminado: String(conv.anuncianteId) === String(req.user.id) ? compradorEliminado : anuncianteEliminado,
      puedeResponder: await puedeResponderConversacion(conv, req.user.id)
    });
  } catch(e) {
    res.status(400).json({ error: "ID inválido" });
  }
});

/* ======================
   MENSAJES NO LEÍDOS
====================== */
router.get("/no-leidos/:userId", requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    if (!isObjectId(userId)) return res.status(400).json({ error: "ID inválido" });
    if (String(userId) !== req.user.id) return res.status(403).json({ error: "No autorizado" });

    const convs = await Conversacion.find({
      $or: [{ anuncianteId: userId }, { compradorId: userId }],
      hiddenFor: { $nin: [userId] }
    });

    const convIds = convs.map(c => c._id.toString());

    const count = await Mensaje.countDocuments({
      conversacionId: { $in: convIds },
      userId:         { $ne: userId },
      leido:          false
    });

    res.json({ count });
  } catch(e) {
    res.status(500).json({ error: "Error" });
  }
});

/* ======================
   MARCAR COMO LEÍDOS
====================== */
router.put("/conversaciones/:id/leer", requireAuth, validateBody(leerSchema), async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) {
      return res.status(400).json({ error: "ID inválido" });
    }

    const userId = req.user.id;
    if (req.body.userId && String(req.body.userId) !== userId) {
      return res.status(403).json({ error: "No autorizado" });
    }
    const conv = await Conversacion.findById(req.params.id);
    if (!conv) return res.status(404).json({ error: "No encontrada" });
    if (!esParticipante(conv, userId)) return res.status(403).json({ error: "No autorizado" });
    if (usuarioEliminoConversacion(conv, userId)) return res.status(404).json({ error: "No encontrada" });

    await Mensaje.updateMany(
      { conversacionId: req.params.id, userId: { $ne: userId }, leido: false },
      { leido: true }
    );
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: "Error" });
  }
});

export default router;
