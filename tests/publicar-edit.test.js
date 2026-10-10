import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { propiedadUpdateSchema } from "../utils/propertySchemas.js";

const publicarHtml = fs.readFileSync(new URL("../public/publicar.html", import.meta.url), "utf8");

async function submit({ edit = true, certificate = "", originalCertificate = "", networkError = false, status = 400 } = {}) {
  const nodes = new Map();
  const values = { titulo: "Estudio de prueba", direccion: "Calle Test", precio: "130000", tipoOperacion: "venta",
    tipoInmueble: "estudio", habitaciones: "0", banos: "1", superficie: "40",
    descripcion: "Descripcion editada", certificadoEnergetico: certificate };
  const requests = [];
  const document = { getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, { value: values[id] || "", checked: false, style: {}, textContent: "", disabled: false });
    return nodes.get(id);
  } };
  const mode = publicarHtml.match(/const propiedadIdEditar = .*;\nconst textoBotonPublicar = .*;/)[0];
  const start = publicarHtml.indexOf("async function publicar() {");
  const end = publicarHtml.indexOf("</script>", start);
  await vm.runInNewContext(`${mode}\n${publicarHtml.slice(start, end)}\npublicar();`, {
    window: { location: { search: edit ? "?editar=test-property" : "" } }, URLSearchParams, document,
    certificadoEnergeticoInicial: originalCertificate,
    obtenerTokenPublicar: () => "test-token", usuarioActualPublicar: { _id: "test-user" },
    refrescarUsuarioPublicar: async () => ({ _id: "test-user" }), usuarioPuedePublicar: () => true,
    mostrarErrorPublicacion: message => assert.fail(message),
    geoSeleccionValida: false, direccionSeleccionada: "", latSel: 1, lngSel: 1,
    imgFiles: edit ? [] : [{}], imagenesExistentes: [], tipoAdmitePlanta: () => true,
    tipoAdmitePlantasYSotano: () => false,
    FormData: class extends Map { append(key, value) { this.set(key, String(value)); } },
    console: { log() {} }, setTimeout() {},
    limpiarSesionPublicar() {}, mostrarSesionCaducada() {}, redirigirLoginPublicar() {},
    esErrorAutorizacionSesion: () => false,
    leerJsonSeguro: async () => ({ error: "Error de prueba" }),
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      if (networkError) throw new Error("mock network failure");
      return { ok: status < 400, status };
    }
  });
  assert.equal(requests.length, 1);
  return { request: requests[0], button: document.getElementById("btnPublicar") };
}

for (const [name, edit, certificate, originalCertificate, expected] of [
  ["creacion sin seleccion", false, "", "", undefined],
  ["edicion con certificado vacio", true, "", "", undefined],
  ["edicion con certificado sin modificar", true, "C", "C", undefined],
  ["edicion cambiando certificado", true, "B", "C", "B"],
  ["creacion con certificado", false, "A", "", "A"]
]) {
  test(`envio opcional del certificado: ${name}`, async () => {
    const { request } = await submit({ edit, certificate, originalCertificate });
    assert.equal(request.body.get("certificadoEnergetico"), expected);
    assert.equal(request.body.get("habitaciones"), "0");
    assert.equal(request.url, edit ? "/propiedades/test-property" : "/propiedades");
    assert.equal(request.method, edit ? "PUT" : "POST");
  });
}

test("schema mantiene certificado omitido o permitido y rechaza vacio e invalido explicitos", () => {
  assert.equal(propiedadUpdateSchema.safeParse({ descripcion: "Nueva descripcion" }).success, true);
  assert.equal(propiedadUpdateSchema.safeParse({ certificadoEnergetico: "C" }).success, true);
  for (const value of ["", "INVALID"]) assert.equal(propiedadUpdateSchema.safeParse({ certificadoEnergetico: value }).success, false);
});

for (const edit of [true, false]) {
  for (const scenario of [{ status: 400 }, { networkError: true }, { status: 200 }, { status: 401 }, { status: 403 }, { status: 413 }, { status: 500 }, { status: 422 }]) {
    test(`restaura boton en ${edit ? "edicion" : "creacion"}: ${JSON.stringify(scenario)}`, async () => {
      const { button } = await submit({ edit, ...scenario });
      assert.equal(button.textContent, edit ? "💾 Guardar cambios" : "🚀 Publicar anuncio");
      assert.equal(button.disabled, false);
    });
  }
}

