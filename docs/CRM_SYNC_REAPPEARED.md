# REAPPEARED CRM: subfase 1

Esta subfase solo detecta, calcula elegibilidad observada y guarda evidencia
privada en ImportSyncRun. No hay endpoint de restauración, botón nuevo ni
republicación automática. No se modifica Propiedad, Usuario, contenido,
imágenes, baseline, overrides o revisiones. Se mantienen el lock de source y
la persistencia de runs que ya usa la simulación.

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

## Pendiente, no implementado

Backend restore: refetch seguro, digest idéntico, nueva comprobación de todos
los documentos, plan/cupo actuales, contención con publicationVersion antes
del conteo, lote atómico, exclusión entre operaciones y receipt independiente
con idempotencia/recuperación GET. Mantener límite 10 y no efectos externos.
La recuperación de planes no debe republicar anuncios automáticamente.

UI: selección independiente, confirmación y Volver a publicar solo después de
auditar el backend. No mezclar restauración con UPDATE. Si se requiere aplicar
cambios a reaparecidos, se diseñará un flujo separado; esta versión los bloquea.
