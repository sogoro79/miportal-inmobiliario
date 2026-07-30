import "dotenv/config";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import Usuario from "../models/Usuario.js";
import { z } from "../utils/validation.js";

const bootstrapSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(10).max(200)
}).strict();

async function main() {
  const parsed = bootstrapSchema.safeParse({
    email: process.env.ADMIN_BOOTSTRAP_EMAIL,
    password: process.env.ADMIN_BOOTSTRAP_PASSWORD
  });

  if (!parsed.success) {
    console.error("No se puede crear el administrador: define ADMIN_BOOTSTRAP_EMAIL y ADMIN_BOOTSTRAP_PASSWORD temporales válidos.");
    process.exitCode = 1;
    return;
  }

  if (!process.env.MONGODB_URI) {
    console.error("No se puede crear el administrador: falta MONGODB_URI.");
    process.exitCode = 1;
    return;
  }

  const { email, password } = parsed.data;

  await mongoose.connect(process.env.MONGODB_URI);

  try {
    const hash = await bcrypt.hash(password, 10);
    const usuario = await Usuario.findOne({ email }).select("+password");

    if (usuario) {
      usuario.password = hash;
      usuario.role = "admin";
      await usuario.save();

      console.log("Administrador actualizado correctamente.");
      if (usuario.activo === false) {
        console.warn("Aviso: el usuario está desactivado; no podrá iniciar sesión hasta reactivarlo.");
      }
      return;
    }

    await Usuario.create({
      nombre: "Administrador",
      email,
      password: hash,
      role: "admin",
      verificado: true,
      activo: true
    });

    console.log("Administrador creado correctamente.");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(async err => {
  console.error("No se pudo completar el bootstrap de administrador:", err.message);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
