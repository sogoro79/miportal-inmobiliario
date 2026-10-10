# Limpieza one-off de datos CRM DEMO

Esta herramienta no forma parte del servidor ni de las rutas CRM. No descarga
feeds, no llama Cloudinary y no importa modelos con efectos de inicializacion.
Solo conecta a MongoDB cuando se ejecuta directamente como CLI. Carga dotenv
siguiendo el mecanismo del proyecto, sin imprimir variables ni secretos.

## Antes de usarla

- Verificar personalmente el userId de Alberto y el sourceId de su fuente DEMO.
- Proporcionar la URL original exacta del feed: se normaliza y se compara su
  SHA-256 igual que en el importador. No se descarga ni se imprime esa URL.
- No usar una URL que contenga secretos en una linea de comandos compartida:
  los argumentos pueden ser visibles en el historial y en la lista de procesos.
- Ejecutar primero dry-run y revisar sus cantidades. No borra ni adquiere locks.
- Para apply, garantizar una ventana sin actividad de la cuenta (publicaciones,
  ediciones, importaciones, configuraciones y simulaciones), y sin otros procesos
  que creen referencias a los cuatro anuncios. Un snapshot no impide nuevas
  referencias concurrentes. Las simulaciones no usan el lock de importacion.
- Se exige MongoDB compatible con transacciones. No hay fallback no atomico.

## Dry-run

```sh
node scripts/cleanup-crm-sync-demo.js \
  --user-id='<ALBERTO_USER_ID>' \
  --source-id='<IMPORT_SOURCE_ID>' \
  --expected-feed-url='<URL_DEMO_ORIGINAL>'
```

## Apply (no ejecutar hasta autorizar la limpieza real)

```sh
node scripts/cleanup-crm-sync-demo.js \
  --user-id='<ALBERTO_USER_ID>' \
  --source-id='<IMPORT_SOURCE_ID>' \
  --expected-feed-url='<URL_DEMO_ORIGINAL>' \
  --apply --confirm=DELETE_SYNC_DEMO_ALBERTO
```

Sin ambas autorizaciones exactas se realiza solamente dry-run. Se exige el
conjunto exacto de cuatro referencias y ninguna otra propiedad de esa fuente.
Se bloquean imagenes, reconciliaciones, locks incluso residuales con token,
simulaciones running y referencias externas. Usuario solo se lee con proyeccion
de identidad/plan, y favoritos para comprobar referencias; nunca se modifica.

La comprobacion de referencias recorre las colecciones ordinarias y sus campos
anidados, sin volcar documentos. Se rechazan vistas y se aborta al superar
100.000 documentos por coleccion o el timeout de lectura; no se asume que una
lectura parcial sea segura. Puede necesitar permisos de lectura de todas las
colecciones y ser costosa: cualquier fallo impide el borrado. Los nombres de
colecciones coinciden con la pluralizacion actual de los modelos del proyecto.

Dentro de una transaccion se toma contencion sobre el documento ImportSource
con los mismos campos de lock de Fase 2, se repite el preflight y se compara el
estado con el anterior. Solo se borran los IDs fijados de propiedades, runs y
fuente. El lock desaparece junto con la fuente al confirmar; un aborto revierte
tambien el lock. Los reintentos del driver no realizan llamadas externas.

Se verifican las cantidades y el usuario/plan antes del commit y despues. Un
error de commit indeterminado o de verificacion posterior no demuestra que se
haya revertido: revisar mediante dry-run y diagnostico antes de repetir apply.
Nunca borrar imagenes ni reconciliaciones automaticamente para desbloquearlo.
