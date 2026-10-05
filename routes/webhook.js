import express from 'express';
import Stripe from 'stripe';
import Usuario from '../models/Usuario.js';
import { enviarCorreo } from '../utils/email.js';
import { aplicarCuponLaunchPromo } from '../utils/launchPromo.js';
import { getPlanByPriceId } from '../utils/stripePlans.js';

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const NOMBRES_PLANES = {
  basico: 'Básico', destacado: 'Destacado', starter: 'Starter',
  pro_agentes: 'Pro', agencia_basica: 'Agencia Básica',
};

function esObjectId(id) {
  return /^[0-9a-fA-F]{24}$/.test(String(id || ''));
}

function fechaFinPeriodo(subscription) {
  const timestamp = subscription.current_period_end || subscription.items?.data?.[0]?.current_period_end;
  return timestamp ? new Date(timestamp * 1000) : null;
}

function datosPlanDesdeSubscription(subscription) {
  const priceId = subscription.items?.data?.[0]?.price?.id;
  const plan = getPlanByPriceId(priceId) || 'gratis';
  const fechaFin = fechaFinPeriodo(subscription);
  return { priceId, plan, fechaFin };
}

function customerId(subscription) {
  const customer = subscription.customer;
  return typeof customer === 'string' ? customer : customer?.id;
}

function metadataUserId(subscription) {
  return subscription.metadata?.userId || subscription.metadata?.usuarioId;
}

async function buscarUsuarioPorSubscription(subscription) {
  const customer = customerId(subscription);
  if (customer) {
    const usuario = await Usuario.findOne({ stripeCustomerId: customer });
    if (usuario) return usuario;
  }

  const userId = metadataUserId(subscription);
  if (esObjectId(userId)) {
    return Usuario.findById(userId);
  }

  return null;
}

async function actualizarUsuarioDesdeSubscription(subscription, extraUpdate = {}) {
  const { priceId, plan, fechaFin } = datosPlanDesdeSubscription(subscription);
  const customer = customerId(subscription);
  const usuario = await buscarUsuarioPorSubscription(subscription);

  if (!usuario) {
    return { usuario: null, priceId, plan, fechaFin, customer, updated: false };
  }

  usuario.plan = extraUpdate.plan || plan;
  usuario.planActivo = subscription.status === 'active' || subscription.status === 'trialing';
  usuario.subscriptionStatus = subscription.status || null;
  if (fechaFin) usuario.planFechaFin = fechaFin;
  usuario.stripeSubscriptionId = subscription.id;
  if (customer) usuario.stripeCustomerId = customer;

  Object.entries(extraUpdate).forEach(([key, value]) => {
    usuario[key] = value;
  });

  await usuario.save();

  return { usuario, priceId, plan: usuario.plan, fechaFin, customer, updated: true };
}

function phasePriceId(phase) {
  const price = phase?.items?.[0]?.price;
  return typeof price === 'string' ? price : price?.id;
}

async function getScheduledPlanChange(subscription, currentPriceId) {
  const scheduleRef = subscription.schedule;
  if (!scheduleRef) return null;

  const schedule = typeof scheduleRef === 'string'
    ? await stripe.subscriptionSchedules.retrieve(scheduleRef)
    : scheduleRef;

  const now = Math.floor(Date.now() / 1000);
  const futurePhase = schedule.phases
    ?.filter(phase => Number(phase.start_date) > now)
    .sort((a, b) => Number(a.start_date) - Number(b.start_date))
    .find(phase => {
      const nextPriceId = phasePriceId(phase);
      return nextPriceId && nextPriceId !== currentPriceId;
    });

  if (!futurePhase) return null;

  const pendingPriceId = phasePriceId(futurePhase);
  const pendingPlan = getPlanByPriceId(pendingPriceId);
  if (!pendingPlan) return null;

  return {
    pendingPlan,
    pendingPriceId,
    pendingPlanChangeAt: new Date(Number(futurePhase.start_date) * 1000),
    pendingPlanLabel: NOMBRES_PLANES[pendingPlan] || pendingPlan
  };
}

