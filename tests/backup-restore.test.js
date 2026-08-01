import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

import { runCli } from "../scripts/restore-backup.js";
import {
  assertSafeRestoreEnvironment,
  assertTemporaryDatabaseName,
  assertTargetDatabaseEmpty,
  createRestorePlan,
  getDatabaseNameFromUri,
  insertCollectionInBatches,
  restoreBackupToTemporaryDatabase,
  RestoreSafetyError,
  sanitizeMongoUri,
} from "../utils/backupRestore.js";

const execFileAsync = promisify(execFile);
const CLI_PATH = new URL("../scripts/restore-backup.js", import.meta.url);

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "homeclick24-restore-test-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeBackup(dir, data, { name = "backup-2026-08-01.json.gz" } = {}) {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, gzipSync(Buffer.from(JSON.stringify(data), "utf8")));
  return filePath;
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

function makeDbMock({
  existingCollections = [],
  nonEmptyCollections = new Set(),
  failCollection,
  listError,
  countErrorCollections = new Set(),
  ambiguousCollections = new Set(),
  insertResults = {},
} = {}) {
  const calls = [];
  const inserted = {};
  const db = {
    calls,
    inserted,
    listCollections(filter, options) {
      calls.push(["listCollections", filter, options]);
      return {
        async toArray() {
          if (listError) throw new Error("list failed");
          return existingCollections.map(name => ({ name }));
        },
      };
    },
    collection(name) {
      calls.push(["collection", name]);
      return {
        async countDocuments(query, options) {
          calls.push(["countDocuments", name, query, options]);
          if (countErrorCollections.has(name)) throw new Error("count failed");
          if (ambiguousCollections.has(name)) return undefined;
          return nonEmptyCollections.has(name) ? 1 : 0;
        },
        async insertMany(documents, options) {
          calls.push(["insertMany", name, documents.map(document => document._id), options]);
          if (failCollection === name) throw new Error("insert failed");
          if (Object.prototype.hasOwnProperty.call(insertResults, name)) {
            return insertResults[name];
          }
          inserted[name] ??= [];
          inserted[name].push(...documents);
          return { insertedCount: documents.length };
        },
        drop() {
          calls.push(["dropCollection", name]);
          throw new Error("drop must not be called");
        },
        deleteMany() {
          calls.push(["deleteMany", name]);
          throw new Error("deleteMany must not be called");
        },
      };
    },
    dropDatabase() {
      calls.push(["dropDatabase"]);
      throw new Error("dropDatabase must not be called");
    },
  };
  return db;
}

function makeConnection(db, { closeError } = {}) {
  const connection = {
    db,
    closed: false,
    closeCalls: 0,
    async close() {
      connection.closeCalls += 1;
      connection.closed = true;
      if (closeError) throw new Error("close failed");
    },
  };
  return connection;
}

test("dry-run crea plan seguro sin URI ni conexión", async () => {
  await withTempDir(async dir => {
    const filePath = await writeBackup(dir, {
      usuarios: [{ _id: "u1", email: "persona@example.com" }],
      propiedads: [{ _id: "p1", direccion: "Calle Privada" }, { _id: "p2" }],
    });
    let connected = false;

    const plan = await restoreBackupToTemporaryDatabase(filePath, {
      dryRun: true,
      batchSize: 1,
      env: {},
      createConnection: async () => {
        connected = true;
        throw new Error("must not connect");
      },
    });

    assert.equal(connected, false);
    assert.equal(plan.mode, "DRY_RUN");
    assert.equal(plan.totalDocuments, 3);
    assert.equal(plan.batchSize, 1);
    assert.deepEqual(plan.collections.map(collection => [collection.name, collection.documents, collection.batches]), [
      ["propiedads", 2, 2],
      ["usuarios", 1, 1],
    ]);
    const output = JSON.stringify(plan);
    assert.equal(output.includes("persona@example.com"), false);
    assert.equal(output.includes("Calle Privada"), false);
  });
});

