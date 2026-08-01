#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import { BackupValidationError, parseExpectedCollections } from "../utils/backupFormat.js";
import {
  DEFAULT_RESTORE_BATCH_SIZE,
  RestoreSafetyError,
  restoreBackupToTemporaryDatabase,
} from "../utils/backupRestore.js";

const HELP_TEXT = `Uso:
  npm run backup:restore -- <archivo.json.gz> --dry-run
  ALLOW_RESTORE=true RESTORE_MONGODB_URI="mongodb+srv://..." npm run backup:restore -- <archivo.json.gz> --confirm-restore

Opciones:
  --dry-run              Valida y muestra el plan sin conectar a MongoDB.
  --confirm-restore      Ejecuta restauración real solo con barreras activas.
  --expect <lista>       Requiere que existan las colecciones indicadas.
  --batch-size <numero>  Tamaño de lote entre 1 y 1000. Por defecto 500.
  --help                 Muestra esta ayuda.
`;

function repeatedOption(name) {
  return new RestoreSafetyError(`Indica ${name} una sola vez.`, { code: "RESTORE_ARGUMENT_ERROR" });
}

function parseBatchSize(value) {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    throw new RestoreSafetyError("El batch size debe ser un entero entre 1 y 1000.", { code: "INVALID_BATCH_SIZE" });
  }
  const batchSize = Number(value);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new RestoreSafetyError("El batch size debe ser un entero entre 1 y 1000.", { code: "INVALID_BATCH_SIZE" });
  }
  return batchSize;
}

function parseArgs(args) {
  const parsed = {
    filePath: null,
    dryRun: false,
    confirmRestore: false,
    expectedCollections: undefined,
    batchSize: DEFAULT_RESTORE_BATCH_SIZE,
    help: false,
  };

  let optionsEnded = false;
  let expectSeen = false;
  let batchSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--" && !optionsEnded) {
      optionsEnded = true;
      continue;
    }
    if (optionsEnded) {
      if (parsed.filePath) {
        throw new RestoreSafetyError("Indica exactamente un archivo de entrada.", { code: "RESTORE_ARGUMENT_ERROR" });
      }
      parsed.filePath = arg;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--dry-run") {
      if (parsed.dryRun) throw repeatedOption("--dry-run");
      parsed.dryRun = true;
      continue;
    }
    if (arg === "--confirm-restore") {
      if (parsed.confirmRestore) throw repeatedOption("--confirm-restore");
      parsed.confirmRestore = true;
      continue;
    }
    if (arg === "--expect") {
      if (expectSeen) throw repeatedOption("--expect");
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new BackupValidationError("Debes indicar una lista después de --expect.");
      }
      parsed.expectedCollections = parseExpectedCollections(value);
      expectSeen = true;
      index += 1;
      continue;
    }
    if (arg.startsWith("--expect=")) {
      if (expectSeen) throw repeatedOption("--expect");
      parsed.expectedCollections = parseExpectedCollections(arg.slice("--expect=".length));
      expectSeen = true;
      continue;
    }
    if (arg === "--batch-size") {
      if (batchSeen) throw repeatedOption("--batch-size");
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new RestoreSafetyError("Debes indicar un número después de --batch-size.", { code: "INVALID_BATCH_SIZE" });
      }
      parsed.batchSize = parseBatchSize(value);
      batchSeen = true;
      index += 1;
      continue;
    }
    if (arg.startsWith("--batch-size=")) {
      if (batchSeen) throw repeatedOption("--batch-size");
      parsed.batchSize = parseBatchSize(arg.slice("--batch-size=".length));
      batchSeen = true;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new RestoreSafetyError(`Opción no reconocida: ${arg}.`, { code: "RESTORE_ARGUMENT_ERROR" });
    }
    if (parsed.filePath) {
      throw new RestoreSafetyError("Indica exactamente un archivo de entrada.", { code: "RESTORE_ARGUMENT_ERROR" });
    }
    parsed.filePath = arg;
  }

  if (!parsed.help && !parsed.filePath) {
    throw new RestoreSafetyError("Debes indicar la ruta del archivo de backup.", { code: "RESTORE_ARGUMENT_ERROR" });
  }
  if (!parsed.help && parsed.dryRun && parsed.confirmRestore) {
    throw new RestoreSafetyError("No se puede usar --dry-run junto con --confirm-restore.", {
      code: "CONFLICTING_RESTORE_MODES",
    });
  }
  if (!parsed.help && !parsed.dryRun && !parsed.confirmRestore) {
    throw new RestoreSafetyError("Indica --dry-run o --confirm-restore.", { code: "RESTORE_MODE_REQUIRED" });
  }

  return parsed;
}

function printPlan(plan, output = console.log) {
  output(plan.mode === "DRY_RUN" ? "Plan de restauración válido (DRY RUN)" : "Restauración completada");
  if (plan.destination) output(`Destino: ${plan.destination}`);
  output(`Archivo: ${plan.file.name}`);
  output(`Tamaño comprimido: ${plan.file.compressedBytes} bytes`);
  output(`Tamaño descomprimido: ${plan.file.uncompressedBytes} bytes`);
  output(`SHA-256: ${plan.file.sha256}`);
  output(`Batch size: ${plan.batchSize}`);
  output(`Total de documentos: ${plan.totalDocuments}`);
  output("Colecciones:");
  for (const collection of plan.collections) {
    const batchText = collection.batches !== undefined
      ? `${collection.batches} lote(s)`
      : `${collection.batchesCompleted} lote(s) completado(s), estado ${collection.status}`;
    output(`- ${collection.name}: ${collection.documents} documento(s), ${batchText}`);
  }
  if (plan.warnings.length > 0) {
    output("Warnings:");
    for (const warning of plan.warnings) output(`- ${warning}`);
  }
  output(`Resultado: ${plan.result || (plan.partial ? "parcial" : "completado")}`);
}

export async function runCli(args = process.argv.slice(2), {
  output = console.log,
  errorOutput = console.error,
  restore = restoreBackupToTemporaryDatabase,
  env = process.env,
} = {}) {
  try {
    const parsed = parseArgs(args);
    if (parsed.help) {
      output(HELP_TEXT.trimEnd());
      return 0;
    }

    const result = await restore(parsed.filePath, {
      dryRun: parsed.dryRun,
      confirmRestore: parsed.confirmRestore,
      expectedCollections: parsed.expectedCollections,
      batchSize: parsed.batchSize,
      env,
    });
    printPlan(result, output);
    return 0;
  } catch (error) {
    const isExpected = error instanceof BackupValidationError || error instanceof RestoreSafetyError;
    const message = isExpected ? error.message : "No se pudo preparar la restauración.";
    errorOutput(`Restauración inválida: ${message}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const code = await runCli();
  process.exitCode = code;
}
