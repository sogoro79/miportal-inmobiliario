# Backup y recuperacion de HomeClick24

Este documento describe el formato actual de backup y las fases de recuperacion disponibles: validacion offline y restauracion controlada a una base temporal.

## Formato actual

`backup.js` genera archivos con nombre:

```text
backup-YYYY-MM-DD.json.gz
```

Al descomprimirlos, el contenido es un JSON con esta forma:

```json
{
  "nombreColeccion": [
    { "_id": "..." }
  ]
}
```

Cada clave raiz es el nombre de una coleccion de MongoDB y cada valor debe ser un array de documentos. El formato actual no incluye indices, validadores, opciones de coleccion, TTL, manifiesto, version de esquema ni metadata del entorno.

`JSON.stringify` serializa datos BSON a JSON plano. Por eso `ObjectId`, `Date`, `Decimal128` y binarios pueden no restaurarse de forma fiel sin logica adicional.

## Validacion offline

Uso:

```bash
npm run backup:validate -- /ruta/backup-2026-08-01.json.gz
```

Con colecciones esperadas:

```bash
npm run backup:validate -- /ruta/backup-2026-08-01.json.gz --expect usuarios,propiedades
```

La validacion no conecta a MongoDB, no usa variables de entorno y no imprime documentos ni datos personales.

Comprueba:

- archivo existente, regular y con extension exacta `.json.gz`;
- rechazo de enlaces simbolicos, directorios y archivos especiales;
- tamano comprimido maximo de 50 MB;
- descompresion gzip por stream;
- tamano descomprimido maximo de 250 MB;
- ratio maximo de descompresion de 100;
- JSON UTF-8 valido;
- raiz como objeto plano;
- colecciones como arrays;
- nombres de coleccion seguros;
- ausencia de claves peligrosas como `__proto__`, `constructor` y `prototype`;
- limites de profundidad, propiedades inspeccionadas y documentos;
- resumen por coleccion y SHA-256 del archivo comprimido.

La salida muestra solo nombre del archivo, tamanos, hash, colecciones, recuentos y warnings seguros.
No muestra documentos, emails, nombres personales, direcciones, IDs, tokens, hashes de contrasena ni contenido de mensajes.

Ejemplo de salida:

```text
Backup válido
Archivo: backup-2026-08-01.json.gz
Tamaño comprimido: 12345 bytes
Tamaño descomprimido: 67890 bytes
Ratio de descompresión: 5.5
SHA-256: <hash-del-archivo-comprimido>
Total de documentos: 42
Colecciones:
- usuarios: 10 documento(s), 0 sin _id
- propiedades: 32 documento(s), 1 sin _id
Warnings:
- propiedades: 1 documento(s) sin _id.
```

El SHA-256 identifica el archivo comprimido original y permite comparar su integridad con un hash confiable registrado externamente. No prueba autenticidad por si solo.

Codigos de error estables usados por el validador:

- `FILE_NOT_FOUND`
- `INVALID_EXTENSION`
- `INVALID_FILE_TYPE`
- `FILE_TOO_LARGE`
- `INVALID_GZIP`
- `UNCOMPRESSED_LIMIT_EXCEEDED`
- `COMPRESSION_RATIO_EXCEEDED`
- `INVALID_JSON`
- `INVALID_ROOT`
- `INVALID_COLLECTION`
- `INVALID_DOCUMENT`
- `DANGEROUS_KEY`
- `DEPTH_LIMIT_EXCEEDED`
- `PROPERTY_LIMIT_EXCEEDED`
- `DOCUMENT_LIMIT_EXCEEDED`
- `MISSING_EXPECTED_COLLECTION`
- `INVALID_EXPECTED_COLLECTIONS`
- `MISSING_DOCUMENT_ID`

Los enlaces simbolicos se rechazan. La validacion acepta solo archivos regulares con nombre seguro y extension exacta `.json.gz`.

La CLI devuelve codigo `0` si el backup es valido y un codigo distinto de `0` si es invalido o si los argumentos no son correctos. Los errores esperados no muestran stack trace.

