import express from "express";
import { getPublicPlanCatalog } from "../utils/planLimits.js";

const router = express.Router();

router.get("/catalogo", (req, res) => {
  res.json({
    planes: getPublicPlanCatalog()
  });
});

export default router;
