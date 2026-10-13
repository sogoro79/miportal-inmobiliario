# REAPPEARED CRM: detección y restauración manual

La simulación detecta, calcula elegibilidad observada y guarda evidencia
privada en ImportSyncRun sin escribir sobre Propiedad o Usuario.
La subfase 2 añade restauración manual backend, sin botón nuevo ni
republicación automática. Contenido, imágenes, baseline y overrides no cambian.

## Clasificación

REAPPEARED identifica una propiedad CRM existente, única y del mismo
usuario/source/externalId, presente en el feed actual, con visiblePublicamente
false, hiddenByMissingRunId y removedFromFeedAt válidos y un ocultado MISSING
causal confirmado. No es NEW, UPDATE, UNCHANGED ni MISSING.
No cuenta simultáneamente en esas categorías. Se añade reappearedCount.

Si hay marcadores pero no se puede probar la identidad o causa, se devuelve
CONFLICT con un motivo seguro; no se inventa REAPPEARED. Las ocultaciones
manuales/administrativas, eliminaciones y ocultaciones por plan no se convierten
en REAPPEARED. El propio type no autoriza ninguna acción: blocked sigue true.

## Causa y contenido

Se consulta el run causal por ID, con +plan, comprobando usuario, source,
hash de identidad, snapshot/versiones, referencia y propiedad en el plan MISSING,
receipt completed, selección/resultados únicos y contadores coherentes.
hidden y already_hidden son resultados causales confirmados; no se aceptan
receipts preparing/applying/indeterminate/failed.
La caducidad del run antiguo no borra su valor como historial confirmado.
La fecha removedFromFeedAt debe estar dentro del intervalo del ocultado.

Enrollment y baseline gestionado deben seguir válidos. Esta primera versión
exige exactamente la revisión posterior al ocultado (original + 1) y el
fingerprint del contenido original, reconstruyendo solo su visibilidad previa.
Ediciones posteriores, incluso cambios antes aplicados por CRM, necesitan
revisión: no se actualiza ni reestablece automáticamente el baseline.

Cambios gestionados entrantes mantienen REAPPEARED pero bloquean con
REAPPEARED_CONTENT_CHANGED. También se bloquean diferencias suministradas
fuera de los campos simples soportados. Las fotos externas no se equiparan
a imágenes Cloudinary: no se descargan ni aplican. El contenido local,
incluidas imágenes, queda protegido mediante fingerprint.
Un UPDATE legacy contra un anuncio marcado MISSING se bloquea al recalcular
su plan con el marcador privado leído explícitamente.

## Elegibilidad observada

Solo se acepta snapshot completo y plan no truncado. Se consultan
reconciliaciones por propiedad o identidad tanto para MISSING como para
candidatos reaparecidos. No comprobado no significa sin reconciliaciones.
Cualquier reconciliación encontrada bloquea.

Se lee el usuario y se cuenta mediante getPublicationAvailability, conservando
los límites de planLimits y el filtro comercial actual de publicaciones.
Usuario/plan activos, aceptación y fecha del VIP trial, fecha del Plan
Lanzamiento y campaña, promoción profesional y fechas manuales se comprueban
sin ejecutar expiraciones ni modificar el plan. Plan desconocido queda bloqueado.
Un anuncio caducado no se renueva. VIP/trials ilimitados no evitan estas condiciones.
El cupo es individual y observado: varias entradas podrían ser elegibles para
el mismo último hueco; ninguna se publica en esta subfase.

## Evidencia y respuesta segura

restoreEvidence, dentro del plan privado, conserva propiedad/usuario/source y
externalId, revisión, visibilidad y marcadores esperados, baseline/version,
hash gestionado y de contenido, causa validada, comprobación de reconciliaciones,
plan/cupo/visibles observados, fechas y versiones/digest/identidad de la simulación.
No guarda XML, URLs del feed, contenido completo ni secretos.
El plan está select:false. safeRunSummary nunca devuelve evidencia interna.

Contrato de una entrada:

```json
{
  "externalId": "CRM-1",
  "type": "REAPPEARED",
  "blocked": true,
  "linked": true,
  "restoreEligible": true,
  "restoreBlockCode": null
}
```

Se conservan campos comunes seguros como changedFields/reason.
El GET vuelve a comprobar vigencia, versiones, coherencia/evidencia completa y
fechas observadas. No vuelve a consultar el cupo ni documentos vivos:
restoreEligible describe una simulación, no una autorización definitiva.
Runs legacy sin evidencia no se habilitan; requieren nueva simulación.
La UI actual muestra REAPPEARED como requiere revisión, sin checkbox o acción.

## Códigos seguros