Si el nombre de archivo empieza por guion, usa `--` para terminar las opciones:

```bash
npm run backup:validate -- -- -backup-2026-08-01.json.gz
```

`--expect` puede indicarse como `--expect usuarios,propiedades` o `--expect=usuarios,propiedades`, pero solo una vez.

## Restauracion

La Fase 2 incorpora preparacion de restauracion a una base temporal. No se ha ejecutado una restauracion real durante la implementacion y la logica de escritura esta cubierta solo con mocks automatizados. Falta una prueba controlada posterior contra una base temporal vacia.

Hay tres operaciones distintas:

- validacion: `npm run backup:validate`, valida formato y muestra resumen seguro;
- dry-run: `npm run backup:restore -- archivo.json.gz --dry-run`, valida y muestra un plan sin conectar a MongoDB;
- restore: `npm run backup:restore -- archivo.json.gz --confirm-restore`, solo para una base temporal permitida y con barreras activas.

El dry-run no prueba que la conexion MongoDB funcione. Solo demuestra que el archivo y el plan son validos.

Uso recomendado de dry-run:

```bash
npm run backup:restore -- /ruta/backup-2026-08-01.json.gz --dry-run
```

Con colecciones esperadas:

```bash
npm run backup:restore -- /ruta/backup-2026-08-01.json.gz --dry-run --expect usuarios,propiedads
```

Comando teorico de restauracion real:

```bash
ALLOW_RESTORE=true \
RESTORE_MONGODB_URI="mongodb+srv://usuario:password@cluster.example/restore_homeclick24_20260801" \
npm run backup:restore -- /ruta/backup-2026-08-01.json.gz --confirm-restore
```

La restauracion real no tiene modo implicito. Debe indicarse `--confirm-restore`.

## Barreras de restauracion

Para una restauracion real deben cumplirse todas estas condiciones:

- `RESTORE_MONGODB_URI`, nunca `MONGODB_URI`;
- rechazo si `RESTORE_MONGODB_URI` coincide con `MONGODB_URI`;
- comparacion normalizada de protocolo, host, puerto, base y parametros, ignorando credenciales;
- URI con nombre explicito de base de datos;
- `ALLOW_RESTORE=true`;
- argumento `--confirm-restore`;
- no usar `--dry-run` junto a `--confirm-restore`;
- destino temporal;
- logs sin documentos ni datos personales.

No existe fallback hacia `MONGODB_URI`. Si falta `RESTORE_MONGODB_URI`, la restauracion se aborta.

La salida puede mostrar el destino sanitizado:

```text
Destino: cluster.example/restore_homeclick24_20260801
```

Nunca debe mostrar usuario, password, query params sensibles ni URI completa.

Bases prohibidas, sin distinguir mayusculas/minusculas:

- `admin`
- `config`
- `local`
- `production`
- `prod`
- `homeclick24`
- `miportal`
- `miportal-inmobiliario`
- `miportal_inmobiliario`

La base temporal debe usar solo letras ASCII, numeros, guion y guion bajo, y debe empezar por uno de estos prefijos. La comparacion de prefijo no distingue mayusculas/minusculas:

- `restore_`
- `restore-`
- `test_restore_`
- `test-restore-`

Ejemplos validos:

- `restore_homeclick24_20260801`
- `test_restore_homeclick24`

Ejemplos invalidos:

- `homeclick24`
- `production`
- `backup`
- `test`
- `temporal`

## Insercion

Antes de insertar, la herramienta comprueba que la base destino no contiene colecciones con datos. Si existe cualquier coleccion no vacia, aborta. Si una coleccion existe pero esta vacia, puede usarse.

La herramienta no ejecuta:

- `dropDatabase`
- `dropCollection`
- `deleteMany`
- `replaceOne`
- `updateMany`

No borra datos automaticamente.

La insercion se realiza:

- coleccion por coleccion;
- lote por lote;
- `batch size` por defecto `500`;
- `batch size` maximo `1000`;
- `insertMany` con `ordered: true`;
- aborto en el primer error.

