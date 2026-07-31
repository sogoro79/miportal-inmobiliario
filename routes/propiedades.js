import "dotenv/config";
import express from "express";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import Propiedad from "../models/Propiedad.js";
import EstadisticaAnuncio from "../models/EstadisticaAnuncio.js";
import Alerta from "../models/Alerta.js";
import Notificacion from "../models/Notificacion.js";
import Usuario from "../models/Usuario.js";
import { enviarCorreo } from "../utils/email.js";
import { requireAuth } from "../middleware/auth.js";
import { securityRateLimits } from "../utils/security.js";
import {
  getImageUploadErrorResponse,
  getUploadedImageUrls,
  InvalidExistingImagesError,
  MAX_FILES_PER_REQUEST,
  parseImagenesExistentes,
  validateExistingImageOwnership
} from "../utils/imageSecurity.js";
import {
  CLOUDINARY_ALLOWED_FORMATS,
  CLOUDINARY_UPLOAD_TRANSFORMATION,
  configureCloudinary,
  destroyImagesByUrls
} from "../utils/cloudinaryService.js";
import {
  calcularFechaExpiracionPlan,
  getLimiteAnunciosPlan,
  getLimiteFotosPlan,
  planTieneLimiteFotos
} from "../utils/planLimits.js";
import { filtroNoCaducado } from "../utils/freeListingExpiration.js";
import { limitarFotosPublicasPorPlan } from "../utils/trialPlanLimits.js";
import {
  cleanString,
  isObjectId,
  numberFromInput,
  optionalCleanString,
  optionalNumberFromInput,
  priceFromInput,
  validateQuery,
  z
} from "../utils/validation.js";

const router = express.Router();

const tipoOperacionSchema = z.enum(["venta", "alquiler"]);
const tipoInmuebleSchema = z.enum([
  "piso", "apartamento", "atico", "duplex", "estudio",
  "casa", "chalet", "adosado", "casa_campo", "casa_madera",
  "local", "local_comercial", "oficina", "nave", "hotel", "edificio", "negocio",
  "terreno", "solar_urbano", "parcela", "finca_rustica", "finca_urbana",
  "garaje", "plaza_aparcamiento", "trastero", "otro"
]);
const tiposConPlanta = new Set([
  "piso", "apartamento", "atico", "duplex", "estudio",
  "local", "local_comercial", "oficina"
]);
const tiposViviendaCompleta = new Set(["casa", "chalet", "adosado", "casa_campo", "casa_madera"]);
const estadoSchema = z.enum(["obra_nueva", "segunda_mano"]);
const certificadoEnergeticoSchema = z.enum([
  "A", "B", "C", "D", "E", "F", "G",
  "No disponible", "Exento", "En trámite"
]);
const estadoPropiedadSchema = z.enum(["Obra nueva", "Segunda mano", "Reformado", "A reformar"]);
const estadoComercialSchema = z.enum(["Disponible", "Reservado", "Vendido", "Alquilado"]);
const booleanInput = z
  .preprocess(value => typeof value === "boolean" ? String(value) : value, z.enum(["true", "false"]))
  .optional();
const imagenMimeTypesPermitidos = new Set(["image/jpeg", "image/png", "image/webp"]);
const requiredCleanString = (max, label) =>
  z.preprocess(
    value => typeof value === "string" ? value.trim().replace(/\s+/g, " ") : value,
    z.string().min(1, `${label} es obligatorio`).max(max)
  );

const propiedadesQuerySchema = z.object({
  tipo: tipoOperacionSchema.optional(),
  min: optionalNumberFromInput,
  max: optionalNumberFromInput,
  hab: optionalNumberFromInput,
  texto: optionalCleanString(120),
  zona: z.enum([
    "cadiz",
    "el-puerto-de-santa-maria",
    "jerez-de-la-frontera",
    "sanlucar-de-barrameda",
    "rota",
    "chipiona"
  ]).optional(),
  banos: optionalNumberFromInput,
  sup_min: optionalNumberFromInput,
  sup_max: optionalNumberFromInput,
  tipoInmueble: tipoInmuebleSchema.optional(),
  estado: estadoSchema.optional(),
  garaje: z.enum(["true"]).optional(),
  piscina: z.enum(["true"]).optional(),
  terraza: z.enum(["true"]).optional()
});

