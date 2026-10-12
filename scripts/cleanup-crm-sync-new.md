# Limpieza CRM tras borrado manual de NEW

Herramienta temporal exclusiva para SYNC-NEW-TEST-001 y la fuente:
https://www.homeclick24.com/test-sync-new/homeclick24-sync-new-test.xml

La propiedad ya debe estar eliminada. Cualquier propiedad con ese externalId,
vinculada a la source o referenciada por sus receipts bloquea la limpieza.
No elimina ni modifica propiedades, usuarios, planes, favoritos, chats,
mensajes, notificaciones, estadisticas ni recursos externos.

Dry-run por defecto, con IDs explicitos de Alberto y su source de prueba:

```sh
node scripts/cleanup-crm-sync-new.js --user-id=<USER_ID_ALBERTO> --source-id=<SOURCE_ID_PRUEBA>
```

Solo tras revisar APTO PARA LIMPIEZA y planHash, y con autorizacion:

```sh
node scripts/cleanup-crm-sync-new.js --user-id=<USER_ID_ALBERTO> --source-id=<SOURCE_ID_PRUEBA> --apply --confirm=DELETE_SYNC_NEW_TEST_ALBERTO --expect-plan=<PLAN_HASH_DRY_RUN>
```

Usa MONGODB_URI existente, sin imprimirla ni modificar variables. Requiere
transacciones (Atlas replica set). AutoIndex y autoCreate estan desactivados.
No ejecutar este script real durante su preparacion o sus tests.

Valida propietario/source/tipo y hash SHA-256 de la URL exacta. Runs y receipts
deben contener exclusivamente el externalId de prueba. Runs truncados,
propietarios/fuentes distintos, referencias CRM cruzadas o varios IDs de
propiedad bloquean. Recibos importing/indeterminate y locks bloquean.
Reconciliaciones solo se retiran con identidad completa, source crm y estado
prepared sin recursos ni motivo pendiente; las demas requieren diagnostico.

Apply reconsulta dentro de withTransaction, compara el hash del plan y escribe
la misma source usada por los locks CRM antes de borrar. Conflictos/retries
revalidan: no puede confirmarse una importacion concurrente inadvertida sobre
esa source. Solo borra source, runs dedicados (incluyen receipts NEW) y
reconciliaciones validadas. Los IDs originales de receipts se conservan para
comprobar referencias CRM residuales y ausencia de propiedades al finalizar.
No necesita una barrera de borrado de propiedad: no borra ninguna propiedad.

Una segunda ejecucion completamente limpia devuelve YA LIMPIO sin escrituras.
Ante respuesta perdida o commit indeterminado, consultar dry-run: no asumir
rollback ni repetir a ciegas. No comprueba ni limpia referencias no CRM que
pudiera haber dejado el borrado manual previo.
El feed publico y la documentacion de prueba permanecen intactos.
