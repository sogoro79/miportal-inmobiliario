import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

import { runCli } from "../scripts/validate-backup.js";
import {
  BackupValidationError,
  calculateFileSha256,
  parseExpectedCollections,
  sanitizeBackupSummary,
  validateBackupFile,
  validateBackupStructure,
} from "../utils/backupFormat.js";

const execFileAsync = promisify(execFile);
const CLI_PATH = new URL("../scripts/validate-backup.js", import.meta.url);

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "homeclick24-backup-test-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function runNodeCli(args) {
  try {
    const result = await execFileAsync(process.execPath, [CLI_PATH.pathname, ...args], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

async function writeBackup(dir, data, { name = "backup-2026-08-01.json.gz", rawJson } = {}) {
  const filePath = path.join(dir, name);
  const json = rawJson ?? JSON.stringify(data);
  await fs.writeFile(filePath, gzipSync(Buffer.from(json, "utf8")));
  return filePath;
}

async function writeGzipBytes(dir, bytes, { name = "backup-2026-08-01.json.gz" } = {}) {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, gzipSync(Buffer.from(bytes)));
  return filePath;
}

test("validateBackupFile acepta un backup .json.gz valido y no expone documentos", async () => {
  await withTempDir(async dir => {
    const filePath = await writeBackup(dir, {
      usuarios: [{ _id: "u1", email: "persona@example.com" }],
      propiedades: [{ _id: "p1", direccion: "Calle privada" }],
    });

    const summary = await validateBackupFile(filePath, {
      expectedCollections: ["usuarios", "propiedades"],
    });

    assert.equal(summary.valid, true);
    assert.equal(summary.file.name, "backup-2026-08-01.json.gz");
    assert.equal(summary.file.sha256.length, 64);
    assert.equal(summary.totalDocuments, 2);
    assert.deepEqual(summary.collections.map(collection => collection.name), ["propiedades", "usuarios"]);
    assert.equal(JSON.stringify(summary).includes("persona@example.com"), false);
    assert.equal(JSON.stringify(summary).includes("Calle privada"), false);
  });
});

test("calculateFileSha256 calcula el hash del archivo comprimido original", async () => {
  await withTempDir(async dir => {
    const filePath = await writeBackup(dir, { usuarios: [] });
    const file = await fs.readFile(filePath);
    const expected = createHash("sha256").update(file).digest("hex");

    assert.equal(await calculateFileSha256(filePath), expected);
  });
});

test("validateBackupFile rechaza extension, directorio, gzip corrupto y JSON invalido", async () => {
  await withTempDir(async dir => {
    const wrongExtension = path.join(dir, "backup-2026-08-01.json");
    await fs.writeFile(wrongExtension, "{}");
    await assert.rejects(
      () => validateBackupFile(wrongExtension),
      error => error.code === "INVALID_EXTENSION"
    );

    await assert.rejects(
      () => validateBackupFile(path.join(dir, "missing.json.gz")),
      error => error.code === "FILE_NOT_FOUND"
    );

    const directoryLikeBackup = path.join(dir, "directorio.json.gz");
    await fs.mkdir(directoryLikeBackup);
    await assert.rejects(
      () => validateBackupFile(directoryLikeBackup),
      error => error.code === "INVALID_FILE_TYPE"
    );

    const corrupt = path.join(dir, "backup-2026-08-02.json.gz");
    await fs.writeFile(corrupt, "not gzip");
    await assert.rejects(() => validateBackupFile(corrupt), error => error.code === "INVALID_GZIP");

    const invalidJson = await writeBackup(dir, null, {
      name: "backup-2026-08-03.json.gz",
      rawJson: "{",
    });
    await assert.rejects(() => validateBackupFile(invalidJson), error => error.code === "INVALID_JSON");
  });
});

test("validateBackupFile rechaza UTF-8 invalido antes de parsear JSON", async () => {
  await withTempDir(async dir => {
    const prefix = Buffer.from('{"usuarios":[{"_id":"u1","texto":"', "utf8");
    const invalidUtf8 = Buffer.from([0xc3, 0x28]);
    const suffix = Buffer.from('"}]}', "utf8");
    const filePath = await writeGzipBytes(dir, Buffer.concat([prefix, invalidUtf8, suffix]));

    await assert.rejects(() => validateBackupFile(filePath), error => error.code === "INVALID_JSON");
  });
});

test("validateBackupFile rechaza archivo vacio, symlink y comprimido demasiado grande", async () => {
  await withTempDir(async dir => {
    const empty = path.join(dir, "backup-2026-08-04.json.gz");
    await fs.writeFile(empty, "");
    await assert.rejects(() => validateBackupFile(empty), error => error.code === "FILE_TOO_LARGE");

    const target = await writeBackup(dir, { usuarios: [] }, { name: "backup-2026-08-05.json.gz" });
    const link = path.join(dir, "backup-2026-08-06.json.gz");
    await fs.symlink(target, link);
    await assert.rejects(() => validateBackupFile(link), error => error.code === "INVALID_FILE_TYPE");

    const tooLarge = await writeBackup(dir, { usuarios: [] }, { name: "backup-2026-08-07.json.gz" });
    await assert.rejects(
      () => validateBackupFile(tooLarge, { limits: { maxCompressedBytes: 1 } }),
      error => error.code === "FILE_TOO_LARGE"
    );
  });
});

test("validateBackupFile aplica limites de tamano descomprimido y ratio", async () => {
  await withTempDir(async dir => {
    const filePath = await writeBackup(dir, {
      usuarios: [{ _id: "u1", texto: "x".repeat(200) }],
    });

    await assert.rejects(
      () => validateBackupFile(filePath, { limits: { maxUncompressedBytes: 40 } }),
      error => error.code === "UNCOMPRESSED_LIMIT_EXCEEDED"
    );
    await assert.rejects(
      () => validateBackupFile(filePath, { limits: { maxCompressionRatio: 0.01 } }),
      error => error.code === "COMPRESSION_RATIO_EXCEEDED"
    );
  });
});

test("validateBackupStructure rechaza raiz y colecciones invalidas", () => {
  assert.throws(() => validateBackupStructure(null), { code: "INVALID_ROOT" });
  assert.throws(() => validateBackupStructure([]), { code: "INVALID_ROOT" });
  assert.throws(() => validateBackupStructure("x"), { code: "INVALID_ROOT" });
  assert.throws(() => validateBackupStructure({}), { code: "INVALID_ROOT" });
  assert.throws(() => validateBackupStructure({ usuarios: {} }), { code: "INVALID_COLLECTION" });
  assert.throws(() => validateBackupStructure({ "system.profile": [] }), { code: "INVALID_COLLECTION" });
  assert.throws(() => validateBackupStructure({ "usuarios$": [] }), { code: "INVALID_COLLECTION" });
  assert.throws(() => validateBackupStructure({ usuarios: [null] }), { code: "INVALID_DOCUMENT" });
  assert.throws(() => validateBackupStructure({ usuarios: [[]] }), { code: "INVALID_DOCUMENT" });
  assert.throws(() => validateBackupStructure({ usuarios: ["x"] }), { code: "INVALID_DOCUMENT" });
});

test("validateBackupStructure detecta claves peligrosas en cualquier nivel", () => {
  const parsed = JSON.parse('{"usuarios":[{"_id":"u1","perfil":{"constructor":"x"}}]}');
  assert.throws(() => validateBackupStructure(parsed), { code: "DANGEROUS_KEY" });
  assert.throws(() => validateBackupStructure(JSON.parse('{"__proto__":[]}')), { code: "DANGEROUS_KEY" });
  assert.throws(() => validateBackupStructure(JSON.parse('{"prototype":[]}')), { code: "DANGEROUS_KEY" });
});

test("validateBackupStructure aplica limites de profundidad, propiedades y documentos", () => {
  assert.throws(
    () => validateBackupStructure({ usuarios: [{ _id: "u1", a: { b: { c: true } } }] }, { limits: { maxDepth: 2 } }),
    { code: "DEPTH_LIMIT_EXCEEDED" }
  );
  assert.throws(
    () => validateBackupStructure({ usuarios: [{ _id: "u1", a: 1, b: 2 }] }, { limits: { maxInspectedProperties: 2 } }),
    { code: "PROPERTY_LIMIT_EXCEEDED" }
  );
  assert.throws(
    () => validateBackupStructure({ usuarios: [{ _id: "u1" }, { _id: "u2" }] }, {
      limits: { maxDocumentsPerCollection: 1 },
    }),
    { code: "DOCUMENT_LIMIT_EXCEEDED" }
  );
  assert.throws(
    () => validateBackupStructure({ usuarios: [{ _id: "u1" }], propiedades: [{ _id: "p1" }] }, {
      limits: { maxTotalDocuments: 1 },
    }),
    { code: "DOCUMENT_LIMIT_EXCEEDED" }
  );
});

test("validateBackupStructure acepta fronteras exactas de profundidad y documentos", () => {
  assert.doesNotThrow(() => validateBackupStructure({
    usuarios: [{ _id: "u1", a: { b: true } }],
  }, { limits: { maxDepth: 4, maxInspectedProperties: 5 } }));
  assert.doesNotThrow(() => validateBackupStructure({
    usuarios: [{ _id: "u1" }, { _id: "u2" }],
  }, { limits: { maxDocumentsPerCollection: 2, maxTotalDocuments: 2 } }));
});

test("validateBackupStructure no confunde arrays anidados con documentos de coleccion", () => {
  const summary = validateBackupStructure({
    usuarios: [{ _id: "u1", preferencias: [{ clave: "zona" }, { clave: "precio" }] }],
  });

  assert.equal(summary.totalDocuments, 1);
  assert.equal(summary.collections[0].documents, 1);
});

test("validateBackupStructure cuenta documentos sin _id y puede exigir modo estricto", () => {
  const data = { usuarios: [{ _id: "u1" }, { nombre: "sin id" }] };
  const summary = validateBackupStructure(data);

  assert.equal(summary.valid, true);
  assert.equal(summary.collections[0].documentsWithoutId, 1);
  assert.deepEqual(summary.warnings, ["usuarios: 1 documento(s) sin _id."]);
  assert.throws(() => validateBackupStructure(data, { strictIds: true }), { code: "MISSING_DOCUMENT_ID" });
});

test("parseExpectedCollections valida duplicados, vacios y nombres peligrosos", () => {
  assert.deepEqual(parseExpectedCollections("usuarios, propiedades"), ["usuarios", "propiedades"]);
  assert.deepEqual(parseExpectedCollections("usuarios.propiedades,chat-mensajes,alertas_usuarios"), [
    "usuarios.propiedades",
    "chat-mensajes",
    "alertas_usuarios",
  ]);
  assert.throws(() => parseExpectedCollections("usuarios,,propiedades"), { code: "INVALID_EXPECTED_COLLECTIONS" });
  assert.throws(() => parseExpectedCollections(",usuarios"), { code: "INVALID_EXPECTED_COLLECTIONS" });
  assert.throws(() => parseExpectedCollections("usuarios,"), { code: "INVALID_EXPECTED_COLLECTIONS" });
  assert.throws(() => parseExpectedCollections("usuarios,usuarios"), { code: "INVALID_EXPECTED_COLLECTIONS" });
  assert.throws(() => parseExpectedCollections("__proto__"), { code: "DANGEROUS_KEY" });
  assert.throws(() => parseExpectedCollections("usuarios ñ"), { code: "INVALID_COLLECTION" });
});

test("validateBackupFile exige colecciones esperadas cuando se indican", async () => {
  await withTempDir(async dir => {
    const filePath = await writeBackup(dir, { usuarios: [] });

    await assert.rejects(
      () => validateBackupFile(filePath, { expectedCollections: ["usuarios", "propiedades"] }),
      error => error.code === "MISSING_EXPECTED_COLLECTION"
    );
  });
});

test("sanitizeBackupSummary elimina cualquier campo ajeno a la salida segura", () => {
  const summary = sanitizeBackupSummary({
    valid: true,
    file: { name: "backup.gz", compressedBytes: 1, secret: "no" },
    collections: [{ name: "usuarios", documents: 1, documentsWithoutId: 0, docs: [{ email: "x" }] }],
    totalDocuments: 1,
    warnings: [],
    documents: [{ email: "x" }],
  });

  assert.equal("secret" in summary.file, false);
  assert.equal("docs" in summary.collections[0], false);
  assert.equal("documents" in summary, false);
});

test("runCli muestra ayuda, valida backups y no imprime datos sensibles", async () => {
  await withTempDir(async dir => {
    const filePath = await writeBackup(dir, {
      usuarios: [{
        _id: "507f1f77bcf86cd799439011",
        email: "persona@example.com",
        nombre: "Nombre Privado",
        direccion: "Calle Privada 123",
        token: "token-secreto",
        password: "$2b$10$hashprivado",
        mensaje: "mensaje privado",
      }],
    });

    const helpLines = [];
    assert.equal(await runCli(["--help"], { output: line => helpLines.push(line) }), 0);
    assert.match(helpLines.join("\n"), /backup:validate/);

    const outputLines = [];
    const errorLines = [];
    const code = await runCli([filePath, "--expect", "usuarios"], {
      output: line => outputLines.push(line),
      errorOutput: line => errorLines.push(line),
    });

    assert.equal(code, 0);
    assert.equal(errorLines.length, 0);
    assert.match(outputLines.join("\n"), /Backup válido/);
    assert.match(outputLines.join("\n"), /usuarios: 1 documento/);
    const combinedOutput = outputLines.join("\n");
    for (const sensitive of [
      "persona@example.com",
      "Nombre Privado",
      "Calle Privada 123",
      "token-secreto",
      "$2b$10$hashprivado",
      "507f1f77bcf86cd799439011",
      "mensaje privado",
    ]) {
      assert.equal(combinedOutput.includes(sensitive), false);
    }
  });
});

test("runCli devuelve codigo distinto de cero sin stack trace en errores esperados", async () => {
  const outputLines = [];
  const errorLines = [];
  const code = await runCli(["missing.json.gz"], {
    output: line => outputLines.push(line),
    errorOutput: line => errorLines.push(line),
  });

  assert.equal(code, 1);
  assert.equal(outputLines.length, 0);
  assert.match(errorLines.join("\n"), /Backup inválido:/);
  assert.equal(errorLines.join("\n").includes("BackupValidationError"), false);
});

test("CLI real valida salida, errores y argumentos sin filtrar contenido sensible", async () => {
  await withTempDir(async dir => {
    const filePath = await writeBackup(dir, {
      usuarios: [{
        _id: "507f1f77bcf86cd799439011",
        email: "persona@example.com",
        nombre: "Nombre Privado",
        direccion: "Calle Privada 123",
        token: "token-secreto",
        password: "$2b$10$hashprivado",
        mensaje: "mensaje privado",
      }],
    });

    const help = await runNodeCli(["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /Uso:/);
    assert.equal(help.stderr, "");

    const valid = await runNodeCli([filePath, "--expect=usuarios"]);
    assert.equal(valid.code, 0);
    assert.match(valid.stdout, /Backup válido/);
    assert.equal(valid.stderr, "");

    const withoutExpect = await runNodeCli([filePath]);
    assert.equal(withoutExpect.code, 0);
    assert.match(withoutExpect.stdout, /usuarios: 1 documento/);

    const sensitiveOutput = `${valid.stdout}\n${valid.stderr}\n${withoutExpect.stdout}\n${withoutExpect.stderr}`;
    for (const sensitive of [
      "persona@example.com",
      "Nombre Privado",
      "Calle Privada 123",
      "token-secreto",
      "$2b$10$hashprivado",
      "507f1f77bcf86cd799439011",
      "mensaje privado",
    ]) {
      assert.equal(sensitiveOutput.includes(sensitive), false);
    }

    const invalid = await runNodeCli([path.join(dir, "missing.json.gz")]);
    assert.notEqual(invalid.code, 0);
    assert.equal(invalid.stdout, "");
    assert.match(invalid.stderr, /Backup inválido:/);
    assert.equal(invalid.stderr.includes("BackupValidationError"), false);

    const unknownOption = await runNodeCli(["--unknown", filePath]);
    assert.notEqual(unknownOption.code, 0);
    assert.match(unknownOption.stderr, /Opción no reconocida/);

    const twoFiles = await runNodeCli([filePath, filePath]);
    assert.notEqual(twoFiles.code, 0);
    assert.match(twoFiles.stderr, /exactamente un archivo/);

    const repeatedExpect = await runNodeCli([filePath, "--expect=usuarios", "--expect=propiedades"]);
    assert.notEqual(repeatedExpect.code, 0);
    assert.match(repeatedExpect.stderr, /una sola vez/);

    const hyphenFile = path.join(dir, "-backup-2026-08-08.json.gz");
    await fs.copyFile(filePath, hyphenFile);
    const hyphenResult = await runNodeCli(["--", hyphenFile]);
    assert.equal(hyphenResult.code, 0);
    assert.match(hyphenResult.stdout, /Backup válido/);
  });
});

test("importar la CLI y el formato no ejecuta validaciones", () => {
  assert.equal(typeof runCli, "function");
  assert.equal(typeof validateBackupFile, "function");
  assert.equal(new BackupValidationError("x").code, "BACKUP_INVALID");
});