const propiedadBaseSchema = {
  titulo: requiredCleanString(160, "titulo"),
  referencia: optionalCleanString(80),
  direccion: requiredCleanString(300, "direccion"),
  precio: priceFromInput.pipe(z.number().min(0)),
  descripcion: optionalCleanString(5000),
  tipoOperacion: tipoOperacionSchema,
  habitaciones: numberFromInput.pipe(z.number().int().min(0)),
  lat: optionalNumberFromInput,
  lng: optionalNumberFromInput,
  videoUrl: optionalCleanString(500),
  banos: optionalNumberFromInput,
  superficie: optionalNumberFromInput,
  superficieParcela: optionalNumberFromInput,
  tipoInmueble: tipoInmuebleSchema.optional(),
  estado: estadoSchema.optional(),
  certificadoEnergetico: certificadoEnergeticoSchema.optional(),
  estadoPropiedad: estadoPropiedadSchema.optional(),
  estadoComercial: estadoComercialSchema.optional(),
  garaje: booleanInput,
  piscina: booleanInput,
  terraza: booleanInput,
  escaparate: booleanInput,
  usoPermitido: optionalCleanString(200),
  plantaLocal: optionalCleanString(80),
  numeroPlantas: z.enum(["1", "2", "3", "4_mas", ""]).optional(),
  sotano: z.enum(["si", "no", ""]).optional(),
  tipoGaraje: optionalCleanString(40),
  alturaMaxima: optionalNumberFromInput,
  accesoTrastero: optionalCleanString(80),
  imagenesExistentes: z.any().optional()
};

const propiedadCreateSchema = z.object(propiedadBaseSchema);
const propiedadUpdateSchema = z.object({
  ...propiedadBaseSchema,
  titulo: propiedadBaseSchema.titulo.optional(),
  direccion: propiedadBaseSchema.direccion.optional(),
  precio: propiedadBaseSchema.precio.optional(),
  tipoOperacion: tipoOperacionSchema.optional(),
  habitaciones: propiedadBaseSchema.habitaciones.optional()
});

function escapeRegex(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const zonaSeoAliases = {
  cadiz: ["Cadiz", "Cádiz"],
  "el-puerto-de-santa-maria": ["El Puerto de Santa Maria", "El Puerto de Santa María", "Puerto de Santa Maria", "Puerto de Santa María"],
  "jerez-de-la-frontera": ["Jerez de la Frontera", "Jerez"],
  "sanlucar-de-barrameda": ["Sanlucar de Barrameda", "Sanlúcar de Barrameda", "Sanlucar", "Sanlúcar"],
  rota: ["Rota"],
  chipiona: ["Chipiona"]
};

function regexZonaSeo(slug) {
  const aliases = zonaSeoAliases[slug] || [];
  return aliases.map(escapeRegex).join("|");
}

function extraerLocalidadPropiedad(propiedad = {}) {
  if (propiedad.ciudad) return propiedad.ciudad;
  if (propiedad.localidad) return propiedad.localidad;

  const partes = String(propiedad.direccion || "")
    .split(",")
    .map(p => p.trim())
    .filter(Boolean)
    .filter(p => !/^\d{4,6}$/.test(p));

  const descartadas = new Set(["españa", "andalucía", "cadiz", "cádiz", "costa noroeste"]);
  const limpias = partes.filter(p => !descartadas.has(p.toLowerCase()));

  return limpias.length > 1 ? limpias[limpias.length - 1] : "";
}

function getPlanParaFotos(usuario) {
  let plan = usuario?.plan || "gratis";
  if (plan === "vip_trial" && (!usuario.trialAccepted || !usuario.planActivo)) {
    plan = "gratis";
  }
  return plan;
}

function getPlanParaLimites(usuario) {
  let plan = usuario?.plan || "gratis";
  if (plan === "vip_trial" && (!usuario.trialAccepted || !usuario.planActivo)) {
    plan = "gratis";
  }
  return plan;
}

async function limpiarImagenesSubidas(filesOrUrls = []) {
  const urls = Array.isArray(filesOrUrls) && filesOrUrls.some(item => typeof item !== "string")
    ? getUploadedImageUrls(filesOrUrls)
    : filesOrUrls;
  return destroyImagesByUrls(urls, { client: cloudinary });
}

async function eliminarImagenesCloudinary(urls = []) {
  return destroyImagesByUrls(urls, { client: cloudinary });
}

function logPublicacion(estado, data = {}) {
  console.log("[Publicacion]", { estado, ...data });
}

function getIssueField(issue) {
  return issue.path?.length ? issue.path.join(".") : "datos";
}

function buildValidationResponse(error) {
  const fields = [...new Set(error.issues.map(getIssueField))];
  return {
    error: fields.length
      ? `Revisa estos campos: ${fields.join(", ")}`
      : "Datos inválidos"
  };
}

async function validateBodyOrCleanup(schema, req, res, urlsSubidas, logLabel) {
  const parsed = schema.safeParse(req.body);
  if (parsed.success) {
    req.body = parsed.data;
    return true;
  }

  if (logLabel) {
    console.warn(`[VALIDATION:${logLabel}]`, {
      fields: [...new Set(parsed.error.issues.map(getIssueField))]
    });
  }
  await limpiarImagenesSubidas(urlsSubidas);
  res.status(400).json(buildValidationResponse(parsed.error));
  return false;
}

function usuarioTienePlanActivoParaPublicar(usuario) {
  const plan = usuario?.plan || "gratis";
  if (plan === "gratis") return true;
  if (plan === "vip_trial") return Boolean(usuario.trialAccepted && usuario.planActivo);
  return Boolean(usuario.planActivo);
}

function filtroPropiedadesValidasVisibles(usuarioId) {
  return {
    usuarioId,
    visiblePublicamente: { $ne: false },
    activo: { $ne: false },
    eliminada: { $ne: true },
    oculto: { $ne: true },
    estadoComercial: { $nin: ["Vendido", "Alquilado", "Reservado", "No disponible"] }
  };
}

function filtroPropiedadesPublicas(now = new Date()) {
  return {
    visiblePublicamente: { $ne: false },
    ...filtroNoCaducado(now)
  };
}

// ==================================================
// CLOUDINARY CONFIG
// ==================================================
configureCloudinary({ client: cloudinary });

const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder: "miportal_inmobiliario",
    allowed_formats: CLOUDINARY_ALLOWED_FORMATS,
    transformation: CLOUDINARY_UPLOAD_TRANSFORMATION
  })
});

