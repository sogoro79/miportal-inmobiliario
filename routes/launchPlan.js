import express from "express";
import Usuario from "../models/Usuario.js";
import { requireAuth } from "../middleware/auth.js";
import {
  activateLaunchPlan,
  getLaunchPlanPublicStatus,
  LaunchPlanError
} from "../utils/launchPlan.js";

const router = express.Router();

function usuarioSeguro(usuario) {
  return {
    _id: usuario._id,
    nombre: usuario.nombre,
    email: usuario.email,
    plan: usuario.plan || "gratis",
    planActivo: Boolean(usuario.planActivo),
    planFechaFin: usuario.planFechaFin || null
  };
}

router.get("/estado", requireAuth, async (req, res) => {
  try {
    const usuario = await Usuario.findById(req.user.id);
    if (!usuario) return res.status(404).json({ error: "Usuario no encontrado." });
    res.json(getLaunchPlanPublicStatus(usuario));
  } catch (error) {
    res.status(500).json({ error: "Error consultando el Plan Lanzamiento." });
  }
});

router.post("/activar", requireAuth, async (req, res) => {
  try {
    const result = await activateLaunchPlan({
      userId: req.user.id,
      models: { Usuario }
    });

    res.json({
      ok: true,
      activated: result.activated,
      alreadyActive: result.alreadyActive,
      status: result.status,
      usuario: usuarioSeguro(result.usuario)
    });
  } catch (error) {
    if (error instanceof LaunchPlanError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    res.status(500).json({ error: "No se pudo activar el Plan Lanzamiento." });
  }
});

export default router;
