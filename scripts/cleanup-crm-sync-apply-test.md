# Limpieza puntual de la prueba apply CRM

Herramienta temporal, sin endpoints, sin Cloudinary y sin descarga de feeds.
No ejecutar hasta autorizar expresamente la limpieza real. Los IDs deben
verificarse manualmente: no se selecciona por nombre, titulo ni email.

```sh
node scripts/cleanup-crm-sync-apply.js --user-id=<USER_ID_ALBERTO> --source-id=<SOURCE_ID_PRUEBA>
node scripts/cleanup-crm-sync-apply.js --user-id=<USER_ID_ALBERTO> --source-id=<SOURCE_ID_PRUEBA> --apply --confirm=DELETE_SYNC_APPLY_TEST_ALBERTO
```

Sustituir los placeholders antes de ejecutar. El primer comando solo lee.
Requiere MONGODB_URI y la clave CRM_FEED_URL_KEY_VN correspondiente a
feedUrlKeyVersion, mediante el entorno existente/dotenv. Nunca imprime claves,
URL cifrada, URI de conexion ni mensajes completos del driver.

La URL esperada es exactamente:
https://www.homeclick24.com/test-sync-apply/homeclick24-sync-apply-v1.xml
El hash SHA-256 y el descifrado deben coincidir; no se consulta el archivo remoto.
Solo admite una propiedad de esa fuente, CRM, del usuario indicado, con externalId
y referencia SYNC-APPLY-TEST-001, sin imagenes ni video. Aborta ante cualquier
reconciliacion (no solo pendiente), lock presente, run activo o referencia externa
en favoritos, conversaciones, notificaciones, estadisticas, planes de otros runs
o lastSeenRunId de otras propiedades. No elimina esas referencias.

Apply exige transacciones (replica set/Atlas). Antes de leer de nuevo escribe el
documento fuente compartido con el lock CRM; todo se revalida en la transaccion.
Solo borra propiedad, runs de esa fuente/usuario y fuente. Comprueba ausencia y
usuario completo intacto dentro de la transaccion y otra vez tras commit. No
modifica Usuario ni publicationVersion. withTransaction gestiona retries Mongo;
no hay operaciones externas en su callback. Si aborta, el lock propio se revierte
con la transaccion; si confirma, la fuente desaparece.

Realizar en una ventana sin actividad de esta cuenta/anuncio. La contencion de
ImportSource coordina operaciones CRM, no impide nuevos favoritos/chats/escrituras
manuales que no usan ese lock; las lecturas de referencias no son un mutex global.
Si existe cualquier duda, no ejecutar apply. Si commit/postverificacion no pueden
confirmarse, no reintentar a ciegas: revisar en solo lectura primero. Una
postverificacion fallida despues del commit no puede deshacer un commit confirmado.
Los tests usan dobles en memoria, no un replica set real.

Los cuatro archivos temporales se conservan en esta preparacion:
- public/test-sync-apply/homeclick24-sync-apply-v1.xml
- public/test-sync-apply/homeclick24-sync-apply-v2.xml
- docs/CRM_SYNC_APPLY_CONTROLLED_TEST.md
- tests/crm-sync-apply-feeds.test.js

Retirarlos en otro commit solo tras limpieza real verificada. El script valida
identidad por URL/hash, no necesita que los XML existan, pero no se retiran ahora.