const upload = multer({
  storage,
  limits: {
    fileSize: 15 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    if (!imagenMimeTypesPermitidos.has(file.mimetype)) {
      const err = new Error("Formato de imagen no permitido. Sube imágenes JPG, PNG o WEBP.");
      err.statusCode = 400;
      return cb(err);
    }

    const plan = getPlanParaFotos(req.user);
    const maxFotos = getLimiteFotosPlan(plan);
    req.imagenesRecibidas = (req.imagenesRecibidas || 0) + 1;

    if (planTieneLimiteFotos(plan) && req.imagenesRecibidas > maxFotos) {
      const err = new Error(`Tu plan permite un máximo de ${maxFotos} fotos por anuncio.`);
      err.statusCode = 403;
      return cb(err);
    }

    cb(null, true);
  }
});

function uploadImagenes(req, res, next) {
  upload.array("imagenes", MAX_FILES_PER_REQUEST)(req, res, async err => {
    if (!err) return next();
    await limpiarImagenesSubidas(req.files);
    const isMulterError = err instanceof multer.MulterError;
    const { status, message: mensaje } = getImageUploadErrorResponse(err, { isMulterError });

    logPublicacion("error_imagenes", {
      status,
      code: err.code || null,
      message: mensaje,
      userId: req.user?.id || null,
      plan: req.user?.plan || null
    });

    return res.status(status).json({
      error: mensaje
    });
  });
}

async function cargarPropiedadEditable(req, res, next) {
  try {
    if (!isObjectId(req.params.id)) {
      return res.status(400).json({ message: "ID inválido" });
    }

    const propiedad = await Propiedad.findById(req.params.id);
    if (!propiedad) return res.status(404).json({ message: "Propiedad no encontrada" });
    if (String(propiedad.usuarioId) !== req.user.id) {
      return res.status(403).json({ error: "No autorizado" });
    }

    req.propiedadEditable = propiedad;
    return next();
  } catch {
    return res.status(500).json({ message: "Error al editar propiedad" });
  }
}

