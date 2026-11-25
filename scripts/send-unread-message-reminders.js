import "dotenv/config";
import mongoose from "mongoose";
import { pathToFileURL } from "node:url";
import { sendUnreadMessageReminders } from "../utils/unreadMessageReminders.js";

export async function main({ db = mongoose, run = sendUnreadMessageReminders,
  env = process.env, logger = console, runtime = process } = {}) {
  try {
    if (!env.MONGODB_URI || !env.RESEND_API_KEY) throw new Error();
    await db.connect(env.MONGODB_URI);
    const result = await run();
    logger.log("[Chat reminders]", result);
    // Individual conversation failures are reported, not a failed job run.
  } catch {
    logger.warn("[Chat reminders]", { phase: "job", provider: "email", safeCode: "CHAT_REMINDER_JOB_FAILED" });
    runtime.exitCode = 1;
  } finally {
    try { await db.disconnect(); }
    catch {
      logger.warn("[Chat reminders]", { phase: "disconnect", provider: "email", safeCode: "CHAT_REMINDER_JOB_FAILED" });
      runtime.exitCode = 1;
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
