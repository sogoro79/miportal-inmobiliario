import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  auditCloudinaryAssets,
  extractImageReferencesFromProperty,
  listCloudinaryImageResources,
  runCloudinaryAssetAuditCli,
  summarizeMongoImageReferences,
  validateCloudinaryAssetAuditCli
} from "../scripts/audit-cloudinary-assets.js";

const VALID_URL = "https://res.cloudinary.com/demo/image/upload/v1700000000/miportal_inmobiliario/casa-a.jpg";
const TRANSFORMED_URL = "https://res.cloudinary.com/demo/image/upload/c_fill,w_1200/v1700000000/miportal_inmobiliario/sub/casa-b.webp";

function env(overrides = {}) {
  return {
    AUDIT_CLOUDINARY_ASSETS: "true",
    MONGODB_URI: "mongodb://example.invalid/audit",
    CLOUDINARY_CLOUD_NAME: "demo",
    CLOUDINARY_API_KEY: "key",
    CLOUDINARY_API_SECRET: "secret",
    ...overrides
  };
}

function modelFor(propiedades, state = {}) {
  state.reads ||= [];
  return {
    find(query, projection) {
      state.reads.push({ query, projection });
      return {
        async lean() {
          return propiedades;
        }
      };
    },
    save() {
      throw new Error("write not allowed");
    },
    updateOne() {
      throw new Error("write not allowed");
    },
    deleteMany() {
      throw new Error("write not allowed");
    }
  };
}

function failingModel() {
  return {
    find() {
      return {
        async lean() {
          throw new Error("mongo host and document id should stay private");
        }
      };
    }
  };
}

function listResourcesFromPages(pages, state = {}) {
  state.calls ||= [];
  return async params => {
    state.calls.push(params);
    const index = state.calls.length - 1;
    const page = pages[index];
    if (page instanceof Error) throw page;
    return page || { resources: [] };
  };
}

test("auditoría Cloudinary valida flag, credenciales y argumentos antes de conectar", async () => {
  assert.deepEqual(validateCloudinaryAssetAuditCli({ env: env({ AUDIT_CLOUDINARY_ASSETS: undefined }), argv: ["node", "script"] }), {
    ok: false,
    code: "flag_requerida"
  });
  assert.deepEqual(validateCloudinaryAssetAuditCli({ env: env({ AUDIT_CLOUDINARY_ASSETS: "TRUE" }), argv: ["node", "script"] }), {
    ok: false,
    code: "flag_requerida"
  });
  assert.deepEqual(validateCloudinaryAssetAuditCli({ env: env({ CLOUDINARY_API_SECRET: "" }), argv: ["node", "script"] }), {
    ok: false,
    code: "configuracion_incompleta"
  });
  assert.deepEqual(validateCloudinaryAssetAuditCli({ env: env(), argv: ["node", "script", "--apply"] }), {
    ok: false,
    code: "argumentos_no_permitidos"
  });

  const calls = [];
  const code = await runCloudinaryAssetAuditCli({
    env: env({ AUDIT_CLOUDINARY_ASSETS: "1" }),
    argv: ["node", "script"],
    stdout: () => {},
    stderr: () => {},
    mongooseClient: {
      async connect() { calls.push("connect"); },
      async disconnect() { calls.push("disconnect"); }
    },
    cloudinaryClient: {
      config() { calls.push("config"); },
      api: { resources: async () => ({ resources: [] }) }
    }
  });

  assert.equal(code, 1);
  assert.deepEqual(calls, []);
});

test("auditoría Cloudinary extrae referencias desde imagenes reales y formatos historicos conservadores", () => {
  const extracted = extractImageReferencesFromProperty({
    imagenes: [
      VALID_URL,
      TRANSFORMED_URL,
      "miportal_inmobiliario/directa",
      { public_id: "miportal_inmobiliario/objeto-a" },
      { publicId: "miportal_inmobiliario/objeto-b" },
      { filename: "miportal_inmobiliario/objeto-c" },
      { secure_url: "https://res.cloudinary.com/demo/image/upload/v1/miportal_inmobiliario/objeto-d.png" },
      "https://example.com/no.jpg",
      "",
      null
    ]
  });

  assert.deepEqual(extracted.references.map(item => item.publicId), [
    "miportal_inmobiliario/casa-a",
    "miportal_inmobiliario/sub/casa-b",
    "miportal_inmobiliario/directa",
    "miportal_inmobiliario/objeto-a",
    "miportal_inmobiliario/objeto-b",
    "miportal_inmobiliario/objeto-c",
    "miportal_inmobiliario/objeto-d"
  ]);
  assert.equal(extracted.unresolved, 1);
});