function inicioDia(fecha = new Date()) {
  const dia = new Date(fecha);
  dia.setHours(0, 0, 0, 0);
  return dia;
}

// ==================================================
// GET /propiedades — con filtros
// ==================================================
router.get("/", validateQuery(propiedadesQuerySchema), async (req, res) => {
  try {
    const { tipo, min, max, hab, texto, zona } = req.query;
    const filtro = filtroPropiedadesPublicas();
    const condicionesTexto = [];

    if (tipo) filtro.tipoOperacion = tipo;

    if (min || max) {
      filtro.precio = {};
      if (min) filtro.precio.$gte = Number(min);
      if (max) filtro.precio.$lte = Number(max);
    }

    if (hab) filtro.habitaciones = { $gte: Number(hab) };

    const { banos, sup_min, sup_max, tipoInmueble, estado, garaje, piscina, terraza } = req.query;

    if (banos) filtro.banos = { $gte: Number(banos) };

    if (sup_min || sup_max) {
      filtro.superficie = {};
      if (sup_min) filtro.superficie.$gte = Number(sup_min);
      if (sup_max) filtro.superficie.$lte = Number(sup_max);
    }

    if (tipoInmueble) {
      filtro.tipoInmueble = ["local", "local_comercial"].includes(tipoInmueble)
        ? { $in: ["local", "local_comercial"] }
        : tipoInmueble;
    }
    if (estado)       filtro.estado = estado;
    if (garaje === "true")  filtro.garaje = true;
    if (piscina === "true") filtro.piscina = true;
    if (terraza === "true") filtro.terraza = true;

    if (texto) {
      condicionesTexto.push({
        $or: [
          { titulo: { $regex: texto, $options: "i" } },
          { direccion: { $regex: texto, $options: "i" } }
        ]
      });
    }

    if (zona) {
      const zonaRegex = regexZonaSeo(zona);
      condicionesTexto.push({
        $or: [
          { titulo: { $regex: zonaRegex, $options: "i" } },
          { direccion: { $regex: zonaRegex, $options: "i" } }
        ]
      });
    }

    if (condicionesTexto.length) {
      filtro.$and = condicionesTexto;
    }

    const propiedades = await Propiedad.find(filtro).sort({ createdAt: -1 }).lean();
    res.json(await limitarFotosPublicasPorPlan(propiedades));

  } catch (err) {
    console.error("Error al obtener propiedades:", {
      name: err.name,
      message: err.message
    });
    res.status(500).json({ message: "Error al obtener propiedades" });
  }
});

// ==================================================
// GET /propiedades/destacadas — bloque público home
// ==================================================
router.get("/destacadas", async (req, res) => {
  try {
    const propiedades = await Propiedad.find(filtroPropiedadesPublicas())
      .sort({
        destacado: -1,
        esDestacada: -1,
        destacada: -1,
        updatedAt: -1,
        createdAt: -1
      })
      .limit(8)
      .lean();

    res.json(await limitarFotosPublicasPorPlan(propiedades));
  } catch (err) {
    console.error("Error obteniendo propiedades destacadas:", err.message);
    res.status(500).json({ error: "Error al obtener propiedades destacadas" });
  }
});

// ==================================================
// GET /propiedades/ultimas — últimos anuncios públicos home
// ==================================================
router.get("/ultimas", async (req, res) => {
  try {
    const propiedades = await Propiedad.find(
      filtroPropiedadesPublicas(),
      {
        titulo: 1,
        precio: 1,
        tipoOperacion: 1,
        tipoInmueble: 1,
        direccion: 1,
        ciudad: 1,
        localidad: 1,
        habitaciones: 1,
        banos: 1,
        superficie: 1,
        imagenes: 1,
        usuarioId: 1,
        createdAt: 1
      }
    )
      .sort({ createdAt: -1 })
      .limit(8)
      .lean();

    res.json(await limitarFotosPublicasPorPlan(propiedades));
  } catch (err) {
    console.error("Error obteniendo últimos anuncios:", err.message);
    res.status(500).json({ error: "Error al obtener últimos anuncios" });
  }
});