test("carga de estudio preserva cero en el selector de habitaciones", () => {
  const assignment = publicarHtml.match(/document\.getElementById\("habitaciones"\)\.value\s*=.*;/)?.[0];
  assert.ok(assignment);
  const selector = { value: "" };
  const document = { getElementById: id => {
    assert.equal(id, "habitaciones");
    return { set value(value) { selector.value = String(value); } };
  } };
  vm.runInNewContext(assignment, { document, p: { tipoInmueble: "estudio", habitaciones: 0 } });
  assert.equal(selector.value, "0");
  for (const habitaciones of [undefined, null]) {
    vm.runInNewContext(assignment, { document, p: { habitaciones } });
    assert.equal(selector.value, "");
  }
});

for (const [tipo, habitaciones, rejected] of [
  ["estudio", "0", false],
  ["piso", "", true],
  ["piso", "2", false],
  ["local", "0", false],
  ["parcela", "0", false]
]) {
  test(`validacion habitaciones: ${tipo}, valor ${JSON.stringify(habitaciones)}`, () => {
    const validation = publicarHtml.match(/\/\/ Habitaciones solo obligatorio para residencial([\s\S]*?)\n  if \(!latSel/)[1];
    const errors = [];
    vm.runInNewContext(`(function () { ${validation} })()`, {
      tipo, titulo: "Anuncio", direccion: "Calle Test", precio: "100000", tipoOperacion: "venta",
      mensajeEl: {}, document: { getElementById: () => ({ value: habitaciones }) },
      mostrarErrorPublicacion: message => errors.push(message)
    });
    assert.equal(errors.length, rejected ? 1 : 0);
    if (rejected) assert.equal(errors[0], "Falta el campo obligatorio: habitaciones.");
  });
}

test("modo edición carga la propiedad propia autenticada y conserva imágenes existentes", () => {
  assert.match(publicarHtml, /const tokenEdicion = obtenerTokenPublicar\(\)/);
  assert.match(publicarHtml, /if \(!tokenEdicion\) \{/);
  assert.match(publicarHtml, /fetch\(`\/propiedades\/mias\/\$\{propiedadIdEditar\}`,\s*\{/);
  assert.match(publicarHtml, /"Authorization": `Bearer \$\{tokenEdicion\}`/);
  assert.match(publicarHtml, /if \(!r\.ok\) throw new Error/);
  assert.match(publicarHtml, /imagenesExistentes = p\.imagenes \|\| \[\]/);
  assert.match(publicarHtml, /fd\.append\("imagenesExistentes", JSON\.stringify\(imagenesExistentes\)\)/);
  assert.doesNotMatch(publicarHtml, /fetch\(`\/propiedades\/mias\/\$\{propiedadIdEditar\}`,[\s\S]{0,120}`Bearer \$\{token\}`/);
  assert.doesNotMatch(publicarHtml, /fetch\(`\/propiedades\/\$\{propiedadIdEditar\}`\)\s*\.then/);
});

test("edición guardada vuelve al perfil y publicación nueva mantiene URL SEO", () => {
  assert.match(publicarHtml, /if \(propiedadIdEditar\) \{\s*window\.location\.href = "\/perfil";\s*return;\s*\}/);
  assert.match(publicarHtml, /const propiedadUrl = typeof getPropiedadSeoUrl === "function"[\s\S]*getPropiedadSeoUrl\(data\)/);
  assert.match(publicarHtml, /window\.location\.href = `\$\{propiedadUrl\}\?publicado=1`/);
});

test("selector de imágenes limita a 50 nuevas por tanda sin cambiar el total ilimitado", () => {
  assert.match(publicarHtml, /const MAX_IMAGENES_NUEVAS_POR_SUBIDA = 50/);
  assert.match(publicarHtml, /Sin límite total de fotos · Máximo \$\{MAX_IMAGENES_NUEVAS_POR_SUBIDA\} imágenes por subida/);
  assert.match(publicarHtml, /const maxNuevasPorTanda = planTieneLimiteFotos\(plan\)[\s\S]*Math\.min\(maxFotos, MAX_IMAGENES_NUEVAS_POR_SUBIDA\)[\s\S]*MAX_IMAGENES_NUEVAS_POR_SUBIDA/);
  assert.match(publicarHtml, /imgFiles = seleccionadas\.slice\(0, maxNuevasPorTanda\)/);
  assert.match(publicarHtml, /Puedes subir hasta \$\{MAX_IMAGENES_NUEVAS_POR_SUBIDA\} imágenes cada vez\./);
});
