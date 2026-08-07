import express from 'express';
import Stripe from 'stripe';
import { Resend } from 'resend';
import { v2 as cloudinary } from 'cloudinary';
import Usuario from '../models/Usuario.js';
import Propiedad from '../models/Propiedad.js';
import Conversacion from '../models/Conversacion.js';
import Mensaje from '../models/Mensaje.js';
import EstadisticaAnuncio from '../models/EstadisticaAnuncio.js';
import CodigoVipTrial from '../models/CodigoVipTrial.js';
import ProfessionalTrialRedemption from '../models/ProfessionalTrialRedemption.js';
import mongoose from 'mongoose';
import { requireAdmin } from '../middleware/auth.js';
import { normalizeSpanishPrice } from '../utils/prices.js';
import { crearDatosVipTrial, expirarVipTrialUsuario } from '../utils/trials.js';
import { generarCodigoVipTrial } from '../utils/vipTrialCodes.js';
import { authenticateAdminCredentials, createAdminJwt } from '../utils/authentication.js';
import { createRateLimit } from '../utils/rateLimit.js';
import { destroyImagesByUrls } from '../utils/cloudinaryService.js';
import { getCloudinaryPublicIdFromUrl } from '../utils/imageSecurity.js';
import { securityRateLimits } from '../utils/security.js';
import { validateBody, z } from '../utils/validation.js';
import { getProfessionalPromotionAdminStats } from '../utils/professionalPromotion.js';

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);
const adminLoginLimiter = createRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 6,
  keyPrefix: 'admin-login'
});

const adminLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(200)
}).strict();

const ADMIN_ASSIGNABLE_PLAN_IDS = [
  'gratis', 'basico', 'destacado', 'starter',
  'pro_agentes', 'agencia_basica', 'agencia_pro',
  'vip', 'vip_trial'
];
const PLANES_VALIDOS = ADMIN_ASSIGNABLE_PLAN_IDS;
export const CONFIRMACION_ELIMINAR_USUARIO_DESACTIVADO = 'ELIMINAR_USUARIO_DESACTIVADO';

const USUARIO_ELIMINACION_PROJECTION = {
  email: 1,
  role: 1,
  activo: 1,
  favoritos: 1,
  stripeCustomerId: 1,
  stripeSubscriptionId: 1,
  subscriptionStatus: 1,
  cancelAtPeriodEnd: 1,
  subscriptionCancelAt: 1,
  pendingPlan: 1,
  pendingPriceId: 1,
  pendingPlanChangeAt: 1,
  pendingPlanLabel: 1
};

const PROPIEDAD_ELIMINACION_PROJECTION = {
  _id: 1,
  usuarioId: 1,
  imagenes: 1
};

const TIPOS_INMUEBLE_VALIDOS = [
  'piso', 'apartamento', 'atico', 'duplex', 'estudio',
  'casa', 'chalet', 'adosado', 'casa_campo', 'casa_madera',
  'local', 'local_comercial', 'oficina', 'nave', 'hotel', 'edificio', 'negocio',
  'terreno', 'solar_urbano', 'parcela', 'finca_rustica', 'finca_urbana',
  'garaje', 'plaza_aparcamiento', 'trastero', 'otro'
];

const TIPOS_CON_PLANTA = new Set([
  'piso', 'apartamento', 'atico', 'duplex', 'estudio',
  'local', 'local_comercial', 'oficina'
]);
const TIPOS_VIVIENDA_COMPLETA = new Set(['casa', 'chalet', 'adosado', 'casa_campo', 'casa_madera']);

function esObjectId(id) {
  return /^[0-9a-fA-F]{24}$/.test(String(id || ''));
}

function esUsuarioAdminPrincipal(req, usuario) {
  return Boolean(req?.user?.id && usuario?._id && String(usuario._id) === String(req.user.id));
}

function tieneValor(value) {
  return value !== undefined && value !== null && value !== '';
}

function aplicarSesion(queryOrPromise, session) {
  return queryOrPromise && typeof queryOrPromise.session === 'function'
    ? queryOrPromise.session(session)
    : queryOrPromise;
}

function resultadoBorrado(resultado) {
  return Number(resultado?.deletedCount || 0);
}

class EliminacionUsuarioError extends Error {
  constructor(status, code, message, resumen = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.resumen = resumen;
  }
}

function modelosEliminacionPorDefecto() {
  return {
    Usuario,
    Propiedad,
    Conversacion,
    Mensaje,
    Alerta: mongoose.models.Alerta,
    Notificacion: mongoose.models.Notificacion
  };
}

function usuarioTieneStripe(usuario = {}) {
  return Boolean(tieneValor(usuario.stripeCustomerId) || tieneValor(usuario.stripeSubscriptionId));
}

function usuarioTieneCambiosPendientes(usuario = {}) {
  return Boolean(
    tieneValor(usuario.pendingPlan) ||
    tieneValor(usuario.pendingPriceId) ||
    tieneValor(usuario.pendingPlanChangeAt) ||
    tieneValor(usuario.pendingPlanLabel)
  );
}

function usuarioTieneStripeBloqueante(usuario = {}) {
  if (usuarioTieneCambiosPendientes(usuario)) return true;
  if (!usuarioTieneStripe(usuario)) return false;

  const estado = String(usuario.subscriptionStatus || '').trim().toLowerCase();
  if (['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused'].includes(estado)) return true;
  if (usuario.cancelAtPeriodEnd === true) return true;
  if (tieneValor(usuario.subscriptionCancelAt) && estado !== 'canceled') return true;

  return false;
}

async function contarDocumento(Model, filtro, session) {
  return Number(await aplicarSesion(Model.countDocuments(filtro), session));
}

async function buscarDocumentos(Model, filtro, projectionOrSession, maybeSession) {
  const tieneProjection = maybeSession !== undefined;
  const projection = tieneProjection ? projectionOrSession : undefined;
  const session = tieneProjection ? maybeSession : projectionOrSession;
  const query = projection === undefined ? Model.find(filtro) : Model.find(filtro, projection);
  const resultado = await aplicarSesion(query, session);
  return Array.isArray(resultado) ? resultado : [];
}

function imagenesDePropiedades(propiedades = []) {
  return propiedades.flatMap(propiedad => (
    Array.isArray(propiedad?.imagenes)
      ? propiedad.imagenes.filter(url => typeof url === 'string' && url.trim())
      : []
  ));
}

function resumenImagenesPropiedades(propiedades = []) {
  const urls = imagenesDePropiedades(propiedades);
  const publicIds = urls.map(getCloudinaryPublicIdFromUrl).filter(Boolean);
  return {
    imagenes: urls.length,
    imagenesCloudinary: publicIds.length
  };
}

