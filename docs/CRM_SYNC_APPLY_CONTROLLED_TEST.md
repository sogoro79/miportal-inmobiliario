# Prueba controlada de apply CRM: un anuncio, un cambio de precio

Preparacion local solamente. No se han importado anuncios ni ejecutado acciones
contra MongoDB o Cloudinary reales. No hay endpoints, flags ni botones DEMO.

## Archivos y URLs futuras

- https://www.homeclick24.com/test-sync-apply/homeclick24-sync-apply-v1.xml
- https://www.homeclick24.com/test-sync-apply/homeclick24-sync-apply-v2.xml

Express ya sirve public/ como archivos estaticos; estas URLs solo estaran disponibles
despues de un deploy autorizado. No se ha realizado push ni deploy en esta tarea.

Ambos XML contienen un solo externalId, SYNC-APPLY-TEST-001, sin fotos ni video,
con datos ficticios y claramente identificados como prueba. Solo cambia precio:
210000 en v1 y 225000 en v2. El snapshot es completo y el UPDATE esperado es precio.
El parser utiliza externalId como identidad CRM; no se depende del campo de
referencia visible del anuncio para reconocerlo.

## Limitacion de identidad: no cambiar de URL

feedUrlHash se calcula sobre la URL completa normalizada, no sobre el contenido.
Por eso las URLs v1 y v2 tienen hashes distintos. Despues de importar v1, configurar
la URL v2 mediante PUT /api/crm-import/sync/source devuelve SYNC_SOURCE_URL_MISMATCH,
porque la misma ImportSource ya tiene una propiedad CRM asociada.

No editar hashes ni ciphertext, no crear una segunda fuente y no cambiar parametros
de la URL para saltarse esta proteccion. Tampoco reimportar v2 como un nuevo anuncio.
La existencia de ambos archivos NO permite completar por si sola toda la prueba.

## Procedimiento manual futuro

Usar una cuenta de prueba autorizada, con cupo para un anuncio y sin propiedades CRM
vinculadas a otra fuente. No usar una cuenta principal ni modificar limites de plan.
Los datos ficticios se publicarian realmente al importar; mantener la prueba breve
y preparar su retirada posterior mediante una operacion separada y autorizada.

1. Analizar e importar SOLO SYNC-APPLY-TEST-001 desde la URL v1.
2. Configurar la sincronizacion con EXACTAMENTE esa misma URL v1. Mantener su
   importSourceId. Simular para ver el anuncio pendiente de vinculacion y pulsar
   Vincular anuncio, sin modificar su contenido manualmente.
3. Simular de nuevo: esperar UNCHANGED, precio 210000 y sin overrides.
4. Detenerse aqui hasta autorizar la alternancia del contenido. Opcion minima:
   en un cambio/deploy posterior, sustituir el contenido del archivo servido en
   la ruta v1 por el XML v2. Mantener EXACTAMENTE la URL v1 configurada, sin cambiar
   la fuente ni su hash. En hosting controlado equivalente, reemplazar el contenido
   de una unica URL estable. Ninguna alternancia se implementa en esta tarea.
5. Verificar que esa misma URL v1 ya devuelve precio 225000; comprobar contenido
   fresco en origen y posibles caches/CDN. No anadir query strings de cache busting
   a la fuente configurada, porque tambien alterarian su identidad.
6. Simular desde la fuente existente: esperar UPDATE, changedFields=["precio"],
   snapshot completo y run vigente. Revisar que solo se seleccione este anuncio.
7. Confirmar Aplicar cambios antes de la expiracion de 20 minutos. Mantener el
   contenido v2 estable entre simulate y apply: apply lo vuelve a descargar y
   rechaza cualquier digest diferente. No editar el anuncio durante la prueba.
8. Comprobar el resultado confirmado y precio 225000. Volver a simular: UNCHANGED.
   contentRevision debe haber aumentado una vez y el baseline gestionado debe
   representar el contenido aceptado. No deben aparecer overrides ni cambiar fotos.

Si aparece un error de identidad, conflicto o resultado indeterminado, detenerse
y consultar el run; no reintentar automaticamente ni hacer correcciones en MongoDB.

## Comprobaciones locales

tests/crm-sync-apply-feeds.test.js usa los parsers y normalizadores actuales, el
builder de publicacion y el plan V1 sobre objetos en memoria. Comprueba XML valido,
un anuncio, ausencia de fotos/video, igualdad salvo precio, fingerprints distintos,
UNCHANGED -> UPDATE precio -> UNCHANGED y hashes distintos para las dos URLs.
No constituye una importacion real ni una prueba de transacciones contra MongoDB.
