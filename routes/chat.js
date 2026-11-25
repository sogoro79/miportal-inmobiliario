import express from "express";
import { buildPublicLocation, isApproximate } from "../utils/publicLocation.js";
import mongoose from "mongoose";
import Propiedad from "../models/Propiedad.js";
import EstadisticaAnuncio from "../models/EstadisticaAnuncio.js";
import Usuario from "../models/Usuario.js";
import Conversacion from "../models/Conversacion.js";
import Mensaje from "../models/Mensaje.js";
import { requireAuth } from "../middleware/auth.js";
import { cleanString, isObjectId, objectId, validateBody, z } from "../utils/validation.js";
import { securityRateLimits } from "../utils/security.js";
import { notifyChatMessage } from "../utils/chatEmail.js";

const router = express.Router();

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
  return Boolean(conv && userId && [conv.anuncianteId, conv.compradorId].some(id => id && String(id) === String(userId)));
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

    await notifyChatMessage(conv, msg);

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
          tipoOperacion: prop.tipoOperacion,
          periodicidadPrecio: prop.periodicidadPrecio,
          direccion: isApproximate(prop) ? "" : prop.direccion,
          ubicacionPublica: buildPublicLocation(prop),
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
