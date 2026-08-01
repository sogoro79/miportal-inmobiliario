# Backup y recuperacion de HomeClick24

Este documento describe el formato actual de backup y la Fase 1 de recuperacion: validacion offline de archivos `.json.gz`.

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

La restauracion todavia no esta implementada.

Esta fase tampoco preserva ni valida indices, validadores de coleccion, opciones de coleccion, todos los tipos BSON originales ni cifrado del archivo.

Cuando se implemente, debera estar separada de la validacion y bloquear por defecto cualquier intento de restaurar sobre produccion. El diseno previsto exige:

- `RESTORE_MONGODB_URI`, nunca `MONGODB_URI`;
- rechazo si `RESTORE_MONGODB_URI` coincide con `MONGODB_URI`;
- rechazo de bases llamadas `production`, `prod`, `homeclick24` o equivalentes de produccion;
- `ALLOW_RESTORE=true`;
- argumento `--confirm-restore`;
- modo `--dry-run`;
- destino temporal;
- logs sin documentos ni datos personales.

## Procedimiento de emergencia

1. Descargar el backup.
2. Calcular y registrar SHA-256.
3. Validar el archivo con `npm run backup:validate`.
4. Crear una base temporal no productiva.
5. Restaurar solo en la base temporal cuando exista la Fase 2.
6. Comparar recuentos por coleccion.
7. Probar login, propiedades, chat y panel admin en entorno aislado.
8. Decidir un plan de migracion hacia produccion.
9. Documentar el incidente, el hash y las acciones realizadas.

No se debe restaurar directamente sobre produccion.