test("dry-run ignora variables peligrosas y nunca llama al conector", async () => {
  await withTempDir(async dir => {
    const filePath = await writeBackup(dir, { usuarios: [{ _id: "u1" }] });
    let connectCalls = 0;
    const plan = await restoreBackupToTemporaryDatabase(filePath, {
      dryRun: true,
      env: {
        ALLOW_RESTORE: "definitely-not-true",
        RESTORE_MONGODB_URI: "mongodb+srv://user:synthetic-secret@example.test/production",
        MONGODB_URI: "not a valid uri",
      },
      createConnection: async () => {
        connectCalls += 1;
        throw new Error("must not connect");
      },
    });

    assert.equal(plan.mode, "DRY_RUN");
    assert.equal(connectCalls, 0);
    assert.equal(JSON.stringify(plan).includes("synthetic-secret"), false);
  });
});

test("dry-run soporta --expect y no lo usa como lista blanca", async () => {
  await withTempDir(async dir => {
    const filePath = await writeBackup(dir, {
      usuarios: [{ _id: "u1" }],
      propiedads: [{ _id: "p1" }],
    });

    const plan = await restoreBackupToTemporaryDatabase(filePath, {
      dryRun: true,
      expectedCollections: ["usuarios"],
    });

    assert.deepEqual(plan.collections.map(collection => collection.name), ["propiedads", "usuarios"]);
  });
});

test("CLI real de restore cubre help, dry-run, errores y ruta con guion", async () => {
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
    assert.match(help.stdout, /backup:restore/);
    assert.equal(help.stderr, "");

    const dryRun = await runNodeCli([filePath, "--dry-run", "--expect=usuarios"]);
    assert.equal(dryRun.code, 0);
    assert.match(dryRun.stdout, /DRY RUN/);
    assert.equal(dryRun.stderr, "");
    for (const sensitive of [
      "persona@example.com",
      "Nombre Privado",
      "Calle Privada 123",
      "token-secreto",
      "$2b$10$hashprivado",
      "507f1f77bcf86cd799439011",
      "mensaje privado",
    ]) {
      assert.equal(dryRun.stdout.includes(sensitive), false);
      assert.equal(dryRun.stderr.includes(sensitive), false);
    }

    const invalid = await runNodeCli(["--unknown", filePath, "--dry-run"]);
    assert.notEqual(invalid.code, 0);
    assert.match(invalid.stderr, /Opción no reconocida/);
    assert.equal(invalid.stderr.includes("RestoreSafetyError"), false);

    const hyphenFile = path.join(dir, "-backup-2026-08-02.json.gz");
    await fs.copyFile(filePath, hyphenFile);
    const hyphen = await runNodeCli(["--dry-run", "--", hyphenFile]);
    assert.equal(hyphen.code, 0);
  });
});

test("argumentos del CLI rechazan modos y opciones inválidas", async () => {
  const calls = [];
  const restore = async (filePath, options) => {
    calls.push({ filePath, options });
    return createRestorePlan({
      file: { name: "backup.json.gz", compressedBytes: 1, uncompressedBytes: 2, compressionRatio: 2, sha256: "a".repeat(64) },
      collections: [],
      totalDocuments: 0,
      warnings: [],
    }, { batchSize: options.batchSize, mode: "DRY_RUN" });
  };

  assert.equal(await runCli([], { restore, output: () => {}, errorOutput: () => {} }), 1);
  assert.equal(await runCli(["a.json.gz", "b.json.gz", "--dry-run"], { restore, output: () => {}, errorOutput: () => {} }), 1);
  assert.equal(await runCli(["a.json.gz", "--dry-run", "--dry-run"], { restore, output: () => {}, errorOutput: () => {} }), 1);
  assert.equal(await runCli(["a.json.gz", "--confirm-restore", "--confirm-restore"], { restore, output: () => {}, errorOutput: () => {} }), 1);
  assert.equal(await runCli(["a.json.gz", "--expect=a", "--expect=b", "--dry-run"], { restore, output: () => {}, errorOutput: () => {} }), 1);
  assert.equal(await runCli(["a.json.gz", "--batch-size=5", "--batch-size=5", "--dry-run"], { restore, output: () => {}, errorOutput: () => {} }), 1);
  for (const value of ["0", "1001", "1.5", "texto", "+1", "1.0", "NaN", "Infinity", ""]) {
    assert.equal(await runCli(["a.json.gz", "--dry-run", "--batch-size", value], { restore, output: () => {}, errorOutput: () => {} }), 1);
  }
  assert.equal(await runCli(["a.json.gz", "--dry-run", "--batch-size", "001"], { restore, output: () => {}, errorOutput: () => {} }), 0);
  assert.equal(await runCli(["a.json.gz", "--dry-run", "--confirm-restore"], { restore, output: () => {}, errorOutput: () => {} }), 1);
  assert.equal(calls.length, 1);
});