- REAPPEARED_SNAPSHOT_INCOMPLETE / REAPPEARED_RUN_TRUNCATED
- REAPPEARED_PROPERTY_NOT_FOUND / REAPPEARED_IDENTITY_AMBIGUOUS
- REAPPEARED_OWNER_CHANGED / REAPPEARED_SOURCE_CHANGED
- REAPPEARED_HIDE_MARKER_MISSING / REAPPEARED_REMOVAL_DATE_MISSING
- REAPPEARED_CAUSAL_RUN_INVALID / REAPPEARED_ALREADY_VISIBLE
- REAPPEARED_NOT_ENROLLED / REAPPEARED_BASELINE_INVALID
- REAPPEARED_MANUAL_OVERRIDE / REAPPEARED_OTHER_HIDING_CAUSE
- REAPPEARED_RECONCILIATION_UNCHECKED / REAPPEARED_RECONCILIATION_PENDING
- REAPPEARED_REVISION_INVALID / REAPPEARED_CONTENT_CHANGED
- REAPPEARED_PLAN_INACTIVE / REAPPEARED_PLAN_LIMIT / REAPPEARED_LISTING_EXPIRED
- REAPPEARED_RUN_CHANGED / REAPPEARED_RUN_EXPIRED

## Subfase 2: restauración manual backend

`POST /api/crm-import/sync/restore-reappeared`, requireAuth y rate limits por
IP/usuario coherentes con apply. Body estricto: `{ runId, externalIds }`, entre
1 y 10 referencias distintas. Owner siempre procede de la sesión; no admite
sourceId, propertyId, URLs, contenido o fingerprints del cliente.

Se adquiere el mismo lease de source que UPDATE/NEW/MISSING y se descarga una
vez el feed con SSRF/pinning y presupuesto compartido de 120 segundos.
Snapshot completo, referencias aún presentes y digest idéntico son obligatorios.
Cambios de contenido de los seleccionados devuelven REAPPEARED_CONTENT_CHANGED;
otros cambios del snapshot devuelven REAPPEARED_FEED_CHANGED. No se aplica UPDATE.

Una sola transacción snapshot/majority reclama el receipt (preparing/applying),
incrementa Usuario.publicationVersion antes del conteo, relee usuario, source,
propiedades, runs causales y reconciliaciones, verifica toda la evidencia y
comprueba `visibles + seleccionados <= límite`. VIP/vip_trial no tienen límite
comercial pero conservan todas las comprobaciones de estado y vencimiento.
Se exige la identidad y configuración cifrada actual de source, baseline,
contenido íntegro, revisión, marcadores y ausencia de overrides/reconciliaciones.
Las fechas y vigencia se verifican otra vez antes de terminar.

Cada escritura condicional incluye _id, owner/source/externalId, visibilidad
false, marcadores, revisión y baseline esperados. Solo modifica:
visiblePublicamente=true, hiddenByMissingRunId=null, removedFromFeedAt=null,
contentRevision+1 y timestamps Mongoose. Ningún efecto externo, foto o email.
Si una escritura falla, todo el lote y publicationVersion hacen rollback.
withTransaction puede reejecutar trabajo Mongo; el refetch queda fuera del callback.

### Receipt e idempotencia

ImportSyncRun.reappearedRestore conserva selección congelada, selectionHash,
operationId, fechas, resultados restored y conteos. El claim y completed están
en la misma transacción que las propiedades: no hay intent previo fuera de ella.
Completed + misma selección devuelve el resultado almacenado sin escrituras
ni refetch, incluso después de caducar. Selección distinta se rechaza.
preparing/applying/indeterminate/failed bloquean nueva ejecución; no hay retry
automático de la operación. Estar visible no demuestra idempotencia.
Esta primera versión no genera already_restored por inspeccionar la propiedad:
repetir completed conserva los resultados restored originales.

Si el commit queda incierto, se intenta una lectura primary/majority del receipt.
Si confirma completed se devuelve éxito. Si no, se guarda indeterminate mediante
CAS que no pisa completed ni otra operación. Un aborto confirmado puede guardar
failed fuera de la transacción. Estas escrituras solo afectan el run; si fallan,
se loguea un código seguro y se devuelve resultado no confirmado. No se reenvía
restore. Un cliente debe consultar GET run antes de considerar otro intento.
Una pérdida de conexión/respuesta después de commit es recuperable por GET.

GET expone reappearedRestore con estado, selección, fechas, resultados y conteos
sanitizados, nunca operationId/selectionHash/evidencia/IDs internos. Los receipts
de restore bloquean elegibilidad y claims de UPDATE, NEW y MISSING; restore
rechaza runs consumidos por cualquiera de ellos. Sin cambiar casos legacy válidos.

### Alcance real de la contención

publicación manual y NEW/Fase 2 usan createPublicationPersistence y el mismo
Usuario.publicationVersion. Dos restores o restore y esos publicadores fuerzan
WriteConflict/retry al escribir el mismo usuario; el conteo se rehace en un
snapshot nuevo, sin compartir el último hueco. No se promete exclusión respecto
a escritores externos al portal (por ejemplo modificaciones directas de base
de datos). Edición normal, edición admin y recuperación de planes ahora usan
la misma contención al incorporar cupo, sin alterar la transacción ni el receipt
del restore. Véase [PUBLICATION_CAPACITY.md](PUBLICATION_CAPACITY.md) para el
predicado exacto, inventario online y alcance de la garantía.

Los tests de concurrencia usan sesiones/modelos in-memory, verifican el fence
antes del conteo y modelan conflictos de snapshots/retries; no son una prueba
de integración contra Atlas real.

## Pendiente de UI

Selección independiente, confirmación y Volver a publicar solo después de
auditar el backend. No mezclar restauración con UPDATE. Si se requiere aplicar
cambios a reaparecidos, se diseñará un flujo separado; esta versión los bloquea.
