import mongoose from "mongoose";

const ProfessionalTrialRedemptionSchema = new mongoose.Schema({
  campaign: { type: String, required: true },
  normalizedIdentityHash: { type: String, required: true },
  normalizedPhoneHash: { type: String, required: true },
  hmacKeyVersion: { type: String, required: true, default: "jwt_secret_fallback_v1" },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "Usuario" },
  activatedAt: { type: Date, required: true },
  endsAt: { type: Date, required: true },
  status: {
    type: String,
    enum: ["active", "expired", "converted", "blocked"],
    default: "active"
  }
}, { timestamps: true });

ProfessionalTrialRedemptionSchema.index(
  { campaign: 1, normalizedIdentityHash: 1 },
  { unique: true }
);
ProfessionalTrialRedemptionSchema.index(
  { campaign: 1, normalizedPhoneHash: 1 },
  { unique: true }
);
ProfessionalTrialRedemptionSchema.index({ campaign: 1, userId: 1 });
ProfessionalTrialRedemptionSchema.index({ campaign: 1, status: 1, endsAt: 1 });

export default mongoose.model("ProfessionalTrialRedemption", ProfessionalTrialRedemptionSchema);
