import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import main, { enviarPorEmail } from "../backup.js";

const backupSource = fs.readFileSync(new URL("../backup.js", import.meta.url), "utf8");

function captureConsole() {
  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.join(" "));

  return {
    logs,
    restore() {
      console.log = originalLog;
    },
  };
}

test("backup.js exporta funciones sin ejecutar el backup al importarse", () => {
  assert.equal(typeof main, "function");
  assert.equal(typeof enviarPorEmail, "function");
  assert.match(backupSource, /fileURLToPath\(import\.meta\.url\) === process\.argv\[1\]/);
  assert.doesNotMatch(backupSource, /\nmain\(\);\s*$/);
});

test("enviarPorEmail configura Nodemailer 9 con SMTP seguro y adjunto Buffer", async () => {
  const calls = [];
  const secret = "resend-test-secret";
  const destination = "backup@example.com";
  const attachmentContent = Buffer.from("backup gzip bytes");
  const consoleCapture = captureConsole();

  const mailer = {
    createTransport(options) {
      calls.push({ type: "transport", options });
      return {
        async sendMail(message) {
          calls.push({ type: "sendMail", message });
          return { messageId: "mocked-message-id" };
        },
      };
    },
  };

  try {
    await enviarPorEmail("/tmp/backup-test.json.gz", "backup-test.json.gz", {
      mailer,
      readFile(rutaLocal) {
        assert.equal(rutaLocal, "/tmp/backup-test.json.gz");
        return attachmentContent;
      },
      env: {
        GMAIL_USER: destination,
        RESEND_API_KEY: secret,
      },
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    });
  } finally {
    consoleCapture.restore();
  }

  const transportCall = calls.find(call => call.type === "transport");
  assert.deepEqual(transportCall.options, {
    host: "smtp.resend.com",
    port: 465,
    secure: true,
    disableFileAccess: true,
    disableUrlAccess: true,
    auth: {
      user: "resend",
      pass: secret,
    },
  });

  const sendMailCall = calls.find(call => call.type === "sendMail");
  assert.equal(sendMailCall.message.from, "backup@homeclick24.com");
  assert.equal(sendMailCall.message.to, destination);
  assert.match(sendMailCall.message.subject, /Backup HomeClick24/);
  assert.match(sendMailCall.message.text, /Backup automático/);

  assert.equal(sendMailCall.message.attachments.length, 1);
  const [attachment] = sendMailCall.message.attachments;
  assert.equal(attachment.filename, "backup-test.json.gz");
  assert.equal(attachment.content, attachmentContent);
  assert.ok(Buffer.isBuffer(attachment.content));
  assert.equal("raw" in attachment, false);
  assert.equal("path" in attachment, false);
  assert.equal("href" in attachment, false);
  assert.equal("url" in attachment, false);
  assert.equal("contentType" in attachment, false);

  assert.equal(consoleCapture.logs.some(line => line.includes(secret)), false);
});

test("enviarPorEmail convierte un fallo SMTP en error controlado", async () => {
  const smtpError = new Error("smtp auth rejected with secret-token");
  const consoleCapture = captureConsole();
  const mailer = {
    createTransport() {
      return {
        async sendMail() {
          throw smtpError;
        },
      };
    },
  };

  try {
    await assert.rejects(
      enviarPorEmail("/tmp/backup-test.json.gz", "backup-test.json.gz", {
        mailer,
        readFile: () => Buffer.from("backup gzip bytes"),
        env: {
          GMAIL_USER: "backup@example.com",
          RESEND_API_KEY: "secret-token",
        },
      }),
      error => {
        assert.equal(error.message, "No se pudo enviar el backup por email");
        assert.equal(error.cause, smtpError);
        assert.equal(error.message.includes("secret-token"), false);
        return true;
      }
    );
  } finally {
    consoleCapture.restore();
  }

  assert.equal(consoleCapture.logs.some(line => line.includes("secret-token")), false);
});
