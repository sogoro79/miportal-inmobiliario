import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const publicarHtml = fs.readFileSync(new URL("../public/publicar.html", import.meta.url), "utf8");

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
