import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const publicarHtml = fs.readFileSync(new URL("../public/publicar.html", import.meta.url), "utf8");

test("modo edición carga la propiedad propia autenticada y conserva imágenes existentes", () => {
  assert.match(publicarHtml, /fetch\(`\/propiedades\/mias\/\$\{propiedadIdEditar\}`,\s*\{/);
  assert.match(publicarHtml, /"Authorization": `Bearer \$\{token\}`/);
  assert.match(publicarHtml, /if \(!r\.ok\) throw new Error/);
  assert.match(publicarHtml, /imagenesExistentes = p\.imagenes \|\| \[\]/);
  assert.match(publicarHtml, /fd\.append\("imagenesExistentes", JSON\.stringify\(imagenesExistentes\)\)/);
  assert.doesNotMatch(publicarHtml, /fetch\(`\/propiedades\/\$\{propiedadIdEditar\}`\)\s*\.then/);
});
