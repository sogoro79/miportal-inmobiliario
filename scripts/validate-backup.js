#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import {
  BackupValidationError,
  parseExpectedCollections,
  validateBackupFile,
} from "../utils/backupFormat.js";

const HELP_TEXT = `Uso:
  npm run backup:validate -- <archivo.json.gz> [--expect coleccion1,coleccion2]

Valida offline un backup .json.gz de HomeClick24 sin conectar a MongoDB ni mostrar documentos.

Opciones:
  --expect <lista>  Requiere que existan las colecciones indicadas.
  --help            Muestra esta ayuda.
`;

function parseArgs(args) {
  const parsed = {
    filePath: null,
    expectedCollections: undefined,
    help: false,
  };

  let optionsEnded = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--" && !optionsEnded) {
      optionsEnded = true;
      continue;
    }
    if (optionsEnded) {
      if (parsed.filePath) {
        throw new BackupValidationError("Indica exactamente un archivo de entrada.");
      }
      parsed.filePath = arg;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--expect") {
      if (parsed.expectedCollections !== undefined) {
        throw new BackupValidationError("Indica --expect una sola vez.");
      }
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new BackupValidationError("Debes indicar una lista después de --expect.");
      }
      parsed.expectedCollections = parseExpectedCollections(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--expect=")) {
      if (parsed.expectedCollections !== undefined) {
        throw new BackupValidationError("Indica --expect una sola vez.");
      }
      parsed.expectedCollections = parseExpectedCollections(arg.slice("--expect=".length));
      continue;
    }
    if (arg.startsWith("--")) {
      throw new BackupValidationError(`Opción no reconocida: ${arg}.`);
    }
    if (parsed.filePath) {
      throw new BackupValidationError("Indica exactamente un archivo de entrada.");
    }
    parsed.filePath = arg;
  }

  if (!parsed.help && !parsed.filePath) {
    throw new BackupValidationError("Debes indicar la ruta del archivo de backup.");
  }

  return parsed;
}

function printSummary(summary, output = console.log) {
  output("Backup válido");
  output(`Archivo: ${summary.file.name}`);
  output(`Tamaño comprimido: ${summary.file.compressedBytes} bytes`);
  output(`Tamaño descomprimido: ${summary.file.uncompressedBytes} bytes`);
  output(`Ratio de descompresión: ${summary.file.compressionRatio}`);
  output(`SHA-256: ${summary.file.sha256}`);
  output(`Total de documentos: ${summary.totalDocuments}`);
  output("Colecciones:");
  for (const collection of summary.collections) {
    output(`- ${collection.name}: ${collection.documents} documento(s), ${collection.documentsWithoutId} sin _id`);
  }
  if (summary.warnings.length > 0) {
    output("Warnings:");
    for (const warning of summary.warnings) {
      output(`- ${warning}`);
    }
  }
}

export async function runCli(args = process.argv.slice(2), {
  output = console.log,
  errorOutput = console.error,
  validate = validateBackupFile,
} = {}) {
  try {
    const parsed = parseArgs(args);
    if (parsed.help) {
      output(HELP_TEXT.trimEnd());
      return 0;
    }

    const summary = await validate(parsed.filePath, {
      expectedCollections: parsed.expectedCollections,
    });
    printSummary(summary, output);
    return 0;
  } catch (error) {
    const message = error instanceof BackupValidationError
      ? error.message
      : "No se pudo validar el backup.";
    errorOutput(`Backup inválido: ${message}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const code = await runCli();
  process.exitCode = code;
}
