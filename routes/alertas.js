import express from "express";
import Alerta from "../models/Alerta.js";
import { requireAuth } from "../middleware/auth.js";
import { optionalCleanString, optionalNumberFromInput, validateBody, z } from "../utils/validation.js";
import { securityRateLimits } from "../utils/security.js";

const router = express.Router();

const alertaCreateSchema = z.object({
  tipoOperacion: optionalCleanString(40),
  ciudad: optionalCleanString(120),
  precioMin: optionalNumberFromInput,
  precioMax: optionalNumberFromInput,
  habitaciones: optionalNumberFromInput
}).strict();

/* Crear alerta */
router.post("/", requireAuth, securityRateLimits.alertCreate, validateBody(alertaCreateSchema), async (req, res) => {
  try {
    const nuevaAlerta = new Alerta({
      tipoOperacion: req.body.tipoOperacion,
      ciudad: req.body.ciudad,
      precioMin: req.body.precioMin,
      precioMax: req.body.precioMax,
      habitaciones: req.body.habitaciones,
      usuarioId: req.user.id
    });
    await nuevaAlerta.save();
    res.status(201).json(nuevaAlerta);
  } catch (error) {
    res.status(500).json({ error: "Error al crear alerta" });
  }
});

/* Obtener alertas de un usuario */
router.get("/:usuarioId", requireAuth, async (req, res) => {
  try {
    if (String(req.params.usuarioId) !== req.user.id) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const alertas = await Alerta.find({
      usuarioId: req.params.usuarioId,
      activa: true
    });

    res.json(alertas);
  } catch (error) {
    res.status(500).json({ error: "Error al obtener alertas" });
  }
});

/* Eliminar alerta */
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const alerta = await Alerta.findById(req.params.id);
    if (!alerta) return res.status(404).json({ error: "Alerta no encontrada" });
    if (String(alerta.usuarioId) !== req.user.id) {
      return res.status(403).json({ error: "No autorizado" });
    }

    await Alerta.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: "Error al eliminar alerta" });
  }
});

export default router;