test("barreras de entorno y URI bloquean destinos inseguros sin fallback", () => {
  assert.throws(() => assertSafeRestoreEnvironment({ confirmRestore: true, env: {} }), { code: "RESTORE_NOT_ALLOWED" });
  assert.throws(() => assertSafeRestoreEnvironment({ confirmRestore: true, env: { ALLOW_RESTORE: "yes" } }), { code: "RESTORE_NOT_ALLOWED" });
  assert.throws(() => assertSafeRestoreEnvironment({ confirmRestore: true, env: { ALLOW_RESTORE: "true" } }), { code: "RESTORE_URI_REQUIRED" });
  assert.throws(() => assertSafeRestoreEnvironment({
    confirmRestore: true,
    env: { ALLOW_RESTORE: "true", RESTORE_MONGODB_URI: "not a uri" },
  }), { code: "INVALID_RESTORE_URI" });
  assert.throws(() => assertSafeRestoreEnvironment({
    confirmRestore: true,
    env: { ALLOW_RESTORE: "true", RESTORE_MONGODB_URI: "mongodb+srv://user:pass@example.test" },
  }), { code: "DATABASE_NAME_REQUIRED" });
  assert.throws(() => assertSafeRestoreEnvironment({
    confirmRestore: true,
    env: { ALLOW_RESTORE: "true", RESTORE_MONGODB_URI: "mongodb+srv://user:pass@example.test/homeclick24" },
  }), { code: "FORBIDDEN_DATABASE" });
  assert.throws(() => assertSafeRestoreEnvironment({
    confirmRestore: true,
    env: { ALLOW_RESTORE: "true", RESTORE_MONGODB_URI: "mongodb+srv://user:pass@example.test/temporal" },
  }), { code: "INVALID_TEMPORARY_DATABASE" });
  assert.throws(() => assertSafeRestoreEnvironment({
    confirmRestore: true,
    env: {
      ALLOW_RESTORE: "true",
      RESTORE_MONGODB_URI: "mongodb+srv://restore:secret@example.test/restore_homeclick24?retryWrites=true&w=majority",
      MONGODB_URI: "mongodb+srv://prod:different@example.test/restore_homeclick24?w=majority&retryWrites=true",
    },
  }), { code: "RESTORE_URI_MATCHES_PRODUCTION" });

  const safe = assertSafeRestoreEnvironment({
    confirmRestore: true,
    env: {
      ALLOW_RESTORE: "true",
      RESTORE_MONGODB_URI: "mongodb+srv://restore:secret@example.test/restore_homeclick24_20260801?retryWrites=true",
      MONGODB_URI: "mongodb+srv://prod:secret@example.test/homeclick24?retryWrites=true",
    },
  });
  assert.equal(safe.sanitizedDestination, "example.test/restore_homeclick24_20260801");
  assert.equal(JSON.stringify(safe).includes("secret"), false);
  assert.equal(getDatabaseNameFromUri("mongodb://u:p@localhost:27017/test_restore_homeclick24"), "test_restore_homeclick24");
  assert.equal(sanitizeMongoUri("mongodb://u:p@localhost:27017/test_restore_homeclick24?authSource=admin"), "localhost:27017/test_restore_homeclick24");
});

