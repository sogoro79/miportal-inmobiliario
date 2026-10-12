# Limpieza controlada de NEW CRM

Herramienta temporal exclusiva para SYNC-NEW-TEST-001 y su fuente:
https://www.homeclick24.com/test-sync-new/homeclick24-sync-new-test.xml

No ejecutar hasta obtener autorizacion. No se ejecuta al importar el modulo.
Usa MONGODB_URI ya configurada en Render y dotenv en local, sin imprimirla.

Dry-run (IDs obligatorios, no seleccionar por nombre/email):

```sh
node scripts/cleanup-crm-sync-new.js --user-id=<USER_ID_ALBERTO> --source-id=<SOURCE_ID_PRUEBA>
```

Apply, solo tras revisar APTO PARA LIMPIEZA y copiar planHash del dry-run:

```sh
node scripts/cleanup-crm-sync-new.js --user-id=<USER_ID_ALBERTO> --source-id=<SOURCE_ID_PRUEBA> --apply --confirm=DELETE_SYNC_NEW_TEST_ALBERTO --expect-plan=<PLAN_HASH_DRY_RUN>
```

El hash del plan detecta cambios en documentos/versiones entre lectura y apply.
Apply revalida dentro de una transaccion con withTransaction y escritura sobre
la fuente compartida para contender con importacion/configuracion concurrente.
Requiere MongoDB compatible con transacciones (Atlas replica set).

Identidad: propietario y source explicitos, URL exacta mediante hash SHA-256,
source crm, externalId exacto, titulo, precio 198000, localidad Chipiona,
operacion venta y referencia vacia del flujo real. No presupone referencia=externalId.
No se borran usuarios ni se modifican planes/publicationVersion.

Los receipts NEW estan embebidos en ImportSyncRun; desaparecen solo con runs
dedicados. Cualquier otra referencia, propietario o propiedad bloquea la limpieza.
Reconciliaciones unknown/cleanup_required bloquean; solo prepared sin recursos
ni motivo pendiente y con identidad completa pueden retirarse. Estadisticas
inequivocamente ligadas a la propiedad y propietario se retiran. Chats, favoritos
y notificaciones bloquean; nunca se borran. Los mensajes quedan protegidos al
bloquear conversaciones. Sin fotos persistidas: cero llamadas Cloudinary.
Un placeholder exclusivamente visual no figura en imagenes; cualquier entrada
persistida en imagenes bloquea por prudencia, incluso si parece un placeholder.

Ejecutar en una ventana sin actividad de esta cuenta/anuncio. MongoDB no impone
claves foraneas: lectores externos que creen nuevos favoritos/chats durante la
limpieza no comparten necesariamente el lock CRM. La transaccion revalida las
referencias existentes, pero no es un bloqueo global de toda la aplicacion.

Tras aplicar, verificar los conteos y verificacionPosterior. Un segundo apply
completamente limpio devuelve YA LIMPIO sin escrituras. Una respuesta perdida o
un error de commit no autoriza a asumir borrado: consultar primero con dry-run.
No retirar aun el feed publico ni la documentacion de prueba.
