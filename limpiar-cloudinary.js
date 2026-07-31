import "dotenv/config";
import { v2 as cloudinary } from "cloudinary";
import mongoose from "mongoose";
import { fileURLToPath } from "node:url";
import Propiedad from "./models/Propiedad.js";
import { configureCloudinary, destroyByPublicId } from "./utils/cloudinaryService.js";
import { getCloudinaryPublicIdFromUrl } from "./utils/imageSecurity.js";

configureCloudinary({ client: cloudinary });

export async function limpiarCloudinary() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Conectado a MongoDB");

  // Obtener todas las URLs de imágenes en uso
  const propiedades = await Propiedad.find({}, "imagenes");
  const urlsEnUso = new Set();
  for (const p of propiedades) {
    for (const url of p.imagenes || []) {
      const publicId = getCloudinaryPublicIdFromUrl(url);
      if (publicId) urlsEnUso.add(publicId);
    }
  }
  console.log(`Imágenes en uso en MongoDB: ${urlsEnUso.size}`);

  // Obtener todas las imágenes en Cloudinary
  let recursos = [];
  let nextCursor = null;
  do {
    const result = await cloudinary.api.resources({
      type: "upload",
      prefix: "miportal_inmobiliario",
      max_results: 500,
      next_cursor: nextCursor
    });
    recursos = recursos.concat(result.resources);
    nextCursor = result.next_cursor;
  } while (nextCursor);

  console.log(`Imágenes en Cloudinary: ${recursos.length}`);

  // Comparar y borrar las que no están en uso
  let borradas = 0;
  for (const recurso of recursos) {
    if (!urlsEnUso.has(recurso.public_id)) {
      console.log(`Borrando: ${recurso.public_id}`);
      await destroyByPublicId(recurso.public_id, { client: cloudinary });
      borradas++;
    }
  }

  console.log(`\nLimpieza completada. Imágenes borradas: ${borradas}`);
  await mongoose.disconnect();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  limpiarCloudinary().catch(console.error);
}
