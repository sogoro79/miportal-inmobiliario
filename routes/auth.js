import "dotenv/config";
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { Resend } from "resend";
import Usuario from "../models/Usuario.js";
import { cleanString, objectId, optionalCleanString, validateBody, z } from "../utils/validation.js";
import { canjearCodigoVipTrial, mensajeErrorCodigoVipTrial } from "../utils/vipTrialCodes.js";
import { authenticateUserCredentials, createUserJwt, usuarioSeguro } from "../utils/authentication.js";
import { createRateLimit } from "../utils/rateLimit.js";
import { securityRateLimits } from "../utils/security.js";

const router = express.Router();

// Configuración de Nodemailer con Gmail
const resend = new Resend(process.env.RESEND_API_KEY);

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(254);

const passwordSchema = z.string().min(6).max(200);
const loginLimiter = createRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  keyPrefix: "auth-login"
});

export const registerSchema = z.object({
  nombre: cleanString(120),
  email: emailSchema,
  tipoDoc: optionalCleanString(40),
  numDoc: optionalCleanString(80),
  codigoPromocional: optionalCleanString(40),
  token: optionalCleanString(2048)
}).strict();

export const setPasswordSchema = z.object({
  token: cleanString(2048),
  password: passwordSchema
}).strict();

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200)
}).strict();

export const recuperarSchema = z.object({
  email: emailSchema
}).strict();

export const resetSchema = z.object({
  token: cleanString(2048),
  password: passwordSchema
}).strict();

export const contactoSchema = z.object({
  nombre: cleanString(120),
  email: emailSchema,
  asunto: cleanString(160),
  mensaje: cleanString(3000)
}).strict();

/* ============================
   REGISTRO (EMAIL + TOKEN)
============================ */
router.post("/register", securityRateLimits.register, validateBody(registerSchema), async (req, res) => {
  try {
    const {
      nombre,
      email,
      tipoDoc,
      numDoc,
      codigoPromocional,
      token: turnstileToken
    } = req.body;

     // ===============================
    // CLOUDFLARE TURNSTILE
    // ===============================

    const verify = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          secret: process.env.TURNSTILE_SECRET_KEY,
          response: turnstileToken
        })
      }
    );

    const captcha = await verify.json();

    if (!captcha.success) {
      return res.status(400).json({
        error: "Verificación anti-bot incorrecta"
      });
    }   

    if (!nombre || !email) {
      return res.status(400).json({ error: "Faltan datos" });
    }

    const existe = await Usuario.findOne({ email });
    if (existe) {
      return res.json({ ok: true, message: "Si los datos son válidos, recibirás un email para continuar" });
    }

    const token = jwt.sign(
      { email },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    const usuario = new Usuario({
      nombre,
      email,
      verificado: false,
      token,
      tipoDoc: tipoDoc || "",
      numDoc:  numDoc  || ""
    });

    if (codigoPromocional) {
      try {
        await canjearCodigoVipTrial({
          code: codigoPromocional,
          usuario,
          email
        });
      } catch (codigoErr) {
        return res.status(400).json({ error: mensajeErrorCodigoVipTrial(codigoErr) });
      }
    } else {
      await usuario.save();
    }

    const enlace = `${process.env.APP_URL}/set-password?token=${token}`;

    await resend.emails.send({
      from: 'HomeClick24 <contacto@homeclick24.com>',
      to: email,
      subject: "Activa tu cuenta - HomeClick24",
      html: `
        <div style="font-family:Inter,sans-serif;max-width:480px;margin:auto;padding:32px;background:#fff;border-radius:16px;">
          <h2 style="color:#7cc242">HomeClick24</h2>
          <p>Hola <strong>${nombre}</strong>,</p>
          <p>Para activar tu cuenta, crea tu contraseña:</p>
          <a href="${enlace}" style="display:inline-block;margin:20px 0;padding:14px 28px;background:#7cc242;color:#fff;border-radius:10px;text-decoration:none;font-weight:700;">
            Crear contraseña
          </a>
          <p style="color:#888;font-size:0.85rem">Este enlace caduca en 24h.</p>
        </div>
      `
    });

    res.json({ ok: true, message: "Si los datos son válidos, recibirás un email para continuar" });

  } catch (err) {
    console.error("❌ Error registro:", err);
    res.status(500).json({ error: "Error en el registro" });
  }
});

/* ============================
   CREAR CONTRASEÑA (ACTIVACIÓN)
============================ */
router.post("/set-password", validateBody(setPasswordSchema), async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({ error: "Faltan datos" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const usuario = await Usuario.findOne({ email: decoded.email });
    if (!usuario) {
      return res.status(400).json({ error: "Usuario no encontrado" });
    }

    const hash = await bcrypt.hash(password, 10);

    usuario.password = hash;
    usuario.verificado = true;
    usuario.token = undefined;

    await usuario.save();

    res.json({ ok: true, message: "Cuenta activada correctamente" });

  } catch (err) {
    res.status(400).json({ error: "Token inválido o expirado" });
  }
});