async function prepararEliminacionPropiedadesUsuario({ targetUserId, models, session }) {
  const propiedadesUsuario = await buscarDocumentos(
    models.Propiedad,
    { usuarioId: targetUserId },
    PROPIEDAD_ELIMINACION_PROJECTION,
    session
  );
  const urlsPorPublicId = new Map();

  for (const url of imagenesDePropiedades(propiedadesUsuario)) {
    const publicId = getCloudinaryPublicIdFromUrl(url);
    if (publicId && !urlsPorPublicId.has(publicId)) urlsPorPublicId.set(publicId, url);
  }

  if (urlsPorPublicId.size === 0) {
    return {
      propiedadesUsuario,
      imagenesParaEliminar: [],
      imagenesCompartidasPreservadas: 0
    };
  }

  const otrasPropiedades = await buscarDocumentos(
    models.Propiedad,
    { usuarioId: { $ne: targetUserId }, imagenes: { $exists: true, $ne: [] } },
    PROPIEDAD_ELIMINACION_PROJECTION,
    session
  );
  const publicIdsCompartidos = new Set(imagenesDePropiedades(otrasPropiedades).map(getCloudinaryPublicIdFromUrl).filter(Boolean));
  const imagenesParaEliminar = [];
  let imagenesCompartidasPreservadas = 0;

  for (const [publicId, url] of urlsPorPublicId.entries()) {
    if (publicIdsCompartidos.has(publicId)) {
      imagenesCompartidasPreservadas += 1;
    } else {
      imagenesParaEliminar.push(url);
    }
  }

  return {
    propiedadesUsuario,
    imagenesParaEliminar,
    imagenesCompartidasPreservadas
  };
}

async function limpiarChatsDeUsuarioEliminado({ targetUserId, models, session }) {
  const conversaciones = await buscarDocumentos(
    models.Conversacion,
    { $or: [{ compradorId: targetUserId }, { anuncianteId: targetUserId }] },
    session
  );

  let mensajesEliminados = 0;
  let conversacionesMarcadas = 0;
  let conversacionesEliminadas = 0;

  for (const conversacion of conversaciones) {
    const conversacionId = conversacion._id;
    const mensajesResult = await aplicarSesion(
      models.Mensaje.deleteMany({ conversacionId, userId: targetUserId }),
      session
    );
    mensajesEliminados += resultadoBorrado(mensajesResult);

    const restantes = await contarDocumento(models.Mensaje, { conversacionId }, session);
    if (restantes > 0) {
      await aplicarSesion(
        models.Conversacion.updateOne(
          { _id: conversacionId, $or: [{ compradorId: targetUserId }, { anuncianteId: targetUserId }] },
          { $addToSet: { deletedParticipants: targetUserId, hiddenFor: targetUserId } }
        ),
        session
      );
      conversacionesMarcadas += 1;
    } else {
      const conversacionResult = await aplicarSesion(
        models.Conversacion.deleteOne({ _id: conversacionId, $or: [{ compradorId: targetUserId }, { anuncianteId: targetUserId }] }),
        session
      );
      conversacionesEliminadas += resultadoBorrado(conversacionResult);
    }
  }

  return { mensajesEliminados, conversacionesMarcadas, conversacionesEliminadas };
}

async function cargarUsuarioEliminacion(UsuarioModel, targetUserId, session) {
  return aplicarSesion(UsuarioModel.findById(targetUserId, USUARIO_ELIMINACION_PROJECTION), session);
}

export async function construirResumenEliminacionUsuario({
  targetUserId,
  adminUserId,
  models = modelosEliminacionPorDefecto(),
  session = null
} = {}) {
  const usuario = await cargarUsuarioEliminacion(models.Usuario, targetUserId, session);
  if (!usuario) return null;

  const [propiedadesUsuario, chats, mensajes, alertas, notificaciones] = await Promise.all([
    buscarDocumentos(models.Propiedad, { usuarioId: targetUserId }, PROPIEDAD_ELIMINACION_PROJECTION, session),
    contarDocumento(models.Conversacion, { $or: [{ compradorId: targetUserId }, { anuncianteId: targetUserId }] }, session),
    contarDocumento(models.Mensaje, { userId: targetUserId }, session),
    contarDocumento(models.Alerta, { usuarioId: targetUserId }, session),
    contarDocumento(models.Notificacion, { usuarioId: targetUserId }, session)
  ]);

  const favoritos = Array.isArray(usuario.favoritos) ? usuario.favoritos.length : 0;
  const propiedades = propiedadesUsuario.length;
  const resumenImagenes = resumenImagenesPropiedades(propiedadesUsuario);
  const usuarioDesactivado = usuario.activo === false;
  const tieneStripe = usuarioTieneStripe(usuario);
  const stripeBloqueante = usuarioTieneStripeBloqueante(usuario);
  const tieneCambiosPendientes = usuarioTieneCambiosPendientes(usuario);
  const motivosBloqueo = [];

  if (String(usuario._id) === String(adminUserId)) motivosBloqueo.push('usuario_autenticado');
  if (usuario.role === 'admin') motivosBloqueo.push('usuario_admin');
  if (stripeBloqueante) motivosBloqueo.push('stripe_presente');
  if (tieneCambiosPendientes) motivosBloqueo.push('cambios_pendientes');

  return {
    usuario,
    seguro: {
      usuarioDesactivado,
      tieneStripe,
      stripeLocalObsoleto: tieneStripe && !stripeBloqueante,
      stripeBloqueante,
      tieneCambiosPendientes,
      propiedades,
      imagenes: resumenImagenes.imagenes,
      imagenesCloudinary: resumenImagenes.imagenesCloudinary,
      chats,
      mensajes,
      favoritos,
      alertas,
      notificaciones,
      puedeEliminar: motivosBloqueo.length === 0,
      motivosBloqueo
    }
  };
}

function filtroUsuarioEliminable(targetUserId) {
  return {
    _id: targetUserId,
    role: { $ne: 'admin' },
    subscriptionStatus: { $nin: ['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused'] },
    cancelAtPeriodEnd: { $ne: true },
    $or: [
      { subscriptionCancelAt: { $in: [null, ''] } },
      { subscriptionStatus: 'canceled' }
    ],
    pendingPlan: { $in: [null, ''] },
    pendingPriceId: { $in: [null, ''] },
    pendingPlanChangeAt: { $in: [null, ''] },
    pendingPlanLabel: { $in: [null, ''] }
  };
}

