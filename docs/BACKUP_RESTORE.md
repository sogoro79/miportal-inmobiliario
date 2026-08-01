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
