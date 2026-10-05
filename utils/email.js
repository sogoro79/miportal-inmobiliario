import { Resend } from "resend";

let resendClient;

function getResendClient() {
  if (!resendClient) {
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return resendClient;
}

const DEFAULT_FROM = {
  contact: "contacto@homeclick24.com",
  noreply: "noreply@homeclick24.com",
  backup: "backup@homeclick24.com"
};

const FROM_ENV = {
  contact: "EMAIL_FROM_CONTACT",
  noreply: "EMAIL_FROM_NOREPLY",
  backup: "EMAIL_FROM_BACKUP"
};

const BRAND = {
  name: "HomeClick24",
  color: "#7cc242",
  url: "https://www.homeclick24.com",
  tagline: "Tu hogar, a un clic de distancia.",
  // Logo opcional para email. Debe ser una URL HTTPS pública.
  // Si no se define o el cliente bloquea imágenes, la marca textual sigue visible.
  logoUrl: process.env.EMAIL_LOGO_URL || ""
};

export function escapeEmailHtml(value = "") {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  })[char]);
}

export function textToEmailHtml(value = "") {
  return escapeEmailHtml(value).replace(/\r?\n/g, "<br>");
}

export function getEmailFromAddress(type = "noreply", env = process.env) {
  const key = FROM_ENV[type] ? type : "noreply";
  return env[FROM_ENV[key]] || DEFAULT_FROM[key];
}

export function getEmailSender(type = "noreply", env = process.env) {
  return `${BRAND.name} <${getEmailFromAddress(type, env)}>`;
}

function renderButton(cta) {
  if (!cta?.url || !cta?.label) return "";
  const href = escapeEmailHtml(cta.url);
  const label = escapeEmailHtml(cta.label);
  return `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0;">
      <tr>
        <td bgcolor="${BRAND.color}" style="border-radius:10px;">
          <a href="${href}" style="display:inline-block;padding:14px 24px;font-family:Arial,sans-serif;font-size:15px;line-height:20px;color:#ffffff;text-decoration:none;font-weight:700;border-radius:10px;">
            ${label}
          </a>
        </td>
      </tr>
    </table>
  `;
}

function isValidHttpsUrl(value = "") {
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

function renderBrandHeader() {
  const logoUrl = isValidHttpsUrl(BRAND.logoUrl) ? BRAND.logoUrl : "";
  const logo = logoUrl
    ? `
      <tr>
        <td style="padding:0 0 10px;">
          <img src="${escapeEmailHtml(logoUrl)}" alt="${BRAND.name}" width="180" style="display:block;max-width:180px;width:180px;height:auto;border:0;outline:none;text-decoration:none;">
        </td>
      </tr>
    `
    : "";

  return `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 20px;">
      ${logo}
      <tr>
        <td style="font-family:Arial,sans-serif;font-size:24px;line-height:28px;font-weight:800;color:#1f2937;">
          ${BRAND.name}
        </td>
      </tr>
      <tr>
        <td style="padding-top:3px;font-family:Arial,sans-serif;font-size:12px;line-height:18px;color:#6b7280;">
          ${BRAND.tagline}
        </td>
      </tr>
    </table>
  `;
}

export function renderEmailTemplate({
  title,
  content,
  cta,
  automatic = false,
  footerNote = ""
} = {}) {
  const safeTitle = escapeEmailHtml(title || BRAND.name);

  const automaticNote = automatic
    ? `<p style="margin:20px 0 0;font-family:Arial,sans-serif;font-size:12px;line-height:18px;color:#8a8f98;">Este es un mensaje automático. No respondas a este email.</p>`
    : "";

  const footer = footerNote
    ? `<p style="margin:12px 0 0;font-family:Arial,sans-serif;font-size:12px;line-height:18px;color:#8a8f98;">${escapeEmailHtml(footerNote)}</p>`
    : "";

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${safeTitle}</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f6f3;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f4f6f3;margin:0;padding:0;">
      <tr>
        <td align="center" style="padding:28px 14px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:620px;background:#ffffff;border-radius:16px;border:1px solid #e5eadf;overflow:hidden;">
            <tr>
              <td style="padding:30px 30px 24px;border-top:5px solid ${BRAND.color};">
                ${renderBrandHeader()}
                <h1 style="margin:0 0 18px;font-family:Arial,sans-serif;font-size:24px;line-height:31px;color:#1f2937;font-weight:800;">
                  ${safeTitle}
                </h1>
                <div style="font-family:Arial,sans-serif;font-size:15px;line-height:23px;color:#374151;">
                  ${content || ""}
                </div>
                ${renderButton(cta)}
                ${automaticNote}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 30px;background:#f8faf5;border-top:1px solid #e5eadf;">
                <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;line-height:20px;color:#5f6b56;font-weight:700;">${BRAND.name}</p>
                <p style="margin:2px 0 0;font-family:Arial,sans-serif;font-size:12px;line-height:18px;color:#7b8374;">${BRAND.tagline}</p>
                <p style="margin:2px 0 0;font-family:Arial,sans-serif;font-size:12px;line-height:18px;color:#7b8374;">
                  <a href="${BRAND.url}" style="color:${BRAND.color};text-decoration:none;">www.homeclick24.com</a>
                </p>
                ${footer}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export async function enviarCorreo(to, subject, html, options = {}) {
  try {
    const data = await getResendClient().emails.send({
      from: getEmailSender(options.fromType || "noreply"),
      to,
      subject,
      html: renderEmailTemplate({
        title: options.title || subject,
        content: html,
        cta: options.cta,
        automatic: options.automatic ?? (options.fromType !== "contact"),
        footerNote: options.footerNote
      }),
      ...(options.replyTo && { replyTo: options.replyTo })
    });

    console.log("EMAIL ENVIADO:", data);
    return true;
  } catch (err) {
    console.error("ERROR EMAIL:", err);
    return false;
  }
}

export function enviarCorreoContacto(to, subject, html, options = {}) {
  return enviarCorreo(to, subject, html, {
    ...options,
    fromType: "contact",
    automatic: options.automatic ?? false
  });
}

export function enviarCorreoAutomatico(to, subject, html, options = {}) {
  return enviarCorreo(to, subject, html, {
    ...options,
    fromType: "noreply",
    automatic: options.automatic ?? true
  });
}
