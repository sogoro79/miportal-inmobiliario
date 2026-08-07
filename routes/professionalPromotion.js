import express from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth.js";
import { securityRateLimits } from "../utils/security.js";
import {
  activateProfessionalPromotion,
  getProfessionalPromotionStatusForUser,
  ProfessionalPromotionError
} from "../utils/professionalPromotion.js";

const router = express.Router();

function publicError(error) {
  if (error instanceof ProfessionalPromotionError) {
    return {
      status: error.status || 400,
      body: {
        error: error.message,
        code: [
          "email_not_verified",
          "incomplete_data",
          "campaign_expired",
          "paid_plan",
          "already_active"
        ].includes(error.code) ? error.code : "not_eligible"
      }
    };
  }
  return { status: 500, body: { error: "Error al procesar la promoción" } };
}

router.get("/estado", requireAuth, async (req, res) => {
  try {
    const status = await getProfessionalPromotionStatusForUser({
      userId: req.user.id,
      input: req.query || {}
    });
    res.json(status);
  } catch (error) {
    const safe = publicError(error);
    res.status(safe.status).json(safe.body);
  }
});

router.post("/activar", requireAuth, securityRateLimits.professionalPromotionActivation, async (req, res) => {
  try {
    const result = await activateProfessionalPromotion({
      userId: req.user.id,
      input: req.body || {},
      mongooseClient: mongoose
    });
    res.json(result);
  } catch (error) {
    const safe = publicError(error);
    res.status(safe.status).json(safe.body);
  }
});

export default router;
