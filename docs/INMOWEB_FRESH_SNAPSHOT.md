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

El almacenamiento es por proceso, con límites de entradas y de XML retenido.
Reinicio, deploy, expulsión por capacidad o petición en otra instancia pueden
eliminar/no encontrar la evidencia: NEW falla de forma segura y pide una nueva
revisión, sin descarga automática. No se añade Redis ni persistencia en base de
datos. Los cooldowns también siguen siendo locales al proceso.

La UI conserva una revisión anterior únicamente para lectura si no puede
actualizarla, e indica la antigüedad de los datos. No promete actualización
automática: esta fase no incorpora un planificador. Guardar una conexión no
significa que se haya descargado ni validado todavía su catálogo.