// ==================================================
// GET /propiedades/relacionadas/:id — anuncios similares
// ==================================================
router.get("/relacionadas/:id", async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) {
      return res.status(400).json({ message: "ID inválido" });
    }

    const actual = await Propiedad.findById(req.params.id).lean();
    if (
      !actual ||
      actual.visiblePublicamente === false ||
      (actual.fechaExpiracion && actual.fechaExpiracion <= new Date())
    ) {
      return res.status(404).json({ message: "Propiedad no encontrada" });
    }

    const projection = {
      titulo: 1,
      precio: 1,
      tipoOperacion: 1,
      tipoInmueble: 1,
      direccion: 1,
      ciudad: 1,
      localidad: 1,
      habitaciones: 1,
      banos: 1,
      superficie: 1,
      imagenes: 1,
      usuarioId: 1,
      createdAt: 1
    };
    const base = { visiblePublicamente: true };
    const relacionadas = [];
    const idsUsados = new Set([String(actual._id)]);

    const agregar = (items = []) => {
      items.forEach(item => {
        const id = String(item._id);
        if (relacionadas.length < 4 && !idsUsados.has(id)) {
          idsUsados.add(id);
          relacionadas.push(item);
        }
      });
    };
    const buscar = async (filtro = {}) => {
      const { $or, ...restoFiltro } = filtro;
      const condiciones = [filtroNoCaducado()];
      if ($or) condiciones.push({ $or });

      return Propiedad.find(
        { ...base, _id: { $nin: [...idsUsados] }, ...restoFiltro, $and: condiciones },
        projection
      )
        .sort({ createdAt: -1 })
        .limit(4 - relacionadas.length)
        .lean();
    };

    const localidad = extraerLocalidadPropiedad(actual);
    if (localidad) {
      const localidadRegex = new RegExp(escapeRegex(localidad), "i");
      agregar(await limitarFotosPublicasPorPlan(await buscar({
        $or: [
          { ciudad: localidadRegex },
          { localidad: localidadRegex },
          { direccion: localidadRegex }
        ]
      })));
    }

    if (relacionadas.length < 4 && actual.tipoOperacion) {
      agregar(await limitarFotosPublicasPorPlan(await buscar({ tipoOperacion: actual.tipoOperacion })));
    }

    if (relacionadas.length < 4) {
      agregar(await limitarFotosPublicasPorPlan(await buscar({})));
    }

    res.json(relacionadas);
  } catch (err) {
    console.error("Error obteniendo propiedades relacionadas:", err.message);
    res.status(500).json({ error: "Error al obtener propiedades relacionadas" });
  }
});

// ==================================================
// GET /propiedades/mias — anuncios del propietario
// ==================================================
router.get("/mias", requireAuth, async (req, res) => {
  try {
    const propiedades = await Propiedad.find({ usuarioId: req.user.id }).sort({ createdAt: -1 });
    res.json(propiedades);
  } catch (err) {
    res.status(500).json({ message: "Error al obtener propiedades" });
  }
});

router.get("/mias/:id", requireAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) {
      return res.status(400).json({ message: "ID inválido" });
    }

    const propiedad = await Propiedad.findOne({
      _id: req.params.id,
      usuarioId: req.user.id
    });

    if (!propiedad) return res.status(404).json({ message: "Propiedad no encontrada" });
    res.json(propiedad);
  } catch (err) {
    res.status(400).json({ message: "ID inválido" });
  }
});

// ==================================================
// GET /propiedades/:id
// ==================================================
router.get("/:id", async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) {
      return res.status(400).json({ message: "ID inválido" });
    }

    const propiedad = await Propiedad.findByIdAndUpdate(
      req.params.id,
      { $inc: { visitas: 1 }, $set: { ultimaVisita: new Date() } },
      { new: true }
    );
    if (!propiedad) return res.status(404).json({ message: "Propiedad no encontrada" });
    if (propiedad.visiblePublicamente === false) {
      return res.status(404).json({ message: "Propiedad no encontrada" });
    }
    if (propiedad.fechaExpiracion && propiedad.fechaExpiracion <= new Date()) {
      return res.status(404).json({ message: "Propiedad no encontrada" });
    }
    if (propiedad.usuarioId) {
      EstadisticaAnuncio.updateOne(
        { propiedadId: propiedad._id, fecha: inicioDia() },
        {
          $setOnInsert: { usuarioId: propiedad.usuarioId },
          $inc: { visitas: 1 }
        },
        { upsert: true }
      ).catch(err => console.warn("No se pudo registrar visita diaria:", err.message));
    }
    res.json(await limitarFotosPublicasPorPlan(propiedad));
  } catch (err) {
    res.status(400).json({ message: "ID inválido" });
  }
});

