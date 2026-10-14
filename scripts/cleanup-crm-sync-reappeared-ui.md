# Cleanup temporal de la prueba UI REAPPEARED

Herramienta one-off para restos CRM de Alberto, después de eliminar manualmente
el target. No selecciona por nombre, título ni email: la autoridad son los IDs
explícitos, ownership, URL/hash exactos y evidencia de la prueba.

- URL exacta: `https://www.homeclick24.com/test-sync-reappeared-ui/homeclick24-reappeared-ui.xml`
- Target: `SYNC-REAPPEARED-UI-001`
- Control: `SYNC-REAPPEARED-UI-CONTROL-001` (nunca importado).
- Feed type: `generic_xml`.

## Dry-run en Render Shell

Desde la raíz del proyecto, usando `MONGODB_URI` ya configurada:

```sh
node scripts/cleanup-crm-sync-reappeared-ui.js \
  --user-id=<USER_ID> \
  --source-id=<SOURCE_ID>
```

No ejecutar todavía. Sustituir placeholders solo tras verificar los IDs por
lecturas autorizadas. El nombre/email se muestran únicamente como evidencia
auxiliar. Dry-run solo hace find, no abre sesión transaccional, no escribe ni
crea colecciones/índices: autoIndex=false y autoCreate=false. No imprime URI,
credenciales, ciphertext, tokens de lock, fingerprints ni stacks. ExternalIds
fuera de whitelist se cuentan y se muestran como referencia ajena, sin imprimir
contenido arbitrario que pudiera contener URLs firmadas o tokens.

Revisar resultado, runs, referencias y planHash. Deben estar ausentes todas las
propiedades target/control, de la source y de IDs históricos; también cualquier
hiddenByMissingRunId o lastSeenRunId que apunte a runs candidatos.

Exige exactamente un receipt missingHide completed (target hidden, 1/0) y uno
reappearedRestore completed (target restored, 1/0), selección/resultados únicos,
fechas coherentes y relación causal con el mismo ID histórico del target.
Acepta simulaciones dedicadas CONFLICT/UNCHANGED/MISSING/REAPPEARED para target
y NEW para control. No presupone un número de runs.

Bloquea run compartido, propietario/source ajenos, snapshot incompleto/truncado,
estado activo/failed/indeterminate, cualquier NEW import o UPDATE consumido,
lock con token (incluso antiguo), referencias inversas y reconciliaciones
inciertas/ambiguas. Solo una reconciliación prepared, sin recursos/reasonCode,
del target y mismo ID histórico puede ser eliminada. No resolver bloqueos a mano
ni cambiar datos para forzar APTO; diagnosticar primero.

## Apply, solo con autorización posterior

```sh
node scripts/cleanup-crm-sync-reappeared-ui.js \
  --user-id=<USER_ID> \
  --source-id=<SOURCE_ID> \
  --apply \
  --confirm=DELETE_SYNC_REAPPEARED_UI_TEST_ALBERTO \
  --expect-plan=<PLAN_HASH_DEL_DRY_RUN>
```

Mantener la cuenta sin actividad CRM durante la ventana dry-run/apply.
Reconsulta todo fuera y dentro de withTransaction snapshot/majority y exige
el mismo planHash. El hash determinista cubre IDs, whitelist, documentos leídos,
versiones/fechas, receipts/evidencia, ausencia de propiedades y refs cruzadas.
Una escritura de fence sobre la misma source coordina con los locks CRM
productivos: una carrera obliga a conflicto/revalidación, no a borrado a ciegas.
No protege contra escrituras administrativas directas externas al protocolo.

Borra exclusivamente IDs validados de ImportSyncRun, ImportReconciliation e
ImportSource. Los receipts UPDATE/NEW/MISSING/restore son embebidos y desaparecen
solo con su run; cualquier UPDATE/NEW no explicado bloquea previamente. No hay
colección separada de receipts en la arquitectura actual. No toca Usuario,
Propiedad, plan, suscripciones, favoritos, chats, mensajes, notificaciones,
estadísticas, recursos o imágenes. No llama Cloudinary ni descarga el feed.

Verifica dentro de la transacción y otra vez después del commit, conservando
los IDs históricos de runs/propiedad/reconciliaciones. Éxito exige
`LIMPIEZA COMPLETADA` y `verificacionPosterior=true`. Un fallo dentro revierte
todas las escrituras. Si falla la comprobación posterior al commit o la respuesta
queda incierta, puede haberse realizado el borrado: no asumir rollback ni repetir
apply; diagnosticar con lecturas/dry-run. No hay retries manuales automáticos.

Segundo dry-run debe devolver `YA LIMPIO`, source ausente, cero propiedades,
runs, reconciliaciones, receipts y referencias. Un apply ya limpio tampoco
escribe. Esta tarea solo prepara script, documentación y tests con mocks;
no ejecuta nada contra producción. La retirada del feed y de estos artefactos
será otra tarea después de confirmar la limpieza real.