test("URI y base temporal cubren fronteras sin filtrar credenciales", () => {
  const secretUri = "mongodb+srv://user:pa%24%24@example.test/restore_homeclick24_20260801?authSource=admin&tls=true";
  assert.equal(sanitizeMongoUri(secretUri), "example.test/restore_homeclick24_20260801");
  assert.equal(getDatabaseNameFromUri("mongodb://u:p@[::1]:27017/restore_ipv6"), "restore_ipv6");
  assert.equal(getDatabaseNameFromUri("mongodb://u:p@EXAMPLE.test:27017/restore_case"), "restore_case");
  assert.equal(getDatabaseNameFromUri("mongodb://u:p@example.test/restore%5Fencoded"), "restore_encoded");
  for (const uri of [
    " mongodb://u:p@example.test/restore_space",
    "mongodb://u:p@example.test/restore_fragment#frag",
    "mongodb://u:p@example.test/",
    "mongodb://u:p@example.test/restore_one/extra",
    "mongodb://u:p@example.test/restore_%E0%A4%A",
  ]) {
    assert.throws(() => getDatabaseNameFromUri(uri), error => {
      assert.equal(JSON.stringify(error).includes("pa$$"), false);
      return ["RESTORE_URI_REQUIRED", "INVALID_RESTORE_URI", "DATABASE_NAME_REQUIRED"].includes(error.code);
    });
  }

  for (const name of ["restore", "restorex_", "my_restore_", "production_restore_", "restore.name", "restore_ñ", "restore_\u0000x"]) {
    assert.throws(() => assertTemporaryDatabaseName(name), { code: "INVALID_TEMPORARY_DATABASE" });
  }
  assert.equal(assertTemporaryDatabaseName("restore_homeclick24"), "restore_homeclick24");
  assert.equal(assertTemporaryDatabaseName("restore-homeclick24"), "restore-homeclick24");
  assert.equal(assertTemporaryDatabaseName("test_restore_homeclick24"), "test_restore_homeclick24");
  assert.equal(assertTemporaryDatabaseName("test-restore-homeclick24"), "test-restore-homeclick24");

  assert.throws(() => assertSafeRestoreEnvironment({
    confirmRestore: true,
    env: {
      ALLOW_RESTORE: "true",
      RESTORE_MONGODB_URI: "mongodb+srv://restore:secret@example.test/restore_same?authSource=admin",
      MONGODB_URI: "mongodb+srv://prod:different@example.test/restore_same?authSource=other",
    },
  }), { code: "RESTORE_URI_MATCHES_PRODUCTION" });

  for (const allow of ["TRUE", "True", " true ", "1"]) {
    assert.throws(() => assertSafeRestoreEnvironment({
      confirmRestore: true,
      env: {
        ALLOW_RESTORE: allow,
        RESTORE_MONGODB_URI: "mongodb+srv://restore:secret@example.test/restore_homeclick24_20260801",
      },
    }), { code: "RESTORE_NOT_ALLOWED" });
  }
});

test("barreras fallidas no llaman al conector", async () => {
  await withTempDir(async dir => {
    const filePath = await writeBackup(dir, { usuarios: [{ _id: "u1" }] });
    let connectCalls = 0;
    await assert.rejects(() => restoreBackupToTemporaryDatabase(filePath, {
      confirmRestore: true,
      env: {
        ALLOW_RESTORE: "true",
        RESTORE_MONGODB_URI: "mongodb+srv://user:pass@example.test/homeclick24",
      },
      createConnection: async () => {
        connectCalls += 1;
      },
    }), { code: "FORBIDDEN_DATABASE" });
    assert.equal(connectCalls, 0);
  });
});