test("auditoría Cloudinary rechaza URLs historicas no resolubles sin inventar public_id", () => {
  const extracted = extractImageReferencesFromProperty({
    imagenes: [
      "http://res.cloudinary.com/demo/image/upload/v1/miportal_inmobiliario/a.jpg",
      "https://res.cloudinary.com/demo/image/upload/v1/otra_carpeta/a.jpg",
      "https://res.cloudinary.com/demo/raw/upload/v1/miportal_inmobiliario/a.jpg",
      "https://res.cloudinary.com/demo/image/upload/v1/miportal_inmobiliario/a.gif",
      "nota privada"
    ]
  });

  assert.deepEqual(extracted.references, []);
  assert.equal(extracted.unresolved, 5);
});

test("auditoría Cloudinary deduplica public_id y detecta referencias compartidas entre propiedades", () => {
  const summary = summarizeMongoImageReferences([
    { imagenes: [VALID_URL, VALID_URL] },
    { imagenes: [VALID_URL, "miportal_inmobiliario/otra"] }
  ]);

  assert.equal(summary.propiedadesAnalizadas, 2);
  assert.equal(summary.referenciasMongoTotales, 4);
  assert.equal(summary.publicIdsMongoUnicos, 2);
  assert.equal(summary.publicIdsDuplicadosEnMongo, 2);
  assert.equal(summary.referenciasCompartidasEntrePropiedades, 1);
});

test("auditoría Cloudinary calcula referenciados, huerfanos candidatos y referencias rotas solo con auditoría completa", async () => {
  const state = {};
  const summary = await auditCloudinaryAssets({
    PropiedadModel: modelFor([
      { imagenes: [VALID_URL, "miportal_inmobiliario/no-existe"] }
    ], state),
    listResources: listResourcesFromPages([
      {
        resources: [
          { public_id: "miportal_inmobiliario/casa-a" },
          { public_id: "miportal_inmobiliario/huerfana" },
          { public_id: "otra_carpeta/fuera" }
        ]
      }
    ])
  });

  assert.equal(state.reads.length, 1);
  assert.deepEqual(state.reads[0], { query: {}, projection: { imagenes: 1, _id: 0 } });
  assert.equal(summary.modo, "solo_lectura");
  assert.equal(summary.recursosCloudinaryTotales, 3);
  assert.equal(summary.recursosReferenciados, 1);
  assert.equal(summary.recursosCloudinaryHuerfanosCandidatos, 1);
  assert.equal(summary.referenciasMongoSinRecursoCloudinary, 1);
  assert.equal(summary.recursosFueraDelAmbito, 1);
  assert.equal(summary.auditoriaCompleta, true);
  assert.equal(summary.aplicariaCambios, false);
  assert.equal(summary.requiereRevision, true);
});

test("auditoría Cloudinary pagina con next_cursor y marca cursor repetido como incompleto", async () => {
  const state = {};
  const complete = await listCloudinaryImageResources({
    listResources: listResourcesFromPages([
      { resources: [{ public_id: "miportal_inmobiliario/a" }], next_cursor: "siguiente" },
      { resources: [{ public_id: "miportal_inmobiliario/b" }] }
    ], state)
  });

  assert.equal(complete.resultadosIncompletos, false);
  assert.deepEqual(state.calls.map(call => call.next_cursor), [undefined, "siguiente"]);

  const repeated = await listCloudinaryImageResources({
    listResources: listResourcesFromPages([
      { resources: [{ public_id: "miportal_inmobiliario/a" }], next_cursor: "x" },
      { resources: [{ public_id: "miportal_inmobiliario/b" }], next_cursor: "x" }
    ])
  });

  assert.equal(repeated.resultadosIncompletos, true);
});

