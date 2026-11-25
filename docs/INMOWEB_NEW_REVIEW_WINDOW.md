# Ventana de revisión NEW

La captura conserva `expiresAt = fetchedAt + 5 minutos`. El run conserva su
caducidad de 20 minutos. `record`, `bind`, `get`, `readPersisted`, transporte,
gate, caché e import-new no admiten capturas más antiguas que antes.

Solo `readNewReview` permite leer el documento cifrado ya vinculado al run hasta
el menor de `fetchedAt + 30 minutos` y `startedAt + 30 minutos`. A los 30:00 exactos
se rechaza. En runs legacy sin startedAt se deriva el comienzo de expiresAt menos
los 20 minutos originales. Nunca se cambian fechas ni se instala esta evidencia
en el caché/lease usado para importar.

Se siguen validando el run, fuente/titular, digest, versiones y autenticidad AEAD.
El lector autorizado exige NEW, source activa y delegación vigente, y revalida
run/source/delegación después de consultar la cartera. La caducidad nueva solo
se expone como `newReviewExpiresAt`; `expiresAt` y `snapshotExpiresAt` siguen
representando sus restricciones anteriores. UPDATE y acciones de escritura no
utilizan esta capacidad. No hay refetch, renovación ni escritura al revisar.

## Retención física: requisito antes de desplegar

El schema previo declaraba `{ expiresAt: 1 }`, nombre generado `expiresAt_1`,
con `expireAfterSeconds: 0`, en la colección explícita `providerSnapshots`.
No se ha consultado el índice de producción; el script verifica su estado real.

La propuesta inicial local de 1500 segundos daba 5 + 25 = 30 minutos totales,
**no** 25 minutos extra sobre la ventana de revisión. El objetivo final es **1800
segundos sobre expiresAt**: 5 minutos de frescura + 30 de retención adicional =
**35 minutos desde fetchedAt**, con 5 minutos de margen respecto a la revisión
lógica de 30. El monitor TTL puede borrar más tarde, no debería anticipar el umbral;
el margen evita depender de ese retraso y absorbe desfases modestos entre relojes.
No garantiza tolerancia a desfases arbitrarios superiores a 5 minutos. La lectura
sigue rechazando a los 30:00 aunque el documento permanezca físicamente.

Esto no cambia expiresAt ni su valor autenticado/cifrado. No renueva documentos,
no amplía la importación ni recupera snapshots previamente borradas.

### Acción administrativa explícita antes del despliegue

En el entorno autorizado, con `MONGODB_URI` existente y permisos listIndexes/collMod:

```sh
node scripts/update-provider-snapshot-ttl.js
```

No escribir la URI en la línea de comandos ni logs. El script admite la
configuración dotenv local solo al invocarlo directamente. Importarlo no conecta.
Usa el driver Mongo nativo distribuido con Mongoose, sin importar modelos,
`Model.init`, autoIndex, syncIndexes ni escritura de documentos. No modifica
servidor, package scripts, arranque ni tareas programadas.

Inspecciona listIndexes; exige exactamente el índice esperado, key pattern simple
`{ expiresAt: 1 }`, nombre `expiresAt_1`, TTL 0, 1500 o 1800 y sin variantes
parciales/sparse/unique/hidden. Cualquier discrepancia requiere revisión manual.
Si ya es 1800 termina sin command. Para 0 o 1500 ejecuta únicamente:

```js
{ collMod: "providerSnapshots", index: { name: "expiresAt_1", expireAfterSeconds: 1800 } }
```

Después vuelve a listar y exige 1800. No hay drop/recreate, creación de índices,
colecciones ni rollback automático. Un timeout podría ocurrir después de que
Mongo aplicara el cambio; volver a ejecutar es seguro porque inspecciona primero.

Salida segura esperada (se omiten detalles de formato de consola):

```text
ProviderSnapshot TTL: inspección
{ collection: 'providerSnapshots', index: 'expiresAt_1', currentTTL: 0, targetTTL: 1800 }
ProviderSnapshot TTL: cambio verificado
{ collection: 'providerSnapshots', index: 'expiresAt_1', currentTTL: 1800, targetTTL: 1800 }
```

En segunda ejecución: inspección 1800 y `correcto, sin cambios`, sin collMod.
Si existe la propuesta intermedia, la primera línea mostrará currentTTL 1500.
Los errores usan mensajes estáticos: no URI, credenciales, mensajes Mongo crudos,
stacks, documentos ni metadatos de otros índices. Los fallos dejan exit code 1;
la conexión se cierra también al fallar. Éxito deja exit code 0.

### Compatibilidad y orden

El repo fija Mongoose/driver, pero **no acredita la versión ni permisos del servidor
MongoDB real**. La operación modifica un TTL existente; no intenta convertir un
índice normal a TTL. Si la versión/configuración rechaza collMod o faltan permisos,
se detiene y lo indica de forma segura. Alternativa mínima: el administrador revisa
compatibilidad/permisos y habilita una modificación in-place soportada, luego
repite este comando. No se ofrece fallback destructivo ni se afirma compatibilidad
real sin comprobarla. Si no es posible modificar in-place, no desplegar este cambio
hasta acordar una intervención manual separada.

**Cambiar el schema no modifica por sí solo el índice ya existente.** Ejecutar y
verificar este ajuste antes de arrancar el código con el TTL nuevo: de lo contrario
se pueden borrar snapshots prematuramente y `Model.init()` puede rechazar opciones
de índice incompatibles. No automatizar el ajuste en el servidor.

No se ha ejecutado el script contra MongoDB ni se han consultado servicios reales.

## QA local

Pruebas con snapshots cifradas sintéticas, reloj controlado y modelos en memoria:
0, 5 minutos, 5:00.001, 29:59, 30:00 y después; identidades, digest/versiones,
externalId y revocación; importación sigue rechazando >5 minutos. Sin Mongo real.

El menú Admin usa portal a body, posición fixed, ancho limitado al viewport,
scroll interno y z-index 900 (por debajo de los diálogos). Se reposiciona al hacer
scroll/resize y abre arriba cuando hay más espacio y no cabe abajo. Conserva
handlers de acciones, teclado y foco al cerrar con Escape.

**Pendiente de revisión visual manual:** escritorio, tablet, 390×844 y 320×440;
último usuario e intermedios, scroll de tabla, zoom, acciones y apertura de
modales desde el menú. Solo se han validado HTML/CSS/JS y tests de geometría/DOM.