test("base destino vacía permite continuar y base con datos aborta sin borrar", async () => {
  const noCollections = makeDbMock();
  await assert.doesNotReject(() => assertTargetDatabaseEmpty(noCollections));

  const emptyDb = makeDbMock({ existingCollections: ["usuarios"] });
  await assert.doesNotReject(() => assertTargetDatabaseEmpty(emptyDb));
  assert.equal(emptyDb.calls.some(call => ["dropDatabase", "dropCollection", "deleteMany"].includes(call[0])), false);

  const severalEmpty = makeDbMock({ existingCollections: ["usuarios", "system.profile", "propiedads"] });
  await assert.doesNotReject(() => assertTargetDatabaseEmpty(severalEmpty));

  const nonEmptyDb = makeDbMock({ existingCollections: ["usuarios"], nonEmptyCollections: new Set(["usuarios"]) });
  await assert.rejects(() => assertTargetDatabaseEmpty(nonEmptyDb), { code: "TARGET_DATABASE_NOT_EMPTY" });
  assert.equal(nonEmptyDb.calls.some(call => ["dropDatabase", "dropCollection", "deleteMany"].includes(call[0])), false);

  await assert.rejects(() => assertTargetDatabaseEmpty(makeDbMock({ listError: true })));
  await assert.rejects(() => assertTargetDatabaseEmpty(makeDbMock({
    existingCollections: ["usuarios"],
    countErrorCollections: new Set(["usuarios"]),
  })));
  await assert.rejects(() => assertTargetDatabaseEmpty(makeDbMock({
    existingCollections: ["usuarios"],
    ambiguousCollections: new Set(["usuarios"]),
  })), { code: "TARGET_DATABASE_NOT_EMPTY" });
  await assert.rejects(() => assertTargetDatabaseEmpty(makeDbMock({
    existingCollections: ["system.profile"],
    nonEmptyCollections: new Set(["system.profile"]),
  })), { code: "TARGET_DATABASE_NOT_EMPTY" });
});

test("restore real mockeado inserta por lotes ordered true y cierra conexión", async () => {
  await withTempDir(async dir => {
    const filePath = await writeBackup(dir, {
      usuarios: [
        { _id: "u1", fecha: "2026-08-01T00:00:00.000Z" },
        { _id: "u2" },
        { _id: "u3" },
      ],
      propiedads: [{ _id: "p1" }],
    });
    const db = makeDbMock({ existingCollections: ["usuarios"] });
    const connection = makeConnection(db);
    const report = await restoreBackupToTemporaryDatabase(filePath, {
      confirmRestore: true,
      batchSize: 2,
      env: {
        ALLOW_RESTORE: "true",
        RESTORE_MONGODB_URI: "mongodb+srv://user:pass@example.test/restore_homeclick24_20260801",
      },
      createConnection: async () => connection,
    });

    assert.equal(connection.closed, true);
    assert.equal(report.destination, "example.test/restore_homeclick24_20260801");
    assert.deepEqual(report.collections.map(collection => [collection.name, collection.inserted, collection.batchesCompleted, collection.status]), [
      ["propiedads", 1, 1, "inserted"],
      ["usuarios", 3, 2, "inserted"],
    ]);
    const insertCalls = db.calls.filter(call => call[0] === "insertMany");
    assert.equal(insertCalls.every(call => call[3].ordered === true), true);
    assert.deepEqual(db.inserted.usuarios.map(document => document._id), ["u1", "u2", "u3"]);
    assert.equal(typeof db.inserted.usuarios[0].fecha, "string");
    assert.equal(JSON.stringify(report).includes("u1"), false);
  });
});

test("restore real aborta ante base no vacía, conexión fallida y errores parciales", async () => {
  await withTempDir(async dir => {
    const filePath = await writeBackup(dir, {
      propiedads: [{ _id: "p1" }],
      usuarios: [{ _id: "u1" }, { _id: "u2" }],
    });
    const env = {
      ALLOW_RESTORE: "true",
      RESTORE_MONGODB_URI: "mongodb+srv://user:pass@example.test/restore_homeclick24_20260801",
    };

    await assert.rejects(() => restoreBackupToTemporaryDatabase(filePath, {
      confirmRestore: true,
      env,
      createConnection: async () => {
        throw new Error("network unavailable");
      },
    }), { code: "RESTORE_CONNECTION_FAILED" });

    const nonEmptyConnection = makeConnection(makeDbMock({
      existingCollections: ["usuarios"],
      nonEmptyCollections: new Set(["usuarios"]),
    }));
    await assert.rejects(() => restoreBackupToTemporaryDatabase(filePath, {
      confirmRestore: true,
      env,
      createConnection: async () => nonEmptyConnection,
    }), { code: "TARGET_DATABASE_NOT_EMPTY" });
    assert.equal(nonEmptyConnection.closed, true);

    const firstFailure = makeConnection(makeDbMock({ failCollection: "propiedads" }));
    await assert.rejects(() => restoreBackupToTemporaryDatabase(filePath, {
      confirmRestore: true,
      env,
      createConnection: async () => firstFailure,
    }), { code: "RESTORE_INSERT_FAILED" });
    assert.equal(firstFailure.closed, true);
    assert.equal(firstFailure.db.calls.some(call => call[0] === "insertMany" && call[1] === "usuarios"), false);

    const partialFailure = makeConnection(makeDbMock({ failCollection: "usuarios" }));
    await assert.rejects(() => restoreBackupToTemporaryDatabase(filePath, {
      confirmRestore: true,
      env,
      createConnection: async () => partialFailure,
    }), { code: "PARTIAL_RESTORE" });
    assert.equal(partialFailure.closed, true);
  });
});

