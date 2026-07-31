import express from "express";
import mongoose from "mongoose";
import { Resend } from "resend";
import Propiedad from "../models/Propiedad.js";
import EstadisticaAnuncio from "../models/EstadisticaAnuncio.js";
import Usuario from "../models/Usuario.js";
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
const ConversacionSchema = new mongoose.Schema({
  propiedadId:  String,
  anuncianteId: String,
  compradorId:  String,
  creado: { type: Date, default: Date.now }
});

const MensajeSchema = new mongoose.Schema({
  conversacionId: String,
  userId:         String,
  texto:          String,
  leido:          { type: Boolean, default: false },
  creado: { type: Date, default: Date.now }
});

const Conversacion = mongoose.model("Conversacion", ConversacionSchema);
const Mensaje      = mongoose.model("Mensaje",      MensajeSchema);

const crearConversacionSchema = z.object({
  propiedadId: objectId,
  anuncianteId: objectId,
  compradorId: objectId.optional()
}).strict();

const mensajeSchema = z.object({
  userId: objectId.optional(),
  texto: cleanString(2000)
}).strict();

const leerSchema = z.object({
  userId: objectId.optional()
}).strict();

function esParticipante(conv, userId) {
  return String(conv.anuncianteId) === userId || String(conv.compradorId) === userId;
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
    const { propiedadId, anuncianteId } = req.body;
    const compradorId = req.user.id;

    if (req.body.compradorId && String(req.body.compradorId) !== compradorId) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const propiedad = await Propiedad.findById(propiedadId);
    if (!propiedad) return res.status(404).json({ error: "Propiedad no encontrada" });
    if (String(propiedad.usuarioId) !== String(anuncianteId)) {
      return res.status(403).json({ error: "Anunciante no autorizado" });
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

/* ======================
   LISTAR CONVERSACIONES CON TÍTULO
====================== */
router.get("/mis-conversaciones/:userId", requireAuth, async (req, res) => {
  const { userId } = req.params;
  if (!isObjectId(userId)) return res.status(400).json({ error: "ID inválido" });
  if (String(userId) !== req.user.id) return res.status(403).json({ error: "No autorizado" });

  const convs = await Conversacion.find({
    $or: [{ anuncianteId: userId }, { compradorId: userId }]
  }).sort({ creado: -1 });

  const convsConTitulo = await Promise.all(convs.map(async c => {
    let propiedadTitulo = "Propiedad";
    let anuncianteNombre = "Anunciante";
    let compradorNombre = "Interesado";

    try {
      const prop = await Propiedad.findById(c.propiedadId);
      if (prop) propiedadTitulo = prop.titulo;
    } catch(e) {}

    try {
      const anunciante = await Usuario.findById(c.anuncianteId);
      if (anunciante) anuncianteNombre = anunciante.nombre;
    } catch(e) {}

    try {
      const comprador = await Usuario.findById(c.compradorId);
      if (comprador) compradorNombre = comprador.nombre;
    } catch(e) {}

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

    let propiedadTitulo = "Propiedad";
    let propiedad = null;
    try {
      const prop = await Propiedad.findById(conv.propiedadId);
      if (prop) {
        propiedadTitulo = prop.titulo;
        propiedad = {
          _id: prop._id,
          titulo: prop.titulo,
          precio: prop.precio,
          direccion: prop.direccion,
          imagen: prop.imagenes?.[0] || ""
        };
      }
    } catch(e) {}

    res.json({ ...conv.toObject(), propiedadTitulo, propiedad });
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
      $or: [{ anuncianteId: userId }, { compradorId: userId }]
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