test("auditoría Cloudinary no declara huerfanos si Mongo o Cloudinary quedan incompletos", async () => {
  const mongoIncomplete = await auditCloudinaryAssets({
    PropiedadModel: failingModel(),
    listResources: listResourcesFromPages([{ resources: [{ public_id: "miportal_inmobiliario/huerfana" }] }])
  });
  assert.equal(mongoIncomplete.auditoriaCompleta, false);
  assert.equal(mongoIncomplete.resultadosIncompletos, true);
  assert.equal(mongoIncomplete.recursosCloudinaryHuerfanosCandidatos, 0);
  assert.equal(mongoIncomplete.requiereRevision, true);

  const cloudinaryIncomplete = await auditCloudinaryAssets({
    PropiedadModel: modelFor([{ imagenes: [VALID_URL] }]),
    listResources: listResourcesFromPages([new Error("cloudinary secret response")])
  });
  assert.equal(cloudinaryIncomplete.auditoriaCompleta, false);
  assert.equal(cloudinaryIncomplete.resultadosIncompletos, true);
  assert.equal(cloudinaryIncomplete.recursosCloudinaryHuerfanosCandidatos, 0);
});

test("auditoría Cloudinary maneja ausencia de propiedades y recursos sin escribir", async () => {
  const summary = await auditCloudinaryAssets({
    PropiedadModel: modelFor([]),
    listResources: listResourcesFromPages([{ resources: [] }])
  });

  assert.deepEqual(summary, {
    modo: "solo_lectura",
    propiedadesAnalizadas: 0,
    referenciasMongoTotales: 0,
    publicIdsMongoUnicos: 0,
    urlsMongoSinPublicId: 0,
    recursosCloudinaryTotales: 0,
    recursosReferenciados: 0,
    recursosCloudinaryHuerfanosCandidatos: 0,
    referenciasMongoSinRecursoCloudinary: 0,
    publicIdsDuplicadosEnMongo: 0,
    referenciasCompartidasEntrePropiedades: 0,
    recursosFueraDelAmbito: 0,
    resultadosIncompletos: false,
    auditoriaCompleta: true,
    requiereRevision: false,
    aplicariaCambios: false
  });
});

test("auditoría Cloudinary salida no expone URLs, public_id, IDs, credenciales ni errores crudos", async () => {
  const summary = await auditCloudinaryAssets({
    PropiedadModel: modelFor([
      {
        _id: "507f1f77bcf86cd799439011",
        titulo: "Casa secreta",
        imagenes: [VALID_URL, "https://example.com/secreto.jpg"]
      }
    ]),
    listResources: listResourcesFromPages([new Error("secret-key miportal_inmobiliario/casa-a https://privada")])
  });
  const output = JSON.stringify(summary);

  assert.doesNotMatch(output, /https:\/\/|miportal_inmobiliario\/casa-a|507f1f77bcf86cd799439011|Casa secreta|secret-key|privada/);
  assert.equal(summary.aplicariaCambios, false);
});

test("auditoría Cloudinary CLI conecta, lista y cierra conexión solo con barreras correctas", async () => {
  const calls = [];
  const code = await runCloudinaryAssetAuditCli({
    env: env(),
    argv: ["node", "script"],
    stdout: value => calls.push(["stdout", JSON.parse(value)]),
    stderr: value => calls.push(["stderr", value]),
    mongooseClient: {
      async connect(uri) { calls.push(["connect", uri]); },
      async disconnect() { calls.push(["disconnect"]); }
    },
    PropiedadModel: modelFor([{ imagenes: [VALID_URL] }]),
    cloudinaryClient: {
      config(options) { calls.push(["config", Object.keys(options).sort()]); },
      api: {
        resources: async () => ({ resources: [{ public_id: "miportal_inmobiliario/casa-a" }] })
      }
    }
  });

  assert.equal(code, 0);
  assert.equal(calls[0][0], "config");
  assert.equal(calls[1][0], "connect");
  assert.equal(calls.at(-1)[0], "disconnect");
  assert.equal(calls.find(call => call[0] === "stdout")[1].recursosReferenciados, 1);
});

test("script auditoría Cloudinary no contiene llamadas MongoDB de escritura ni Cloudinary destructivas", () => {
  const source = fs.readFileSync(new URL("../scripts/audit-cloudinary-assets.js", import.meta.url), "utf8");

  assert.doesNotMatch(source, /\.save\(|\.update\(|\.updateOne\(|\.updateMany\(|\.findOneAndUpdate\(|\.bulkWrite\(|\.delete\(|\.deleteOne\(|\.deleteMany\(|\.findByIdAndDelete\(|\.insert\(|\.create\(/);
  assert.doesNotMatch(source, /\.destroy\(|delete_resources|delete_all_resources|delete_by_token|rename\(|upload_stream\(|\.upload\(|explicit\(|create_folder|delete_folder/);
  assert.doesNotMatch(source, /from "\.\.\/server\.js"|from "stripe"|new Stripe|sendMail|emails\.send/);
});