export async function eliminarUsuarioDesactivadoSeguro({
  targetUserId,
  adminUserId,
  confirmacion,
  models = modelosEliminacionPorDefecto(),
  mongooseClient = mongoose,
  cloudinaryClient = cloudinary,
  destroyImages = destroyImagesByUrls,
  logger = console
} = {}) {
  if (confirmacion !== CONFIRMACION_ELIMINAR_USUARIO_DESACTIVADO) {
    throw new EliminacionUsuarioError(400, 'confirmacion_requerida', 'Confirmación requerida.');
  }
  if (!mongooseClient || typeof mongooseClient.startSession !== 'function') {
    throw new EliminacionUsuarioError(409, 'transaccion_no_disponible', 'No se puede garantizar una transacción MongoDB.');
  }

  const session = await mongooseClient.startSession();
  let resultado = null;
  let imagenesCloudinaryPendientes = [];
  let imagenesCompartidasPreservadas = 0;

  try {
    await session.withTransaction(async () => {
      const resumen = await construirResumenEliminacionUsuario({ targetUserId, adminUserId, models, session });
      if (!resumen) {
        throw new EliminacionUsuarioError(404, 'usuario_no_encontrado', 'Usuario no encontrado.');
      }
      if (!resumen.seguro.puedeEliminar) {
        throw new EliminacionUsuarioError(409, 'eliminacion_bloqueada', 'El usuario no cumple los requisitos de eliminación.', resumen.seguro);
      }

      const propiedadesPlan = await prepararEliminacionPropiedadesUsuario({ targetUserId, models, session });
      imagenesCloudinaryPendientes = propiedadesPlan.imagenesParaEliminar;
      imagenesCompartidasPreservadas = propiedadesPlan.imagenesCompartidasPreservadas;
      const alertasResult = await aplicarSesion(models.Alerta.deleteMany({ usuarioId: targetUserId }), session);
      const notificacionesResult = await aplicarSesion(models.Notificacion.deleteMany({ usuarioId: targetUserId }), session);
      const chatsResult = await limpiarChatsDeUsuarioEliminado({ targetUserId, models, session });
      const propiedadesResult = await aplicarSesion(models.Propiedad.deleteMany({ usuarioId: targetUserId }), session);
      const usuarioEliminado = await aplicarSesion(models.Usuario.findOneAndDelete(filtroUsuarioEliminable(targetUserId)), session);

      if (!usuarioEliminado) {
        throw new EliminacionUsuarioError(409, 'eliminacion_condicional_sin_coincidencias', 'El estado del usuario cambió antes de eliminarlo.');
      }

      resultado = {
        ok: true,
        usuarioEliminado: true,
        conteos: resumen.seguro,
        eliminados: {
          alertas: resultadoBorrado(alertasResult),
          notificaciones: resultadoBorrado(notificacionesResult),
          propiedades: resultadoBorrado(propiedadesResult),
          mensajesPropios: chatsResult.mensajesEliminados,
          conversacionesMarcadas: chatsResult.conversacionesMarcadas,
          conversacionesEliminadas: chatsResult.conversacionesEliminadas,
          favoritosPropios: resumen.seguro.favoritos,
          imagenesCloudinaryPreparadas: imagenesCloudinaryPendientes.length,
          imagenesCompartidasPreservadas
        }
      };
    });
  } finally {
    await session.endSession();
  }

  if (imagenesCloudinaryPendientes.length > 0) {
    const cloudinaryResumen = await destroyImages(imagenesCloudinaryPendientes, { client: cloudinaryClient });
    const failed = Number(cloudinaryResumen?.failed || 0);
    if (failed > 0) {
      throw new EliminacionUsuarioError(502, 'cloudinary_limpieza_incompleta', 'No se pudieron limpiar todas las imágenes del usuario eliminado.', {
        imagenesCloudinaryPreparadas: imagenesCloudinaryPendientes.length,
        imagenesCloudinaryFallidas: failed
      });
    }
    resultado.eliminados.imagenesCloudinaryEliminadas = Number(cloudinaryResumen?.deleted || 0);
    resultado.eliminados.imagenesCloudinaryOmitidas = Number(cloudinaryResumen?.skipped || 0);
  } else if (resultado?.eliminados) {
    resultado.eliminados.imagenesCloudinaryEliminadas = 0;
    resultado.eliminados.imagenesCloudinaryOmitidas = 0;
  }

  logger.info('Eliminación administrativa de usuario completada', {
    resultado: 'ok',
    propiedades: resultado?.conteos?.propiedades || 0,
    chats: resultado?.conteos?.chats || 0,
    mensajes: resultado?.conteos?.mensajes || 0,
    favoritos: resultado?.conteos?.favoritos || 0,
    alertasEliminadas: resultado?.eliminados?.alertas || 0,
    notificacionesEliminadas: resultado?.eliminados?.notificaciones || 0,
    propiedadesEliminadas: resultado?.eliminados?.propiedades || 0,
    imagenesCloudinaryPreparadas: resultado?.eliminados?.imagenesCloudinaryPreparadas || 0,
    imagenesCloudinaryEliminadas: resultado?.eliminados?.imagenesCloudinaryEliminadas || 0,
    imagenesCompartidasPreservadas: resultado?.eliminados?.imagenesCompartidasPreservadas || 0
  });

  return resultado;
}

function limpiarTexto(value, max = 5000) {
  if (value === undefined || value === null) return undefined;
  return String(value).trim().replace(/\s+/g, ' ').slice(0, max);
}

function normalizarNumeroAdmin(value, fallback) {
  if (value === '' || value === undefined || value === null) return fallback;
  const numero = Number(value);
  return Number.isFinite(numero) && numero >= 0 ? numero : Number.NaN;
}

function inicioDia(fecha = new Date()) {
  const dia = new Date(fecha);
  dia.setHours(0, 0, 0, 0);
  return dia;
}

function sumarMetricas(registros) {
  return registros.reduce((total, item) => ({
    visitas: total.visitas + Number(item.visitas || 0),
    contactos: total.contactos + Number(item.contactos || 0)
  }), { visitas: 0, contactos: 0 });
}

function conversion(contactos, visitas) {
  return visitas > 0 ? Number(((contactos / visitas) * 100).toFixed(2)) : 0;
}

