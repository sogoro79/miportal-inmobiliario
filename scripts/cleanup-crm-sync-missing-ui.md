# Limpieza controlada de la prueba UI MISSING CRM

Herramienta one-off. Prepararla no ejecuta ninguna conexión. Ejecutar después,
solo con autorización, desde Render Shell y con los IDs verificados de Alberto
y su source temporal.

## Dry-run (por defecto)

```sh
node scripts/cleanup-crm-sync-missing-ui.js \
  --user-id=<USER_ID_ALBERTO> \
  --source-id=<SOURCE_ID_PRUEBA>
```

No escribe ni crea índices. Usa MONGODB_URI existente mediante dotenv y desactiva
autoIndex/autoCreate. No imprime credenciales, URL cifrada ni contenido de anuncios.
Muestra plan actual, IDs de runs, fechas, referencias y estados seguros.

Identidad de source: mismo usuario, generic_xml y SHA-256 exacto de
https://www.homeclick24.com/test-sync-missing-ui/homeclick24-missing-ui.xml.

ExternalIds permitidos exclusivamente:
- SYNC-MISSING-UI-001
- SYNC-MISSING-UI-CONTROL-001

En esta nota TEST significa SYNC-MISSING-UI-001 y CONTROL significa
SYNC-MISSING-UI-CONTROL-001.

TEST ya debe estar eliminado. CONTROL nunca debe haberse importado.
Se aborta ante cualquier propiedad con esos externalIds (incluso de otro usuario),
con esa source o con IDs históricos encontrados en los receipts/planes.
No se asume referencia = externalId. Nunca se escribe sobre Propiedad.
También se consulta hiddenByMissingRunId con los IDs de runs candidatos y
proyección explícita +hiddenByMissingRunId. Cualquier propiedad que conserve
esa referencia aborta, incluso con owner/source/externalId distintos.
La consulta entra en el planHash y se repite después del borrado usando los IDs
históricos de runs, sin modificar ningún marcador.

Los runs deben ser del mismo usuario/source, sin truncamiento ni operaciones en
curso/indeterminadas y contener solo referencias permitidas en plan y receipts.
missingHide solo puede referirse a TEST. Se reportan por separado receipts UPDATE,
NEW y MISSING, eliminados únicamente con su run; no hay colección de receipts
independiente en la arquitectura actual.
Para APTO se exige exactamente un missingHide completed: selección de un solo
TEST, un solo resultado TEST con status hidden, countHidden=1 y
countAlreadyHidden=0. No se acepta already_hidden para esta prueba concreta.
Los runs anteriores sin receipt son válidos, siempre que el conjunto contenga
ese único receipt final. El resumen incluye propiedadesConHiddenByMissingRunId,
missingHideCompletedReceipts y missingHideReceiptValido. Si todo está ya
eliminado, YA LIMPIO no exige un receipt que ya no existe.

Reconciliaciones: solo CRM del mismo usuario/source y externalId, enlazadas a un
ID histórico de la prueba que aparezca en un run. Solo estado prepared, sin
publicIds ni motivo de persistencia indeterminada. Cualquier ambigüedad o recurso
pendiente aborta, en vez de intentar resolverlo/borrarlo.
Un token de lock presente o lease futuro bloquea la limpieza.

## Apply (no ejecutar hasta autorización)

```sh
node scripts/cleanup-crm-sync-missing-ui.js \
  --user-id=<USER_ID_ALBERTO> \
  --source-id=<SOURCE_ID_PRUEBA> \
  --apply \
  --confirm=DELETE_SYNC_MISSING_UI_TEST_ALBERTO \
  --expect-plan=<PLAN_HASH_DRY_RUN>
```

Se reconsulta todo dentro de withTransaction (snapshot/majority). El planHash
cubre documentos/IDs completos leídos, receipts, identidades, timestamps y ausencia
de propiedades; cualquier cambio aborta. No editar manualmente el hash.
Una escritura de coordinación sobre la misma source fuerza contención con las
operaciones CRM normales antes de eliminarla. Solo borra runs/reconciliaciones
validados por ID y la source exacta. Se validan conteos e IDs históricos antes de
commit. Cualquier fallo revierte la transacción.

Segunda ejecución sin restos: YA LIMPIO, sin escrituras.
No toca usuarios, planes, suscripciones, favoritos, chats, mensajes,
notificaciones, estadísticas ni Cloudinary.

## Operación segura

No usar CRM simultáneamente durante la limpieza. La coordinación cubre los flujos
productivos que respetan el lock/source; no sustituye una ventana sin escrituras
administrativas directas a MongoDB. No cambiar/crear datos manualmente entre
dry-run y apply. Atlas debe soportar transacciones.

Si la conexión/commit falla o su resultado es incierto, no asumir éxito ni
fracaso: ejecutar un nuevo dry-run autorizado antes de decidir. Los errores
se muestran como códigos seguros, sin mensajes internos ni URI.

No retirar los feeds/documentación de la prueba en este commit.