// ==================================================
// POST /propiedades — crear propiedad con imágenes
// ==================================================
router.post("/", requireAuth, securityRateLimits.propertyUpload, uploadImagenes, async (req, res) => {
  const urlsSubidas = getUploadedImageUrls(req.files);
  let debeLimpiarSubidas = true;
  try {
    const bodyValido = await validateBodyOrCleanup(propiedadCreateSchema, req, res, urlsSubidas, "POST /propiedades");
    if (!bodyValido) return;

    const {
      titulo,
      direccion,
      precio,
      descripcion,
      tipoOperacion,
      habitaciones,
      lat,
      lng,
      videoUrl
    } = req.body;
    const usuarioId = req.user.id;

    let usuario = null;
    let plan = "gratis";

    usuario = await Usuario.findById(usuarioId);

    if (usuario) {
      if (!usuarioTienePlanActivoParaPublicar(usuario)) {
        logPublicacion("plan_inactivo", {
          userId: usuarioId,
          plan: usuario.plan || "gratis",
          planActivo: Boolean(usuario.planActivo)
        });
        await limpiarImagenesSubidas(urlsSubidas);
        return res.status(403).json({
          error: "Necesitas activar un plan para publicar."
        });
      }

      plan = getPlanParaLimites(usuario);
      
      const limite = getLimiteAnunciosPlan(plan);
      // Límite de fotos
      const planFotos = getPlanParaFotos(usuario);
      const maxFotos = getLimiteFotosPlan(planFotos);
      const numFotos = req.files?.length || 0;
      if (planTieneLimiteFotos(planFotos) && numFotos > maxFotos) {
        logPublicacion("limite_fotos", {
          userId: usuarioId,
          plan: planFotos,
          recibidas: numFotos,
          limite: maxFotos
        });
        await limpiarImagenesSubidas(urlsSubidas);
        return res.status(403).json({
          error: `Tu plan permite un máximo de ${maxFotos} fotos por anuncio.`
        });
      }
      const totalAnuncios = await Propiedad.countDocuments(filtroPropiedadesValidasVisibles(usuarioId));
      if (totalAnuncios >= limite) {
        logPublicacion("limite_anuncios", {
          userId: usuarioId,
          plan,
          totalAnuncios,
          limite
        });
        await limpiarImagenesSubidas(urlsSubidas);
        return res.status(403).json({ 
          error: `Has alcanzado el límite de anuncios de tu plan ${plan}. Mejora tu plan para publicar más.` 
        });
      }
    }

    const imagenes = urlsSubidas;

    const {
      banos,
      superficie,
      tipoInmueble,
      estado,
      certificadoEnergetico,
      estadoPropiedad,
      estadoComercial,
      plantaLocal,
      numeroPlantas,
      sotano,
      garaje,
      piscina,
      terraza
    } = req.body;

    // Calcular expiración
    let fechaExpiracion = null;
    if (plan === "gratis") {
      fechaExpiracion = calcularFechaExpiracionPlan(plan);
    }

    const propiedad = await Propiedad.create({
      titulo,
      referencia:    req.body.referencia || "",
      direccion,
      precio:        Number(precio),
      descripcion,

      videoUrl: videoUrl || "",

      tipoOperacion,
      habitaciones:  Number(habitaciones),
      banos:         Number(banos) || 1,
      superficie:    superficie ? Number(superficie) : null,
      superficieParcela:  req.body.superficieParcela ? Number(req.body.superficieParcela) : null,
      tipoInmueble:  tipoInmueble || "piso",
      estado:        estado || "segunda_mano",
      certificadoEnergetico: certificadoEnergetico || "",
      estadoPropiedad: estadoPropiedad || "",
      estadoComercial: estadoComercial || "Disponible",
      plantaLocal: tiposConPlanta.has(tipoInmueble || "piso") ? (plantaLocal || "") : "",
      numeroPlantas: tiposViviendaCompleta.has(tipoInmueble || "piso") ? (numeroPlantas || "") : "",
      sotano: tiposViviendaCompleta.has(tipoInmueble || "piso") ? (sotano || "") : "",
      garaje:        garaje === "true",
      piscina:       piscina === "true",
      terraza:       terraza === "true",
      usuarioId:     usuarioId || null,
      lat:           lat ? Number(lat) : null,
      lng:           lng ? Number(lng) : null,
      imagenes,
      fechaExpiracion
    });
    debeLimpiarSubidas = false;

    if (usuario?.email) {

  await enviarCorreo(
    usuario.email,
    "Anuncio publicado en HomeClick24",
    `
      <h1>Tu anuncio ya está publicado 🏡</h1>

      <p>Hola ${usuario.nombre || ""},</p>

      <p>
        Tu propiedad <strong>${propiedad.titulo}</strong>
        ya está activa en HomeClick24.
      </p>

      <p>
        Dirección: ${propiedad.direccion}
      </p>

      <p>
        Precio: ${propiedad.precio} €
      </p>

      <br>

      <p>Gracias por usar HomeClick24 🚀</p>
    `
  );

}

    // Buscar alertas que coincidan
    console.log("Nueva propiedad creada:", propiedad.titulo);
    logPublicacion("creada", {
      userId: usuarioId,
      propiedadId: propiedad._id.toString(),
      plan,
      fotos: imagenes.length
    });

    const alertasCoincidentes = await Alerta.find({
      activa: true,
      tipoOperacion: propiedad.tipoOperacion,
      precioMax: { $gte: propiedad.precio },
      habitaciones: { $lte: propiedad.habitaciones }
    });

    console.log("Alertas encontradas:", alertasCoincidentes);

    if (alertasCoincidentes.length > 0) {
      console.log("Hay usuarios interesados en esta propiedad");

      for (const alerta of alertasCoincidentes) {
        await Notificacion.create({
          usuarioId: alerta.usuarioId,
          propiedadId: propiedad._id,
          mensaje: `Nueva propiedad que coincide con tu alerta: ${propiedad.titulo}`
        });

        console.log("Notificación creada para:", alerta.usuarioId);
      }

    } else {
      console.log("No hay alertas compatibles");
    }

    for (const alerta of alertasCoincidentes) {
      console.log(
        "Coincidencia:",
        alerta.usuarioId,
        "→ propiedad:",
        propiedad._id
      );
    }

    res.status(201).json(propiedad);

  } catch (err) {
    if (debeLimpiarSubidas) {
      await limpiarImagenesSubidas(urlsSubidas);
    }
    logPublicacion("error_servidor", {
      userId: req.user?.id || null,
      message: err.message,
      name: err.name
    });
    console.error("Error al crear propiedad:", {
      name: err.name,
      message: err.message
    });
    res.status(500).json({ message: "Error al crear propiedad" });
  }
});