function serieUltimos30Dias(registros) {
  const hoy = inicioDia();
  const porFecha = new Map();

  registros.forEach(item => {
    const key = inicioDia(item.fecha).toISOString().slice(0, 10);
    const actual = porFecha.get(key) || { visitas: 0, contactos: 0 };
    actual.visitas += Number(item.visitas || 0);
    actual.contactos += Number(item.contactos || 0);
    porFecha.set(key, actual);
  });

  return Array.from({ length: 30 }, (_, index) => {
    const fecha = new Date(hoy);
    fecha.setDate(hoy.getDate() - (29 - index));
    const key = fecha.toISOString().slice(0, 10);
    const actual = porFecha.get(key) || { visitas: 0, contactos: 0 };
    return { fecha: key, visitas: actual.visitas, contactos: actual.contactos };
  });
}

function metricasTemporales(registros) {
  const desde7 = inicioDia();
  desde7.setDate(desde7.getDate() - 6);
  const desde30 = inicioDia();
  desde30.setDate(desde30.getDate() - 29);

  const registros7 = registros.filter(item => new Date(item.fecha) >= desde7);
  const registros30 = registros.filter(item => new Date(item.fecha) >= desde30);
  const m7 = sumarMetricas(registros7);
  const m30 = sumarMetricas(registros30);

  return {
    visitas7d: m7.visitas,
    contactos7d: m7.contactos,
    visitas30d: m30.visitas,
    contactos30d: m30.contactos,
    conversion7d: conversion(m7.contactos, m7.visitas),
    conversion30d: conversion(m30.contactos, m30.visitas),
    serieUltimos30Dias: serieUltimos30Dias(registros30)
  };
}

async function enviarInvitacionVipTrial(usuario) {
  const enlace = `${process.env.APP_URL}/vip-trial.html`;

  await resend.emails.send({
    from: 'HomeClick24 <contacto@homeclick24.com>',
    to: usuario.email,
    subject: 'Has sido invitado a una prueba gratuita VIP de 30 días',
    html: `
      <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:auto;padding:32px;background:#fff;">
        <h2 style="color:#7cc242;margin:0 0 18px;">HomeClick24</h2>
        <p>Hola <strong>${usuario.nombre || ""}</strong>,</p>
        <p>Tu <strong>prueba gratuita VIP de 30 días</strong> ya está activa en HomeClick24.</p>
        <p>Puedes revisar las condiciones de la prueba desde tu cuenta.</p>
        <a href="${enlace}" style="display:inline-block;margin:22px 0;padding:14px 24px;background:#7cc242;color:#fff;border-radius:8px;text-decoration:none;font-weight:700;">
          Ver prueba VIP
        </a>
        <p style="color:#777;font-size:0.9rem;">Por seguridad, inicia sesión con este mismo email para revisar tu prueba.</p>
      </div>
    `
  });
}

// Login admin
router.post('/login', adminLoginLimiter, validateBody(adminLoginSchema), async (req, res) => {
  const { email, password } = req.body;

  const resultado = await authenticateAdminCredentials({ UsuarioModel: Usuario, email, password });
  if (resultado.ok) {
    return res.json({ token: createAdminJwt(resultado.usuario) });
  }

  return res.status(401).json({ error: 'Credenciales incorrectas' });
});

router.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return securityRateLimits.adminSensitive(req, res, next);
  }
  return next();
});

