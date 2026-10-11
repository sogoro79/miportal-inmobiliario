# Fase 3B.2A: NEW manual desde sincronizacion

Backend solamente. No hay UI nueva, automatizacion ni aplicacion de MISSING.

## Contrato

`POST /api/crm-import/sync/import-new` exige autenticacion y un body estricto:

```json
{ "runId": "<ObjectId>", "externalIds": ["<referencia NEW>"] }
```

El propietario procede de la sesion. Se admiten 1 a 10 referencias distintas,
presentes como NEW en una simulacion vigente, completa y no truncada. Las
limitaciones independientes son 5 intentos/hora por usuario y por IP.

## Revalidacion y reutilizacion

El orquestador comprueba fuente propia/activa, identidad, versiones, vigencia y
ausencia de reconciliaciones. Adquiere el lock compartido una vez, descifra la URL,
redescarga mediante el fetcher seguro y exige el mismo snapshotDigest completo.
Los valores nuevos proceden del feed, nunca del body ni de los valores del run.

Se invoca createSelectedImporter de Fase 2 con un contexto exclusivamente interno:
fuente, lease existente, presupuesto compartido y hooks MongoDB. No se adquiere
un segundo lock. El orquestador libera solamente su lease. El endpoint publico de
Fase 2 sigue usando su camino original, sin este contexto.

Se conservan los limites de 10 inmuebles, 100 fotos y 120 segundos, asi como los
limites comerciales vigentes. VIP y vip_trial no eliminan los limites tecnicos.
Las comprobaciones de plan/cupo, descarga, subida, cleanup, reconciliacion y
publicationVersion pertenecen a los servicios existentes.

## Persistencia e idempotencia

newImport es independiente de los campos de UPDATE. Congela la seleccion antes
de crear inmuebles. Cada propiedad y su recibo NEW se escriben en la misma
transaccion; las imagenes permanecen fuera del callback reintentable. No hay
rollback global del lote. Una identidad existente se devuelve como already_exists
y no como una creacion atribuida a este run.

Una operacion completada con la misma seleccion devuelve los recibos almacenados
sin redescargar, subir ni escribir. Otra seleccion se rechaza. importing,
indeterminate y failed no se reintentan automaticamente. Si falla la confirmacion
del resumen despues de crear propiedades, se conserva el recibo y se devuelve
SYNC_NEW_UNCONFIRMED. Debe consultarse el run antes de cualquier otra accion.

GET /api/crm-import/sync/runs/:id devuelve un resumen sanitizado de newImport:
estado, referencias, contadores, identificadores, fechas y codigos permitidos.
No devuelve XML, URLs del feed, ciphertext ni valores completos de propiedades.
Tras NEW debe simularse de nuevo para otras operaciones. Los anuncios creados
conservan la semantica de Fase 2; su vinculacion al baseline sigue siendo explicita.

## Verificacion y limitaciones

Los tests usan servicios reales con dobles de MongoDB/Cloudinary y transacciones
simuladas (incluyendo rollback y retry). No sustituyen una prueba de integracion
contra un replica set: no se ha conectado MongoDB ni Cloudinary real.

Produccion necesita el soporte de transacciones que ya exige la publicacion de
Fase 2 (replica set/Atlas compatible) y los indices CRM existentes. El presupuesto
compartido limita el trabajo del lote; finalizar cleanup/reconciliacion o liberar
el lease puede continuar tras agotar ese presupuesto, para no abandonar recursos.
Un resultado indeterminado requiere comprobacion/reconciliacion, no un reintento
automatico. No se cambia SSRF, DNS pinning, cifrado ni la politica de imagenes.

## Normalizacion compartida y exito parcial

Simulacion e importacion comparten los alias canonicos de tipo/condicion:
house -> casa, apartment -> apartamento, flat -> piso, new -> obra_nueva,
used/resale/second-hand -> segunda_mano. Una condicion explicita desconocida
se rechaza, sin sustituirla silenciosamente. Si falta la condicion, el snapshot
y el mapper la omiten; la creacion conserva el valor predeterminado segunda_mano.
Los tipos desconocidos conservan el fallback historico de Fase 2, mientras que
la simulacion los marca invalidos y bloquea NEW por snapshot incompleto.

La prueba de fallo del segundo recibo confirma que la primera propiedad y su
recibo ya confirmado permanecen intactos. Solo se revierte la segunda transaccion
y se limpian sus imagenes. completed significa lote terminado, no exito global:
los resultados y contadores indican un importado y un omitido en ese escenario.