test("insertCollectionInBatches rechaza resultados ambiguos y preserva documentos", async () => {
  const docs = [{ _id: "u1" }, { _id: "u2" }, { _id: "u3" }];
  const calls = [];
  const collection = {
    async insertMany(batch, options) {
      calls.push({ batch, options });
      return { insertedCount: batch.length };
    },
  };
  const result = await insertCollectionInBatches(collection, docs, { batchSize: 2 });
  assert.equal(result.inserted, 3);
  assert.equal(calls.length, 2);
  assert.equal(calls.every(call => call.options.ordered === true), true);
  assert.equal(calls[0].batch[0], docs[0]);
  assert.deepEqual(docs, [{ _id: "u1" }, { _id: "u2" }, { _id: "u3" }]);

  await assert.rejects(() => insertCollectionInBatches({
    async insertMany() {
      return { insertedCount: 1 };
    },
  }, [{ _id: "a" }, { _id: "b" }], { batchSize: 2 }), { code: "RESTORE_INSERT_FAILED" });

  await assert.rejects(() => insertCollectionInBatches({
    async insertMany() {
      return {};
    },
  }, [{ _id: "a" }], { batchSize: 1 }), { code: "RESTORE_INSERT_FAILED" });

  let attempts = 0;
  await assert.rejects(() => insertCollectionInBatches({
    async insertMany(batch) {
      attempts += 1;
      if (attempts === 1) return { insertedCount: batch.length };
      throw new Error("second batch failed");
    },
  }, [{ _id: "a" }, { _id: "b" }], { batchSize: 1 }), { code: "PARTIAL_RESTORE" });
  assert.equal(attempts, 2);
});

test("errores de close no tapan el error principal y no hay doble cierre", async () => {
  await withTempDir(async dir => {
    const filePath = await writeBackup(dir, { usuarios: [{ _id: "u1" }] });
    const env = {
      ALLOW_RESTORE: "true",
      RESTORE_MONGODB_URI: "mongodb+srv://user:pass@example.test/restore_homeclick24_20260801",
    };

    const closeAfterSuccess = makeConnection(makeDbMock(), { closeError: true });
    await assert.rejects(() => restoreBackupToTemporaryDatabase(filePath, {
      confirmRestore: true,
      env,
      createConnection: async () => closeAfterSuccess,
    }), { code: "RESTORE_CONNECTION_FAILED" });
    assert.equal(closeAfterSuccess.closeCalls, 1);

    const closeAfterPrimaryError = makeConnection(makeDbMock({ failCollection: "usuarios" }), { closeError: true });
    await assert.rejects(() => restoreBackupToTemporaryDatabase(filePath, {
      confirmRestore: true,
      env,
      createConnection: async () => closeAfterPrimaryError,
    }), { code: "RESTORE_INSERT_FAILED" });
    assert.equal(closeAfterPrimaryError.closeCalls, 1);
  });
});

test("importar CLI y módulos de restore no ejecuta restauración", () => {
  assert.equal(typeof runCli, "function");
  assert.equal(typeof restoreBackupToTemporaryDatabase, "function");
  assert.equal(new RestoreSafetyError("x").code, "RESTORE_SAFETY_ERROR");
});
