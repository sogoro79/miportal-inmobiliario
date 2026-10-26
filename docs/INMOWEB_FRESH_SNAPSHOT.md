# Disponibilidad y captura fresca de InmoWeb

La ventana indicada por el proveedor se interpreta en Europe/Madrid: desde
las 18:00 inclusive hasta las 09:00 exclusive, con el cambio estacional de hora.
Se aplica a las descargas identificadas como InmoWeb. generic_xml conserva su
política de transporte y su refetch obligatorio para NEW.

Analizar y Simular comparten XML durante cinco minutos por propietario y hash
de URL normalizada. Los parámetros de transporte también forman parte de la
clave. La clave no contiene la URL en claro. Se mantienen deduplicación, pausas
tras errores, cero reintentos automáticos y todas las protecciones del fetcher.
Fuera de horario solo se reutiliza una captura aún válida para lectura; no se
consulta el proveedor. No se atribuye todo 403 al horario ni a rate limiting.

Una descarga correcta recibe un identificador interno aleatorio. La evidencia
queda en memoria, ligada al propietario, hash de fuente y hora de descarga.
Después de guardar una simulación InmoWeb correcta se vinculan esa captura y su
contenido normalizado al run y a la fuente. Se comprueban digest, proveedor y
versiones de normalización. No se acepta evidencia enviada por el cliente.

NEW InmoWeb usa exclusivamente la captura vinculada a ese run, con edad máxima
de cinco minutos, inclusive. Se vuelven a verificar fuente, propietario, digest,
versiones y expiración del run. Si falta la captura o no coincide, se rechaza sin
refetch ni fallback. La edad se revalida antes de reclamar el run y dentro de la
transacción antes de persistir, también cuando la descarga de imágenes tarda.

El contrato acepta una fotografía del proveedor de hasta cinco minutos; no
asegura detectar cambios remotos posteriores a esa fotografía. Los controles
locales sí siguen vigentes: NEW actual, elegibilidad, gates, allowlist, usuario,
plan/cupo, locks/fences, reconciliación, imágenes, recibos e idempotencia.
UPDATE, MISSING, REAPPEARED y vinculación InmoWeb siguen bloqueados;
snapshotComplete sigue false. No se modifica ninguna variable de activación.

La memoria es un fast path acotado. Después de guardar una simulación InmoWeb
correcta, antes de responder, se persiste su evidencia en `providerSnapshots`
(modelo `ProviderSnapshot`). Un índice único de `runId` vincula cada documento a
una sola simulación; las escrituras son insert-only y no renuevan su fecha ni
extienden su vida. No es necesario añadir un snapshotId al run: la recuperación
exige el runId exacto junto con propietario, fuente, identidad, digest y versiones.
Una captura solo analizada, sin simulación, no se persiste.

El documento conserva metadatos de identidad y versiones, `fetchedAt`,
`expiresAt`, `keyVersion` y `encryptedSnapshot`. El contenido normalizado se cifra
con AES-256-GCM usando la clave CRM versionada ya existente; un AAD específico
para snapshots autentica también propietario, fuente, run, digest, fechas y
versiones. No se guarda XML ni URL del feed. Las URLs de imágenes y cualquier
token que pueda aparecer en los datos normalizados quedan dentro del cifrado.
El payload se limita a 8 MiB antes de cifrar. La clave no se guarda en el documento.
La rotación exige conservar la clave de la versión del documento hasta su
caducidad; una clave ausente o incorrecta bloquea, sin fallback inseguro.

NEW usa memoria válida, después persistencia y, si ninguna es válida, bloqueo.
Tras restart/redeploy/otra instancia puede recuperar la evidencia sin consultar
el proveedor. Revalida todos los metadatos, autentica y descifra el contenido,
recalcula su digest y comprueba expresamente `fetchedAt <= now <= expiresAt`
y una edad máxima de cinco minutos. Se comprueba de nuevo el reloj después de
la lectura asíncrona y dentro de la transacción de publicación. El documento
recuperado se conserva en memoria para evitar lecturas DB repetidas. Un cambio
de fuente/identidad invalida inmediatamente la evidencia anterior aunque el
documento siga existiendo. Lectura fallida, descifrado fallido, metadata distinta
o ausencia de evidencia bloquean NEW sin refetch.

El índice TTL `{ expiresAt: 1 }` con `expireAfterSeconds: 0` elimina documentos
efímeros. Su borrado es asíncrono: la autorización nunca depende del TTL de Mongo.
Los índices del modelo se inicializan antes de insertar evidencia. No se añaden
cron, Redis ni almacenamiento histórico. La caché de lectura, la disponibilidad
y los cooldowns de feedAccess siguen siendo locales al proceso y no consultan
esta colección. generic_xml no escribe ni lee snapshots persistidas.

La UI conserva una revisión anterior únicamente para lectura si no puede
actualizarla, e indica la antigüedad de los datos. No promete actualización
automática: esta fase no incorpora un planificador. Guardar una conexión no
significa que se haya descargado ni validado todavía su catálogo.
