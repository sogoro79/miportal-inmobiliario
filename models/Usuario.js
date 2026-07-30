import mongoose from "mongoose";

const UsuarioSchema = new mongoose.Schema({
  nombre:     { type: String, required: true },
  email:      { type: String, required: true, unique: true },
  password:   { type: String, select: false },
  role:       { type: String, enum: ["user", "admin"], default: "user" },
  favoritos:  [{ type: mongoose.Schema.Types.ObjectId, ref: "Propiedad" }],
  verificado: { type: Boolean, default: false },
  activo:     { type: Boolean, default: true },
  desactivadoAt: { type: Date },
  token:      { type: String },
  tipoDoc:    { type: String },
  numDoc:     { type: String },

  // Suscripción Stripe
  plan:                  { type: String, default: "gratis" },
  stripeCustomerId:      { type: String },
  stripeSubscriptionId:  { type: String },
  subscriptionStatus:    { type: String },
  planActivo:            { type: Boolean, default: false },
  planFechaFin:          { type: Date },
  pendingPlan:           { type: String },
  pendingPriceId:        { type: String },
  pendingPlanChangeAt:   { type: Date },
  pendingPlanLabel:      { type: String },
  cancelAtPeriodEnd:     { type: Boolean, default: false },
  subscriptionCancelAt:  { type: Date },
  launchPromoEligible:   { type: Boolean, default: false },
  launchPromoApplied:    { type: Boolean, default: false },
  launchPromoCouponId:   { type: String },
  launchPromoSuccessfulPayments: { type: Number, default: 0 },
  launchPromoLastPaymentAt:      { type: Date },
  launchPromoAppliedAt:          { type: Date },
  launchPromoAppliedSubscriptionId: { type: String },

  // Prueba gratuita VIP
  trialAccepted:         { type: Boolean, default: false },
  trialStartDate:        { type: Date },
  trialEndDate:          { type: Date },
  trialLimitsAppliedAt:  { type: Date },
  trialLimitsRepairedAt: { type: Date },
  trialReminderSent:     { type: Boolean, default: false },
  trialReminders: {
    sevenDays:           { type: Boolean, default: false },
    threeDays:           { type: Boolean, default: false },
    lastDay:             { type: Boolean, default: false },
    expired:             { type: Boolean, default: false }
  },
}, { timestamps: true });

export default mongoose.model("Usuario", UsuarioSchema);