/* ============================
   LOGIN
============================ */
router.post("/login", loginLimiter, validateBody(loginSchema), async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Faltan datos" });
    }

    const resultado = await authenticateUserCredentials({ UsuarioModel: Usuario, email, password });
    if (!resultado.ok && resultado.reason === "invalid_credentials") {
      return res.status(400).json({ error: "Credenciales incorrectas" });
    }

    if (!resultado.ok && resultado.reason === "inactive") {
      return res.status(403).json({
        error: "Esta cuenta ha sido desactivada. Contacta con HomeClick24."
      });
    }

    if (!resultado.ok && resultado.reason === "not_verified") {
      return res.status(401).json({
        error: "Debes activar tu cuenta desde el email"
      });
    }

    if (!resultado.ok && resultado.reason === "missing_password") {
      return res.status(400).json({
        error: "Debes crear tu contraseña desde el email"
      });
    }

    if (!resultado.ok) {
      return res.status(400).json({ error: "Credenciales incorrectas" });
    }

    const usuario = resultado.usuario;
    const token = createUserJwt(usuario);

    res.json({
      token,
      usuario: usuarioSeguro(usuario)
    });

  } catch (err) {
    console.error("❌ Error login:", err);
    res.status(500).json({ error: "Error en login" });
  }
});

/* ============================
   RECUPERAR CONTRASEÑA
============================ */
router.post("/recuperar", securityRateLimits.passwordRecovery, validateBody(recuperarSchema), async (req, res) => {
  try {
    const { email } = req.body;

    const usuario = await Usuario.findOne({ email });
    if (!usuario) {
      return res.json({ ok: true });
    }

    const token = jwt.sign(
      { id: usuario._id },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    const enlace = `${process.env.APP_URL}/reset-password?token=${token}`;

    await resend.emails.send({
      from: 'HomeClick24 <contacto@homeclick24.com>',
      to: email,
      subject: "Recupera tu contraseña - HomeClick24",
      html: `
        <div style="font-family:Inter,sans-serif;max-width:480px;margin:auto;padding:32px;background:#fff;border-radius:16px;">
          <h2 style="color:#7cc242">HomeClick24</h2>
          <p>Hola <strong>${usuario.nombre}</strong>,</p>
          <p>Recibimos una solicitud para restablecer tu contraseña.</p>
          <a href="${enlace}" style="display:inline-block;margin:20px 0;padding:14px 28px;background:#7cc242;color:#fff;border-radius:10px;text-decoration:none;font-weight:700;">
            Restablecer contraseña
          </a>
          <p style="color:#888;font-size:0.85rem">Este enlace caduca en 1 hora. Si no solicitaste esto, ignora este email.</p>
        </div>
      `
    });

    res.json({ ok: true });

  } catch (err) {
    console.error("❌ Error recuperar:", err);
    res.status(500).json({ error: "Error al enviar el email" });
  }
});

/* ============================
   RESET CONTRASEÑA
============================ */
router.post("/reset", securityRateLimits.passwordReset, validateBody(resetSchema), async (req, res) => {
  try {
    const { token, password } = req.body;

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const hash = await bcrypt.hash(password, 10);

    if (!objectId.safeParse(decoded.id).success) {
      return res.status(400).json({ error: "Token inválido o expirado" });
    }

    await Usuario.findByIdAndUpdate(decoded.id, { password: hash });

    res.json({ ok: true });

  } catch (err) {
    res.status(400).json({ error: "Token inválido o expirado" });
  }
});

/* ============================
   CONTACTO
============================ */
router.post("/contacto", securityRateLimits.contact, validateBody(contactoSchema), async (req, res) => {
  try {
    const { nombre, email, asunto, mensaje } = req.body;

    if (!nombre || !email || !asunto || !mensaje) {
      return res.status(400).json({ error: "Faltan datos" });
    }

    await resend.emails.send({
      from: 'HomeClick24 <contacto@homeclick24.com>',
      to: 'contacto@homeclick24.com',
      subject: `📩 Nuevo mensaje de contacto: ${asunto}`,
      html: `
        <div style="font-family:Inter,sans-serif;max-width:480px;margin:auto;padding:32px;background:#fff;border-radius:16px;">
          <h2 style="color:#7cc242">HomeClick24 · Contacto</h2>
          <p><strong>Nombre:</strong> ${nombre}</p>
          <p><strong>Email:</strong> ${email}</p>
          <p><strong>Asunto:</strong> ${asunto}</p>
          <p><strong>Mensaje:</strong></p>
          <div style="background:#f9f9f9;padding:16px;border-radius:10px;margin-top:8px;">
            ${mensaje}
          </div>
          <p style="color:#888;font-size:0.85rem;margin-top:24px;">Responde directamente a ${email}</p>
        </div>
      `,
      replyTo: email
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Error contacto:", err);
    res.status(500).json({ error: "Error al enviar el mensaje" });
  }
});

export default router;