router.post('/', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  if (!Buffer.isBuffer(req.body)) {
    console.error('Webhook error: el body no llegó como Buffer', {
      bodyType: typeof req.body,
      isBuffer: Buffer.isBuffer(req.body)
    });
    return res.status(400).send('Webhook Error: invalid raw body');
  }

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook error:', err.message, {
      hasSignature: Boolean(sig),
      bodyIsBuffer: Buffer.isBuffer(req.body),
      bodyLength: req.body?.length
    });
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ===== SUSCRIPCIÓN COMPLETADA =====
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_details?.email;
    const subscriptionId = session.subscription;
    const metadata = session.metadata || {};

    console.log('Stripe webhook recibido', {
      eventType: event.type,
      sessionId: session.id,
      metadata,
      customer: session.customer,
      subscription: subscriptionId
    });

    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const priceId = subscription.items.data[0]?.price?.id;
    const plan = getPlanByPriceId(priceId) || metadata.plan || 'gratis';
    const userId = metadata.userId || metadata.usuarioId || session.client_reference_id;
    const fechaFin = fechaFinPeriodo(subscription);
    const launchPromoUpdate = metadata.launchPromoEligible === 'true' ? {
      launchPromoEligible: true,
      launchPromoCouponId: metadata.launchPromoCouponId || null,
      launchPromoSuccessfulPayments: 0,
      launchPromoApplied: false
    } : {};
    const update = {
      plan,
      planActivo: true,
      ...(fechaFin && { planFechaFin: fechaFin }),
      stripeCustomerId: session.customer,
      stripeSubscriptionId: subscriptionId,
      subscriptionStatus: subscription.status || null,
      ...launchPromoUpdate,
    };

    let usuarioActualizado = null;

    if (esObjectId(userId)) {
      usuarioActualizado = await Usuario.findByIdAndUpdate(userId, update, { new: true });
    }

    if (!usuarioActualizado && email) {
      usuarioActualizado = await Usuario.findOneAndUpdate({ email }, update, { new: true });
    }

    console.log('Stripe webhook actualización usuario', {
      sessionId: session.id,
      userId,
      priceId,
      plan,
      actualizado: Boolean(usuarioActualizado),
      usuarioIdActualizado: usuarioActualizado?._id?.toString() || null,
      stripeCustomerGuardado: Boolean(usuarioActualizado?.stripeCustomerId),
      stripeSubscriptionGuardada: Boolean(usuarioActualizado?.stripeSubscriptionId),
      currentPeriodEnd: subscription.current_period_end || null,
      itemCurrentPeriodEnd: subscription.items?.data?.[0]?.current_period_end || null,
      planFechaFin: fechaFin?.toISOString() || null
    });

    // Email de confirmación
    if (usuarioActualizado?.email && fechaFin) {
      await enviarCorreo(
        usuarioActualizado.email,
        `✅ Tu plan ${NOMBRES_PLANES[plan]} está activo — HomeClick24`,
        `
          <p>Tu plan <strong>${NOMBRES_PLANES[plan]}</strong> está activo.</p>
          <div style="background:#f0f9e8;border-radius:10px;padding:16px 20px;margin:20px 0;">
            <p style="margin:0;color:#5a9e2f;font-weight:600;">📅 Válido hasta: ${fechaFin.toLocaleDateString('es-ES')}</p>
          </div>
          <p>Ya puedes publicar tus anuncios en HomeClick24.</p>
        `,
        {
          title: "Suscripción activada",
          cta: {
            label: "Publicar anuncio",
            url: "https://www.homeclick24.com/publicar"
          }
        }
      );
    }
  }

  // ===== RENOVACIÓN EXITOSA =====
  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;
    const subscriptionId = typeof invoice.subscription === 'string'
      ? invoice.subscription
      : invoice.subscription?.id;
    if (!subscriptionId) return res.json({ received: true });

    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const promoEligible = subscription.metadata?.launchPromoEligible === 'true';
    const promoUpdate = promoEligible ? {
      launchPromoEligible: true,
      launchPromoCouponId: subscription.metadata?.launchPromoCouponId || null,
      launchPromoLastPaymentAt: new Date()
    } : {};

    const { usuario, priceId, plan, fechaFin, customer, updated } = await actualizarUsuarioDesdeSubscription(subscription, {
      pendingPlan: null,
      pendingPriceId: null,
      pendingPlanChangeAt: null,
      pendingPlanLabel: null,
      ...promoUpdate
    });

    if (promoEligible && usuario) {
      usuario.launchPromoSuccessfulPayments = Number(usuario.launchPromoSuccessfulPayments || 0) + 1;
      usuario.launchPromoLastPaymentAt = new Date();
      await usuario.save();

      console.log('[LaunchPromo] Pago válido registrado', {
        userId: usuario._id.toString(),
        subscriptionId: subscription.id,
        invoiceId: invoice.id,
        successfulPayments: usuario.launchPromoSuccessfulPayments
      });

      if (usuario.launchPromoSuccessfulPayments >= 2 && usuario.launchPromoApplied !== true) {
        console.log('[LaunchPromo] Usuario elegible para descuento en tercera mensualidad', {
          userId: usuario._id.toString(),
          subscriptionId: subscription.id,
          invoiceId: invoice.id,
          successfulPayments: usuario.launchPromoSuccessfulPayments
        });

        if (!usuario.stripeSubscriptionId || !usuario.launchPromoCouponId) {
          console.warn('[LaunchPromo] Cupón no aplicado: faltan datos', {
            userId: usuario._id.toString(),
            subscriptionId: usuario.stripeSubscriptionId || null,
            couponId: usuario.launchPromoCouponId || null
          });
        } else {
          try {
            console.log('[LaunchPromo] Aplicando cupón 50% tercera mensualidad', {
              userId: usuario._id.toString(),
              subscriptionId: usuario.stripeSubscriptionId,
              couponId: usuario.launchPromoCouponId
            });

            const resultadoPromo = await aplicarCuponLaunchPromo({
              stripe,
              usuario,
              metadata: subscription.metadata || {}
            });

            console.log('[LaunchPromo] Cupón aplicado correctamente', {
              userId: usuario._id.toString(),
              subscriptionId: resultadoPromo.subscriptionId,
              couponId: resultadoPromo.couponId
            });
          } catch (promoErr) {
            console.error('[LaunchPromo] Error aplicando cupón', {
              userId: usuario._id.toString(),
              subscriptionId: usuario.stripeSubscriptionId,
              couponId: usuario.launchPromoCouponId,
              error: promoErr.message
            });
          }
        }
      } else if (promoEligible && usuario.launchPromoApplied === true) {
        console.log('[LaunchPromo] Cupón no aplicado: ya aplicado', {
          userId: usuario._id.toString(),
          subscriptionId: subscription.id,
          invoiceId: invoice.id,
          successfulPayments: usuario.launchPromoSuccessfulPayments
        });
      }
    }

    console.log('Webhook invoice.payment_succeeded recibido', {
      customer,
      subscriptionId: subscription.id,
      priceIdDetectado: priceId,
      planDetectado: plan,
      usuarioEncontrado: Boolean(usuario),
      resultadoUpdate: updated,
      usuarioIdActualizado: usuario?._id?.toString() || null,
      planFechaFin: fechaFin?.toISOString() || null
    });

    if (usuario?.email && fechaFin) {
      await enviarCorreo(
        usuario.email,
        `🔄 Tu plan ${NOMBRES_PLANES[plan]} se ha renovado — HomeClick24`,
        `
          <p>Tu plan <strong>${NOMBRES_PLANES[plan]}</strong> se ha renovado.</p>
          <div style="background:#f0f9e8;border-radius:10px;padding:16px 20px;margin:20px 0;">
            <p style="margin:0;color:#5a9e2f;font-weight:600;">📅 Válido hasta: ${fechaFin.toLocaleDateString('es-ES')}</p>
          </div>
        `,
        {
          title: "Plan renovado correctamente"
        }
      );
    }
  }

  // ===== SUSCRIPCIÓN ACTUALIZADA EN STRIPE PORTAL =====
  if (event.type === 'customer.subscription.updated') {
    const subscription = event.data.object;
    const priceId = subscription.items?.data?.[0]?.price?.id;
    const scheduledChange = await getScheduledPlanChange(subscription, priceId);
    const { usuario, plan, fechaFin, customer, updated } = await actualizarUsuarioDesdeSubscription(subscription, {
      pendingPlan: scheduledChange?.pendingPlan || null,
      pendingPriceId: scheduledChange?.pendingPriceId || null,
      pendingPlanChangeAt: scheduledChange?.pendingPlanChangeAt || null,
      pendingPlanLabel: scheduledChange?.pendingPlanLabel || null
    });

    console.log('Webhook subscription.updated recibido', {
      customer,
      subscriptionId: subscription.id,
      priceIdDetectado: priceId,
      planDetectado: plan,
      usuarioEncontrado: Boolean(usuario),
      resultadoUpdate: updated,
      status: subscription.status,
      schedule: typeof subscription.schedule === 'string' ? subscription.schedule : subscription.schedule?.id || null,
      pendingPlan: scheduledChange?.pendingPlan || null,
      pendingPlanChangeAt: scheduledChange?.pendingPlanChangeAt?.toISOString() || null,
      usuarioIdActualizado: usuario?._id?.toString() || null,
      planFechaFin: fechaFin?.toISOString() || null
    });
  }

  // ===== PAGO FALLIDO =====
  if (event.type === 'invoice.payment_failed') {
    const invoice = event.data.object;
    const subscriptionId = invoice.subscription;
    if (!subscriptionId) return res.json({ received: true });

    const usuario = await Usuario.findOne({ stripeSubscriptionId: subscriptionId });

    if (usuario?.email) {
      await enviarCorreo(
        usuario.email,
        `⚠️ Problema con tu pago — HomeClick24`,
        `
          <p>Ha habido un problema al renovar tu suscripción. Por favor actualiza tu método de pago para no perder el acceso.</p>
        `,
        {
          title: "No hemos podido procesar tu pago",
          cta: {
            label: "Actualizar método de pago",
            url: "https://www.homeclick24.com/perfil"
          }
        }
      );
    }
  }

  // ===== SUSCRIPCIÓN CANCELADA =====
  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const { usuario, priceId, plan, fechaFin, customer, updated } = await actualizarUsuarioDesdeSubscription(subscription, {
      pendingPlan: null,
      pendingPriceId: null,
      pendingPlanChangeAt: null,
      pendingPlanLabel: null
    });

    console.log('Webhook subscription.deleted recibido', {
      customer,
      subscriptionId: subscription.id,
      priceIdDetectado: priceId,
      planDetectado: plan,
      usuarioEncontrado: Boolean(usuario),
      resultadoUpdate: updated,
      usuarioIdActualizado: usuario?._id?.toString() || null,
      planFechaFin: fechaFin?.toISOString() || null
    });

    if (usuario?.email) {
      await enviarCorreo(
        usuario.email,
        `😔 Tu suscripción ha finalizado — HomeClick24`,
        `
          <p>Tu plan ha expirado y tu cuenta ha vuelto al plan gratuito. Tus anuncios activos pueden haberse desactivado.</p>
        `,
        {
          title: "Tu suscripción ha finalizado",
          cta: {
            label: "Ver planes",
            url: "https://www.homeclick24.com/planes"
          }
        }
      );
    }
  }

  res.json({ received: true });
});

export default router;