// Estadísticas generales
router.get('/stats', requireAdmin, async (req, res) => {
  try {
    const totalUsuarios = await Usuario.countDocuments();
    const totalPropiedades = await Propiedad.countDocuments();
    const filtroSuscripcionRealActiva = {
      stripeSubscriptionId: { $exists: true, $nin: [null, ''] },
      subscriptionStatus: 'active'
    };
    const usuariosPago = await Usuario.countDocuments(filtroSuscripcionRealActiva);

    const planes = await Usuario.aggregate([
      { $group: { _id: '$plan', total: { $sum: 1 } } }
    ]);

    const PRECIOS = {
      gratis: 0, basico: 9.90, destacado: 19.90,
      starter: 29.90, pro_agentes: 59.90,
      agencia_basica: 79.90, agencia_pro: 149.90,
      vip: 0, vip_trial: 0, professional_trial_60d: 0
    };

    const usuariosConPagoReal = await Usuario.find(filtroSuscripcionRealActiva, { plan: 1 }).lean();
    const ingresosMes = usuariosConPagoReal.reduce((total, usuario) => (
      total + (PRECIOS[usuario.plan] || 0)
    ), 0);

    const promocionProfesional = await getProfessionalPromotionAdminStats({
      models: { Usuario, ProfessionalTrialRedemption }
    });

    res.json({ totalUsuarios, totalPropiedades, usuariosPago, ingresosMes, planes, promocionProfesional });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Estadísticas generales de actividad
router.get('/estadisticas', requireAdmin, async (req, res) => {
  try {
    const desde30 = inicioDia();
    desde30.setDate(desde30.getDate() - 29);

    const [totalUsuarios, propiedades, usuarios, historico30] = await Promise.all([
      Usuario.countDocuments(),
      Propiedad.find({}, {
        titulo: 1,
        referencia: 1,
        usuarioId: 1,
        visitas: 1,
        contactos: 1,
        createdAt: 1
      }).lean(),
      Usuario.find({}, {
        nombre: 1,
        email: 1,
        plan: 1,
        favoritos: 1
      }).lean(),
      EstadisticaAnuncio.find({ fecha: { $gte: desde30 } }, {
        fecha: 1,
        visitas: 1,
        contactos: 1
      }).lean()
    ]);

    const propiedadIds = new Set(propiedades.map(p => String(p._id)));
    const favoritosPorPropiedad = new Map();
    usuarios.forEach(usuario => {
      (usuario.favoritos || []).forEach(propiedadId => {
        const key = String(propiedadId);
        if (!propiedadIds.has(key)) return;
        favoritosPorPropiedad.set(key, (favoritosPorPropiedad.get(key) || 0) + 1);
      });
    });

    const usuariosPorId = new Map(usuarios.map(usuario => [String(usuario._id), usuario]));
    const resumenUsuarios = new Map();

    propiedades.forEach(propiedad => {
      const usuarioId = String(propiedad.usuarioId || '');
      if (!usuarioId) return;

      const actual = resumenUsuarios.get(usuarioId) || {
        usuarioId,
        nombre: usuariosPorId.get(usuarioId)?.nombre || 'Usuario',
        email: usuariosPorId.get(usuarioId)?.email || '',
        plan: usuariosPorId.get(usuarioId)?.plan || 'gratis',
        totalAnuncios: 0,
        visitas: 0,
        contactos: 0
      };

      actual.totalAnuncios += 1;
      actual.visitas += Number(propiedad.visitas || 0);
      actual.contactos += Number(propiedad.contactos || 0);
      resumenUsuarios.set(usuarioId, actual);
    });

    const propiedadesConFavoritos = propiedades.map(propiedad => ({
      _id: propiedad._id,
      titulo: propiedad.titulo || 'Sin título',
      referencia: propiedad.referencia || '',
      usuarioId: propiedad.usuarioId || null,
      propietario: usuariosPorId.get(String(propiedad.usuarioId || ''))?.nombre || 'Usuario',
      visitas: Number(propiedad.visitas || 0),
      contactos: Number(propiedad.contactos || 0),
      favoritos: favoritosPorPropiedad.get(String(propiedad._id)) || 0,
      createdAt: propiedad.createdAt
    }));

    const usuariosResumen = [...resumenUsuarios.values()];
    const temporales = metricasTemporales(historico30);

    res.json({
      totalUsuarios,
      totalAnuncios: propiedades.length,
      totalVisitas: propiedadesConFavoritos.reduce((total, p) => total + p.visitas, 0),
      totalContactos: propiedadesConFavoritos.reduce((total, p) => total + p.contactos, 0),
      totalFavoritos: propiedadesConFavoritos.reduce((total, p) => total + p.favoritos, 0),
      anunciosSinVisitas: propiedadesConFavoritos.filter(p => p.visitas === 0).length,
      topAnunciosPorVisitas: propiedadesConFavoritos
        .sort((a, b) => b.visitas - a.visitas)
        .slice(0, 10),
      topUsuariosPorVisitas: [...usuariosResumen]
        .sort((a, b) => b.visitas - a.visitas)
        .slice(0, 10),
      topUsuariosPorContactos: [...usuariosResumen]
        .sort((a, b) => b.contactos - a.contactos)
        .slice(0, 10),
      ...temporales
    });
  } catch (err) {
    console.error('Error obteniendo estadísticas generales admin:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Lista de usuarios
router.get('/usuarios', requireAdmin, async (req, res) => {
  try {
    const usuarios = await Usuario.find({}, {
      nombre: 1, email: 1, plan: 1, planActivo: 1, createdAt: 1, verificado: 1,
      activo: 1, desactivadoAt: 1,
      stripeSubscriptionId: 1, subscriptionStatus: 1, cancelAtPeriodEnd: 1, subscriptionCancelAt: 1,
      trialAccepted: 1, trialStartDate: 1, trialEndDate: 1, trialReminderSent: 1,
      professionalPromoCampaign: 1, professionalPromoStatus: 1,
      professionalPromoActivatedAt: 1, professionalPromoEndsAt: 1
    }).sort({ createdAt: -1 });
    res.json(usuarios);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Códigos privados VIP Trial
router.get('/codigos-vip-trial', requireAdmin, async (req, res) => {
  try {
    const now = new Date();
    await CodigoVipTrial.updateMany(
      { estado: 'disponible', expiresAt: { $lte: now } },
      { $set: { estado: 'caducado' } }
    );

    const codigos = await CodigoVipTrial.find({})
      .sort({ createdAt: -1 })
      .limit(200)
      .populate('usedBy', 'nombre email')
      .lean();

    res.json(codigos);
  } catch (err) {
    console.error('Error listando códigos VIP Trial:', err.message);
    res.status(500).json({ error: 'Error al listar códigos VIP Trial' });
  }
});

router.post('/codigos-vip-trial', requireAdmin, async (req, res) => {
  try {
    const diasValidez = Number(req.body?.diasValidez || 30);
    const codigo = await generarCodigoVipTrial({
      emailAsignado: limpiarTexto(req.body?.emailAsignado, 254),
      nombreAsignado: limpiarTexto(req.body?.nombreAsignado, 120),
      notaInterna: limpiarTexto(req.body?.notaInterna, 500),
      diasValidez,
      creadoPorAdmin: 'admin'
    });

    res.status(201).json({ ok: true, codigo });
  } catch (err) {
    console.error('Error generando código VIP Trial:', err.message);
    res.status(500).json({ error: 'No se pudo generar el código VIP Trial' });
  }
});

router.patch('/codigos-vip-trial/:id/cancelar', requireAdmin, async (req, res) => {
  try {
    if (!esObjectId(req.params.id)) {
      return res.status(400).json({ error: 'ID de código inválido' });
    }

    const codigo = await CodigoVipTrial.findById(req.params.id);
    if (!codigo) return res.status(404).json({ error: 'Código no encontrado' });
    if (codigo.estado === 'usado') {
      return res.status(400).json({ error: 'No se puede cancelar un código ya utilizado.' });
    }

    codigo.estado = 'cancelado';
    await codigo.save();

    res.json({ ok: true, codigo });
  } catch (err) {
    console.error('Error cancelando código VIP Trial:', err.message);
    res.status(500).json({ error: 'No se pudo cancelar el código VIP Trial' });
  }
});

// Verificar usuario manualmente
router.patch('/usuarios/:id/verificar', requireAdmin, async (req, res) => {
  try {
    if (!esObjectId(req.params.id)) {
      return res.status(400).json({ error: 'ID de usuario inválido' });
    }

    const usuario = await Usuario.findById(req.params.id);
    if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (esUsuarioAdminPrincipal(req, usuario)) {
      return res.status(403).json({ error: 'No puedes modificar el usuario administrador conectado.' });
    }

    usuario.verificado = true;
    await usuario.save();

    console.log('Usuario verificado manualmente desde admin', {
      usuarioId: usuario._id.toString(),
      email: usuario.email
    });

    res.json({ ok: true, usuario });
  } catch (err) {
    console.error('Error verificando usuario desde admin:', {
      usuarioId: req.params.id,
      error: err.message
    });
    res.status(500).json({ error: err.message });
  }
});

// Desactivar usuario de forma segura
router.patch('/usuarios/:id/desactivar', requireAdmin, async (req, res) => {
  try {
    if (!esObjectId(req.params.id)) {
      return res.status(400).json({ error: 'ID de usuario inválido' });
    }

    const usuario = await Usuario.findById(req.params.id);
    if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado' });

    if (esUsuarioAdminPrincipal(req, usuario)) {
      return res.status(403).json({ error: 'No puedes desactivar el usuario administrador conectado.' });
    }

    const tieneSuscripcionActiva = Boolean(usuario.stripeSubscriptionId) &&
      usuario.subscriptionStatus === 'active';
    if (tieneSuscripcionActiva) {
      return res.status(409).json({
        error: 'Este usuario tiene una suscripción activa en Stripe. Cancela primero la suscripción antes de desactivarlo.'
      });
    }

    usuario.activo = false;
    usuario.planActivo = false;
    usuario.desactivadoAt = new Date();
    await usuario.save();

    const propiedadesActualizadas = await Propiedad.updateMany(
      { usuarioId: usuario._id },
      { $set: { visiblePublicamente: false } }
    );

    console.log('Usuario desactivado desde admin', {
      usuarioId: usuario._id.toString(),
      email: usuario.email,
      propiedadesOcultadas: propiedadesActualizadas.modifiedCount || 0
    });

    res.json({
      ok: true,
      propiedadesOcultadas: propiedadesActualizadas.modifiedCount || 0
    });
  } catch (err) {
    console.error('Error desactivando usuario desde admin:', {
      usuarioId: req.params.id,
      error: err.message
    });
    res.status(500).json({ error: err.message });
  }
});

// Reactivar usuario desactivado
router.patch('/usuarios/:id/reactivar', requireAdmin, async (req, res) => {
  try {
    if (!esObjectId(req.params.id)) {
      return res.status(400).json({ error: 'ID de usuario inválido' });
    }

    const usuario = await Usuario.findById(req.params.id);
    if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (esUsuarioAdminPrincipal(req, usuario)) {
      return res.status(403).json({ error: 'No puedes modificar el usuario administrador conectado.' });
    }

    usuario.activo = true;
    usuario.desactivadoAt = null;
    await usuario.save();

    console.log('Usuario reactivado desde admin', {
      usuarioId: usuario._id.toString(),
      email: usuario.email
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('Error reactivando usuario desde admin:', {
      usuarioId: req.params.id,
      error: err.message
    });
    res.status(500).json({ error: err.message });
  }
});

router.get('/usuarios/:id/eliminacion-resumen', requireAdmin, async (req, res) => {
  try {
    if (!esObjectId(req.params.id)) {
      return res.status(400).json({ error: 'ID de usuario inválido' });
    }

    const resumen = await construirResumenEliminacionUsuario({
      targetUserId: req.params.id,
      adminUserId: req.user.id
    });

    if (!resumen) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(resumen.seguro);
  } catch (err) {
    console.error('Error preparando resumen de eliminación de usuario:', {
      error: err.message
    });
    res.status(500).json({ error: 'Error preparando resumen de eliminación' });
  }
});

router.delete('/usuarios/:id', requireAdmin, async (req, res) => {
  try {
    if (!esObjectId(req.params.id)) {
      return res.status(400).json({ error: 'ID de usuario inválido' });
    }
    if (req.body?.confirmacion !== CONFIRMACION_ELIMINAR_USUARIO_DESACTIVADO) {
      return res.status(400).json({ error: 'Confirmación requerida.' });
    }

    const resultado = await eliminarUsuarioDesactivadoSeguro({
      targetUserId: req.params.id,
      adminUserId: req.user.id,
      confirmacion: req.body?.confirmacion
    });

    res.json({
      ok: true,
      usuarioEliminado: resultado.usuarioEliminado,
      eliminados: resultado.eliminados,
      conteos: resultado.conteos
    });
  } catch (err) {
    if (err instanceof EliminacionUsuarioError) {
      return res.status(err.status).json({
        error: err.message,
        code: err.code,
        resumen: err.resumen || undefined
      });
    }

    console.error('Error eliminando usuario desactivado desde admin:', {
      error: err.message
    });
    res.status(500).json({ error: 'Error eliminando usuario' });
  }
});

// Finalizar manualmente una prueba VIP
router.patch('/usuarios/:id/finalizar-vip-trial', requireAdmin, async (req, res) => {
  try {
    if (!esObjectId(req.params.id)) {
      return res.status(400).json({ error: 'ID de usuario inválido' });
    }

    const usuario = await Usuario.findById(req.params.id);
    if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (esUsuarioAdminPrincipal(req, usuario)) {
      return res.status(403).json({ error: 'No puedes modificar el usuario administrador conectado.' });
    }
    if (usuario.plan !== 'vip_trial') {
      return res.status(400).json({ error: 'El usuario no tiene una prueba VIP activa.' });
    }

    const resultado = await expirarVipTrialUsuario(usuario, { enviarEmail: false });
    if (!resultado.ok) {
      return res.status(409).json({
        error: resultado.reason === 'stripe_active'
          ? 'Este usuario tiene una suscripción activa en Stripe. No se finalizará automáticamente.'
          : 'No se pudo finalizar la prueba VIP.'
      });
    }

    res.json({
      ok: true,
      propiedadesVisibles: resultado.propiedadesVisibles || 0,
      propiedadesOcultadas: resultado.propiedadesOcultadas || 0,
      propiedadesRecuperadas: resultado.propiedadesRecuperadas || 0
    });
  } catch (err) {
    console.error('Error finalizando prueba VIP desde admin:', {
      usuarioId: req.params.id,
      error: err.message
    });
    res.status(500).json({ error: err.message });
  }
});

// Estadísticas de anuncios por usuario
router.get('/usuarios/:id/estadisticas', requireAdmin, async (req, res) => {
  try {
    if (!esObjectId(req.params.id)) {
      return res.status(400).json({ error: 'ID inválido' });
    }

    const usuario = await Usuario.findById(req.params.id, {
      nombre: 1, email: 1, plan: 1, planActivo: 1
    }).lean();
    if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado' });

    const propiedades = await Propiedad.find({ usuarioId: req.params.id }, {
      titulo: 1,
      referencia: 1,
      precio: 1,
      direccion: 1,
      estadoComercial: 1,
      visitas: 1,
      contactos: 1,
      ultimaVisita: 1,
      ultimoContacto: 1,
      createdAt: 1
    }).sort({ createdAt: -1 }).lean();
    const desde30 = inicioDia();
    desde30.setDate(desde30.getDate() - 29);
    const historico30 = await EstadisticaAnuncio.find({
      usuarioId: req.params.id,
      fecha: { $gte: desde30 }
    }, {
      fecha: 1,
      visitas: 1,
      contactos: 1
    }).lean();

    const propiedadesConFavoritos = await Promise.all(propiedades.map(async propiedad => {
      const favoritos = await Usuario.countDocuments({ favoritos: propiedad._id });
      return {
        _id: propiedad._id,
        titulo: propiedad.titulo,
        referencia: propiedad.referencia || '',
        precio: propiedad.precio || 0,
        direccion: propiedad.direccion || '',
        estadoComercial: propiedad.estadoComercial || 'Disponible',
        visitas: propiedad.visitas || 0,
        contactos: propiedad.contactos || 0,
        favoritos,
        ultimaVisita: propiedad.ultimaVisita || null,
        ultimoContacto: propiedad.ultimoContacto || null,
        createdAt: propiedad.createdAt
      };
    }));
    const temporales = metricasTemporales(historico30);

    res.json({
      usuario: {
        _id: usuario._id,
        nombre: usuario.nombre,
        email: usuario.email
      },
      plan: usuario.plan || 'gratis',
      planActivo: Boolean(usuario.planActivo),
      totalAnuncios: propiedadesConFavoritos.length,
      visitasTotales: propiedadesConFavoritos.reduce((total, p) => total + p.visitas, 0),
      contactosTotales: propiedadesConFavoritos.reduce((total, p) => total + p.contactos, 0),
      favoritosTotales: propiedadesConFavoritos.reduce((total, p) => total + p.favoritos, 0),
      propiedades: propiedadesConFavoritos,
      ...temporales
    });
  } catch (err) {
    console.error('Error obteniendo estadísticas admin:', {
      usuarioId: req.params.id,
      error: err.message
    });
    res.status(500).json({ error: err.message });
  }
});

// Lista de propiedades
router.get('/propiedades', requireAdmin, async (req, res) => {
  try {
    const propiedades = await Propiedad.find({})
      .sort({ createdAt: -1 })
      .limit(100);
    res.json(propiedades);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Editar propiedad desde admin
router.put('/propiedades/:id', requireAdmin, async (req, res) => {
  try {
    if (!esObjectId(req.params.id)) {
      return res.status(400).json({ error: 'ID inválido' });
    }

    const propiedad = await Propiedad.findById(req.params.id);
    if (!propiedad) return res.status(404).json({ error: 'Propiedad no encontrada' });

    const {
      titulo,
      precio,
      tipoOperacion,
      tipoInmueble,
      plantaLocal,
      numeroPlantas,
      sotano,
      direccion,
      habitaciones,
      banos,
      superficie,
      descripcion,
      visiblePublicamente
    } = req.body;

    if (titulo !== undefined) propiedad.titulo = limpiarTexto(titulo, 160);
    if (direccion !== undefined) propiedad.direccion = limpiarTexto(direccion, 300);
    if (descripcion !== undefined) propiedad.descripcion = limpiarTexto(descripcion, 5000);

    if (precio !== undefined) {
      const precioNormalizado = normalizeSpanishPrice(precio);
      if (!Number.isFinite(precioNormalizado) || precioNormalizado < 0) {
        return res.status(400).json({ error: 'Precio inválido' });
      }
      propiedad.precio = precioNormalizado;
    }

    if (tipoOperacion !== undefined) {
      if (!['venta', 'alquiler'].includes(tipoOperacion)) {
        return res.status(400).json({ error: 'Tipo de operación inválido' });
      }
      propiedad.tipoOperacion = tipoOperacion;
    }

    if (tipoInmueble !== undefined) {
      if (!TIPOS_INMUEBLE_VALIDOS.includes(tipoInmueble)) {
        return res.status(400).json({ error: 'Tipo de inmueble inválido' });
      }
      propiedad.tipoInmueble = tipoInmueble;
    }

    if (plantaLocal !== undefined || tipoInmueble !== undefined) {
      propiedad.plantaLocal = TIPOS_CON_PLANTA.has(propiedad.tipoInmueble)
        ? limpiarTexto(plantaLocal, 80) || ''
        : '';
    }

    if (numeroPlantas !== undefined || sotano !== undefined || tipoInmueble !== undefined) {
      const admitePlantas = TIPOS_VIVIENDA_COMPLETA.has(propiedad.tipoInmueble);
      propiedad.numeroPlantas = admitePlantas && ['1', '2', '3', '4_mas', ''].includes(numeroPlantas)
        ? numeroPlantas
        : '';
      propiedad.sotano = admitePlantas && ['si', 'no', ''].includes(sotano)
        ? sotano
        : '';
    }

    if (habitaciones !== undefined) {
      const valor = normalizarNumeroAdmin(habitaciones, 0);
      if (!Number.isFinite(valor)) return res.status(400).json({ error: 'Habitaciones inválidas' });
      propiedad.habitaciones = valor;
    }

    if (banos !== undefined) {
      const valor = normalizarNumeroAdmin(banos, 0);
      if (!Number.isFinite(valor)) return res.status(400).json({ error: 'Baños inválidos' });
      propiedad.banos = valor;
    }

    if (superficie !== undefined) {
      const valor = normalizarNumeroAdmin(superficie, undefined);
      if (valor !== undefined && !Number.isFinite(valor)) return res.status(400).json({ error: 'Superficie inválida' });
      propiedad.superficie = valor;
    }
    if (visiblePublicamente !== undefined) {
      propiedad.visiblePublicamente = visiblePublicamente === true || visiblePublicamente === 'true';
    }

    await propiedad.save();
    res.json({ ok: true, propiedad });
  } catch (err) {
    console.error('Error editando propiedad desde admin:', {
      propiedadId: req.params.id,
      error: err.message
    });
    res.status(500).json({ error: err.message });
  }
});

router.patch('/propiedades/:id/redes-publicado', requireAdmin, async (req, res) => {
  try {
    if (!esObjectId(req.params.id)) {
      return res.status(400).json({ error: 'ID inválido' });
    }

    const propiedad = await Propiedad.findByIdAndUpdate(
      req.params.id,
      {
        $inc: { redesPublicadoCount: 1 },
        $set: {
          redesUltimaPublicacionAt: new Date(),
          redesPublicadoManual: true,
          redesProximaPublicacionAt: null
        }
      },
      {
        new: true,
        projection: {
          redesPublicadoCount: 1,
          redesUltimaPublicacionAt: 1,
          redesPublicadoManual: 1,
          redesProximaPublicacionAt: 1,
          redesCanalPreferente: 1,
          redesNotasPublicacion: 1
        }
      }
    );

    if (!propiedad) return res.status(404).json({ error: 'Propiedad no encontrada' });

    res.json({
      ok: true,
      propiedad: {
        _id: propiedad._id,
        redesPublicadoCount: propiedad.redesPublicadoCount || 0,
        redesUltimaPublicacionAt: propiedad.redesUltimaPublicacionAt || null,
        redesPublicadoManual: propiedad.redesPublicadoManual === true,
        redesProximaPublicacionAt: propiedad.redesProximaPublicacionAt || null,
        redesCanalPreferente: propiedad.redesCanalPreferente || '',
        redesNotasPublicacion: propiedad.redesNotasPublicacion || ''
      }
    });
  } catch (err) {
    console.error('Error marcando propiedad publicada en redes:', {
      propiedadId: req.params.id,
      error: err.message
    });
    res.status(500).json({ error: err.message });
  }
});

router.patch('/propiedades/:id/redes-programacion', requireAdmin, async (req, res) => {
  try {
    if (!esObjectId(req.params.id)) {
      return res.status(400).json({ error: 'ID inválido' });
    }

    const { redesProximaPublicacionAt, redesCanalPreferente, redesNotasPublicacion } = req.body;
    const canalesValidos = new Set(['facebook', 'instagram', 'ambos', '']);
    const canal = redesCanalPreferente === undefined ? '' : String(redesCanalPreferente || '').trim().toLowerCase();

    if (!canalesValidos.has(canal)) {
      return res.status(400).json({ error: 'Canal de redes inválido' });
    }

    let fecha = null;
    if (redesProximaPublicacionAt) {
      fecha = new Date(redesProximaPublicacionAt);
      if (Number.isNaN(fecha.getTime())) {
        return res.status(400).json({ error: 'Fecha de programación inválida' });
      }
    }

    const propiedad = await Propiedad.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          redesProximaPublicacionAt: fecha,
          redesCanalPreferente: canal,
          redesNotasPublicacion: limpiarTexto(redesNotasPublicacion || '', 500)
        }
      },
      {
        new: true,
        projection: {
          redesProximaPublicacionAt: 1,
          redesCanalPreferente: 1,
          redesNotasPublicacion: 1,
          redesPublicadoCount: 1,
          redesUltimaPublicacionAt: 1,
          redesPublicadoManual: 1
        }
      }
    );

    if (!propiedad) return res.status(404).json({ error: 'Propiedad no encontrada' });

    res.json({
      ok: true,
      propiedad: {
        _id: propiedad._id,
        redesProximaPublicacionAt: propiedad.redesProximaPublicacionAt || null,
        redesCanalPreferente: propiedad.redesCanalPreferente || '',
        redesNotasPublicacion: propiedad.redesNotasPublicacion || '',
        redesPublicadoCount: propiedad.redesPublicadoCount || 0,
        redesUltimaPublicacionAt: propiedad.redesUltimaPublicacionAt || null,
        redesPublicadoManual: propiedad.redesPublicadoManual === true
      }
    });
  } catch (err) {
    console.error('Error guardando programación de redes:', {
      propiedadId: req.params.id,
      error: err.message
    });
    res.status(500).json({ error: err.message });
  }
});

// Eliminar propiedad
router.delete('/propiedades/:id', requireAdmin, async (req, res) => {
  try {
    if (!esObjectId(req.params.id)) {
      return res.status(400).json({ error: 'ID inválido' });
    }

    const propiedad = await Propiedad.findById(req.params.id);
    if (!propiedad) return res.status(404).json({ error: 'Propiedad no encontrada' });

    const imagenesParaEliminar = [...(propiedad.imagenes || [])];
    await Propiedad.findByIdAndDelete(req.params.id);
    await destroyImagesByUrls(imagenesParaEliminar, { client: cloudinary });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error eliminando propiedad desde admin:', {
      propiedadId: req.params.id,
      error: err.message
    });
    res.status(500).json({ error: 'Error eliminando propiedad' });
  }
});

// Cancelar suscripción Stripe al final del periodo
router.post('/usuarios/:id/cancelar-suscripcion', requireAdmin, async (req, res) => {
  try {
    const usuario = await Usuario.findById(req.params.id);
    if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (esUsuarioAdminPrincipal(req, usuario)) {
      return res.status(403).json({ error: 'No puedes modificar el usuario administrador conectado.' });
    }

    if (!usuario.stripeSubscriptionId) {
      return res.status(400).json({ error: 'El usuario no tiene una suscripción Stripe activa' });
    }

    console.log('Admin solicita cancelar suscripción Stripe', {
      usuarioId: usuario._id.toString(),
      email: usuario.email,
      stripeSubscriptionId: usuario.stripeSubscriptionId
    });

    const subscription = await stripe.subscriptions.update(usuario.stripeSubscriptionId, {
      cancel_at_period_end: true
    });
    const cancelAt = subscription.cancel_at
      ? new Date(subscription.cancel_at * 1000)
      : null;

    usuario.cancelAtPeriodEnd = Boolean(subscription.cancel_at_period_end);
    usuario.subscriptionCancelAt = cancelAt;
    await usuario.save();

    console.log('Suscripción Stripe marcada para cancelar al final del periodo', {
      usuarioId: usuario._id.toString(),
      stripeSubscriptionId: subscription.id,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      cancelAt: cancelAt?.toISOString() || null
    });

    res.json({
      ok: true,
      cancelAtPeriodEnd: usuario.cancelAtPeriodEnd,
      subscriptionCancelAt: usuario.subscriptionCancelAt
    });
  } catch (err) {
    console.error('Error cancelando suscripción Stripe desde admin:', {
      usuarioId: req.params.id,
      error: err.message
    });
    res.status(500).json({ error: err.message });
  }
});

// Cambiar plan de usuario
router.put('/usuarios/:id/plan', requireAdmin, async (req, res) => {
  try {
    const { plan } = req.body;
    if (!PLANES_VALIDOS.includes(plan)) {
      return res.status(400).json({ error: 'Plan inválido' });
    }

    const usuarioExistente = await Usuario.findById(req.params.id);
    if (!usuarioExistente) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (esUsuarioAdminPrincipal(req, usuarioExistente)) {
      return res.status(403).json({ error: 'No puedes modificar el usuario administrador conectado.' });
    }

    const update = { plan, planActivo: plan !== 'gratis' && plan !== 'vip_trial' };

    if (plan === 'gratis') {
      Object.assign(update, {
        planActivo: false,
        planFechaFin: null,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        subscriptionStatus: null,
        trialAccepted: false,
        trialStartDate: null,
        trialEndDate: null,
        trialReminderSent: false,
        trialReminders: {
          sevenDays: false,
          threeDays: false,
          lastDay: false,
          expired: false
        }
      });
    } else if (plan === 'vip_trial') {
      Object.assign(update, crearDatosVipTrial());
    } else {
      Object.assign(update, {
        trialAccepted: false,
        trialStartDate: null,
        trialEndDate: null,
        trialReminderSent: false,
        trialReminders: {
          sevenDays: false,
          threeDays: false,
          lastDay: false,
          expired: false
        }
      });
    }

    const usuario = await Usuario.findByIdAndUpdate(req.params.id, update, { new: true });

    let warning = null;
    if (plan === 'vip_trial') {
      try {
        await enviarInvitacionVipTrial(usuario);
      } catch (emailErr) {
        console.error('Error enviando invitación VIP Trial:', emailErr.message);
        warning = 'Plan cambiado, pero no se pudo enviar el email de invitación.';
      }
    }

    res.json({ ok: true, warning });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