No usa `ordered: false`, no silencia duplicados de `_id`, no modifica documentos, no regenera `_id`, no convierte strings a `ObjectId` o `Date`, y no usa transacciones en esta fase.

Como no hay transacciones globales, una restauracion puede quedar parcialmente insertada. En ese caso se informa `PARTIAL_RESTORE`, no se intenta rollback automatico y no se borra nada. Antes de reintentar, elimina manualmente la base temporal fallida desde Atlas. No limpies ni modifiques produccion por este procedimiento.

## Limitaciones

Esta fase no preserva ni valida indices, validadores de coleccion, opciones de coleccion, TTL, todos los tipos BSON originales ni cifrado del archivo.

Limitaciones BSON actuales:

- `ObjectId` se restauraria como string;
- `Date` se restauraria como string ISO;
- referencias se mantienen como strings;
- indices y TTL no se restauran;
- no usa EJSON;
- no usa mongodump.

Esta restauracion sirve para inspeccion y recuperacion temporal aproximada. No garantiza una replica exacta de produccion y no debe promoverse automaticamente a produccion.

## Prueba controlada de restauracion completada

Fecha: 2026-08-03.

Tipo de prueba: restauracion real unicamente sobre una base temporal de MongoDB Atlas.

Resultado: completada correctamente.

Backup utilizado:

- archivo: `backup-2026-08-01.json.gz`;
- SHA-256: `5d804c8e043735c60414854314904a2eb8c648ae36cb729d99b3aec9943b17aa`;
- tamano comprimido: 39.228 bytes;
- tamano descomprimido: 214.176 bytes;
- documentos totales: 265;
- colecciones: 8.

Destino temporal:

- base temporal: `restore_homeclick24_20260803`;
- usuario temporal: `restore_temp`;
- permisos: solo `readWrite` sobre `restore_homeclick24_20260803`.

Confirmaciones:

- la base de produccion no se modifico;
- la restauracion inserto 265 documentos en 8 colecciones;
- las colecciones se comprobaron visualmente en Data Explorer;
- despues de la prueba se eliminaron `RESTORE_MONGODB_URI` y `ALLOW_RESTORE` de la sesion local;
- despues de la prueba se elimino la base `restore_homeclick24_20260803`;
- despues de la prueba se elimino el usuario temporal `restore_temp`;
- no quedaron credenciales ni recursos temporales activos.

Resultado por coleccion:

| Coleccion | Documentos restaurados | Lotes | Resultado |
| --- | ---: | ---: | --- |
| `alertas` | 2 | 1 | `inserted` |
| `codigoviptrials` | 3 | 1 | `inserted` |
| `conversacions` | 11 | 1 | `inserted` |
| `estadisticaanuncios` | 171 | 1 | `inserted` |
| `mensajes` | 42 | 1 | `inserted` |
| `notificacions` | 5 | 1 | `inserted` |
| `propiedads` | 20 | 1 | `inserted` |
| `usuarios` | 11 | 1 | `inserted` |

Este registro no incluye contrasenas, URI completas, hostnames sensibles, datos personales, documentos del backup, emails, tokens, hashes ni capturas.

## Procedimiento operativo probado

A. Validacion:

```bash
npm run backup:validate -- <archivo.json.gz>
```

B. Simulacion:

```bash
npm run backup:restore -- <archivo.json.gz> --dry-run
```

C. Restauracion temporal real:

1. Crear una base temporal vacia con prefijo permitido, por ejemplo `restore_homeclick24_YYYYMMDD`.
2. Crear un usuario temporal dedicado.
3. Limitar el usuario temporal a `readWrite` solo sobre esa base temporal.
4. Construir `RESTORE_MONGODB_URI` solo en la sesion local de Terminal.
5. Activar `ALLOW_RESTORE=true` solo en esa misma sesion.
6. Ejecutar `npm run backup:restore -- <archivo.json.gz> --confirm-restore`.
7. Revisar el informe de colecciones, lotes y documentos insertados.
8. Verificar los recuentos y colecciones en Data Explorer.
9. Probar la aplicacion en un entorno aislado si procede.
10. Eliminar variables temporales de la sesion.
11. Eliminar la base temporal cuando deje de ser necesaria.
12. Eliminar el usuario temporal.
13. Documentar el resultado.