// ==================================================
// PUT /propiedades/:id — editar propiedad
// ==================================================
router.put("/:id", requireAuth, securityRateLimits.propertyUpload, cargarPropiedadEditable, uploadImagenes, async (req, res) => {
  const urlsSubidas = getUploadedImageUrls(req.files);
  let debeLimpiarSubidas = true;
  try {
    const propiedad = req.propiedadEditable;
    const imagenesOriginales = [...(propiedad.imagenes || [])];

    const bodyValido = await validateBodyOrCleanup(propiedadUpdateSchema, req, res, urlsSubidas);
    if (!bodyValido) return;

    const {
      titulo, direccion, precio, descripcion,
      tipoOperacion, habitaciones, lat, lng
    } = req.body;

    propiedad.titulo       = titulo || propiedad.titulo;
    propiedad.referencia   = req.body.referencia !== undefined ? req.body.referencia : propiedad.referencia;
    propiedad.direccion    = direccion || propiedad.direccion;
    propiedad.precio       = precio !== undefined ? Number(precio) : propiedad.precio;
    propiedad.descripcion  = descripcion || propiedad.descripcion;
    propiedad.tipoOperacion = tipoOperacion || propiedad.tipoOperacion;
    const {
      banos,
      superficie,
      tipoInmueble,
      estado,
      certificadoEnergetico,
      estadoPropiedad,
      estadoComercial,
      plantaLocal,
      numeroPlantas,
      sotano,
      garaje,
      piscina,
      terraza
    } = req.body;

    propiedad.habitaciones = habitaciones ? Number(habitaciones) : propiedad.habitaciones;
    propiedad.banos        = banos ? Number(banos) : propiedad.banos;
    propiedad.superficieParcela = req.body.superficieParcela ? Number(req.body.superficieParcela) : propiedad.superficieParcela;
    propiedad.superficie   = superficie ? Number(superficie) : propiedad.superficie;
    propiedad.tipoInmueble = tipoInmueble || propiedad.tipoInmueble;
    propiedad.estado       = estado || propiedad.estado;
    propiedad.certificadoEnergetico = certificadoEnergetico !== undefined ? certificadoEnergetico : propiedad.certificadoEnergetico;
    propiedad.estadoPropiedad = estadoPropiedad !== undefined ? estadoPropiedad : propiedad.estadoPropiedad;
    propiedad.estadoComercial = estadoComercial !== undefined ? estadoComercial : propiedad.estadoComercial;
    if (plantaLocal !== undefined || tipoInmueble !== undefined) {
      propiedad.plantaLocal = tiposConPlanta.has(propiedad.tipoInmueble)
        ? (plantaLocal || "")
        : "";
    }
    if (numeroPlantas !== undefined || sotano !== undefined || tipoInmueble !== undefined) {
      const admitePlantas = tiposViviendaCompleta.has(propiedad.tipoInmueble);
      propiedad.numeroPlantas = admitePlantas ? (numeroPlantas || "") : "";
      propiedad.sotano = admitePlantas ? (sotano || "") : "";
    }
    propiedad.garaje       = garaje !== undefined ? garaje === "true" : propiedad.garaje;
    propiedad.piscina      = piscina !== undefined ? piscina === "true" : propiedad.piscina;
    propiedad.terraza      = terraza !== undefined ? terraza === "true" : propiedad.terraza;
    propiedad.lat          = lat ? Number(lat) : propiedad.lat;
    propiedad.lng          = lng ? Number(lng) : propiedad.lng;
    
    const imagenesExistentes = validateExistingImageOwnership(
      parseImagenesExistentes(req.body.imagenesExistentes, { absentValue: imagenesOriginales }),
      imagenesOriginales
    );

    const nuevasImagenes = urlsSubidas;
    const planFotos = getPlanParaFotos(req.user);
    const maxFotos = getLimiteFotosPlan(planFotos);
    const totalFotos = imagenesExistentes.length + nuevasImagenes.length;
    if (planTieneLimiteFotos(planFotos) && totalFotos > maxFotos) {
      await limpiarImagenesSubidas(urlsSubidas);
      return res.status(403).json({
        error: `Tu plan permite un máximo de ${maxFotos} fotos por anuncio.`
      });
    }

    propiedad.imagenes = [
      ...imagenesExistentes,
      ...nuevasImagenes
    ];

    await propiedad.save();
    debeLimpiarSubidas = false;
    const imagenesConservadas = new Set(imagenesExistentes);
    const imagenesRetiradas = imagenesOriginales.filter(url => !imagenesConservadas.has(url));
    await eliminarImagenesCloudinary(imagenesRetiradas);
    res.json(propiedad);

  } catch (err) {
    if (debeLimpiarSubidas) {
      await limpiarImagenesSubidas(urlsSubidas);
    }
    if (err instanceof InvalidExistingImagesError) {
      return res.status(err.statusCode).json({ error: "Imágenes existentes no válidas" });
    }
    console.error("Error al editar propiedad:", {
      name: err.name,
      message: err.message
    });
    res.status(500).json({ message: "Error al editar propiedad" });
  }
});

// ==================================================
// DELETE /propiedades/:id — eliminar propiedad
// ==================================================
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) {
      return res.status(400).json({ message: "ID inválido" });
    }

    const propiedad = await Propiedad.findById(req.params.id);
    if (!propiedad) return res.status(404).json({ message: "Propiedad no encontrada" });
    if (String(propiedad.usuarioId) !== req.user.id) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const imagenesParaEliminar = [...(propiedad.imagenes || [])];
    await Propiedad.findByIdAndDelete(req.params.id);
    await eliminarImagenesCloudinary(imagenesParaEliminar);
    res.json({ ok: true });

  } catch (err) {
    console.error("Error al eliminar propiedad:", {
      name: err.name,
      message: err.message
    });
    res.status(500).json({ message: "Error al eliminar propiedad" });
  }
});

export default router;