No pegues una URI real en tickets, documentacion, chats ni historial compartido.

## Seguridad de credenciales

Procedimiento seguro usado para preparar credenciales temporales:

```bash
read -s RESTORE_PASSWORD
ENCODED_RESTORE_PASSWORD="$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$RESTORE_PASSWORD")"
export ALLOW_RESTORE=true
export RESTORE_MONGODB_URI="mongodb+srv://restore_temp:${ENCODED_RESTORE_PASSWORD}@<cluster>/<base_temporal>"
```

Despues de la prueba:

```bash
unset RESTORE_PASSWORD
unset ENCODED_RESTORE_PASSWORD
unset RESTORE_MONGODB_URI
unset ALLOW_RESTORE
env | grep -E 'RESTORE|ALLOW_RESTORE'
```

La comprobacion final no debe devolver variables activas relacionadas con restauracion.

Reglas:

- leer la contrasena con `read -s`;
- URL-encodear la contrasena antes de construir la URI;
- exportar la URI solo en la sesion local de Terminal;
- no mostrar la URI;
- no pegar la URI en documentacion;
- eliminar variables con `unset`;
- borrar usuario temporal y base temporal al terminar.

## Network Access

Durante la prueba de 2026-08-03 existia acceso `0.0.0.0/0` en MongoDB Atlas.

No se modifico durante la prueba porque Render y GitHub Actions podian depender de la configuracion de acceso existente.

Esta configuracion sigue siendo un riesgo pendiente. Debe auditarse aparte antes de cambiarla, identificando primero las necesidades reales de Render y GitHub Actions.

`0.0.0.0/0` no es una configuracion recomendada como estado final.

## Procedimiento de emergencia

1. Descargar el backup.
2. Conservar una copia original sin modificar.
3. Calcular y registrar SHA-256.
4. Validar el archivo con `npm run backup:validate`.
5. Ejecutar `npm run backup:restore -- archivo.json.gz --dry-run`.
6. Crear una base temporal vacia con prefijo permitido.
7. Configurar temporalmente `RESTORE_MONGODB_URI` hacia esa base temporal.
8. Configurar `ALLOW_RESTORE=true`.
9. Comprobar el destino sanitizado que muestra la herramienta.
10. Ejecutar la restauracion con `--confirm-restore`.
11. Revisar el informe de colecciones, lotes y documentos insertados.
12. Probar login, propiedades, chat y panel admin en entorno aislado.
13. Decidir un plan manual de recuperacion.
14. Documentar el incidente, el hash y las acciones realizadas.

No se debe restaurar directamente sobre produccion.
No se debe importar manualmente el backup en produccion.

## Checklist de emergencia

- Elegir backup.
- Verificar SHA-256.
- Validar con `npm run backup:validate`.
- Ejecutar dry-run con `npm run backup:restore -- <archivo.json.gz> --dry-run`.
- Crear base temporal vacia.
- Crear usuario temporal limitado a esa base.
- Configurar URI temporal solo en la sesion local.
- Restaurar con `--confirm-restore`.
- Comprobar recuentos.
- Verificar visualmente en Data Explorer.
- Probar aplicacion aislada si procede.
- Limpiar variables temporales.
- Eliminar base temporal.
- Eliminar usuario temporal.
- Documentar resultado.

## Registro de pruebas

### 2026-08-03

- Backup: `backup-2026-08-01.json.gz`
- SHA-256: `5d804c8e043735c60414854314904a2eb8c648ae36cb729d99b3aec9943b17aa`
- Resultado: exito
- Produccion modificada: no
- Documentos restaurados: 265
- Colecciones restauradas: 8
- Base temporal eliminada: si
- Usuario temporal eliminado: si
- Credenciales temporales eliminadas: si
