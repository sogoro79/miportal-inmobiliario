# Auditoria segura de assets Cloudinary

Esta auditoria compara, en modo estrictamente de solo lectura, las referencias de imagen guardadas en MongoDB con los recursos de imagen listados en Cloudinary dentro de la carpeta `miportal_inmobiliario`.

No elimina imagenes, no modifica propiedades, no corrige referencias y no llama a Stripe. Su salida contiene solo conteos y booleanos agregados.

## Script

Archivo:

```bash
scripts/audit-cloudinary-assets.js
```

Ejecucion prevista:

```bash
AUDIT_CLOUDINARY_ASSETS=true \
MONGODB_URI="..." \
CLOUDINARY_CLOUD_NAME="..." \
CLOUDINARY_API_KEY="..." \
CLOUDINARY_API_SECRET="..." \
node scripts/audit-cloudinary-assets.js
```

El script rechaza argumentos CLI. No existe flag de borrado ni modo de aplicacion.

## Barreras

Antes de conectar valida:

- `AUDIT_CLOUDINARY_ASSETS` debe ser exactamente `true`.
- `MONGODB_URI` debe estar presente.
- `CLOUDINARY_CLOUD_NAME` debe estar presente.
- `CLOUDINARY_API_KEY` debe estar presente.
- `CLOUDINARY_API_SECRET` debe estar presente.
- No debe recibir argumentos CLI adicionales.

Los valores como `TRUE`, `1`, `yes`, `false` o cadena vacia no activan la auditoria.

## Alcance de lectura

MongoDB:

- Lee `Propiedad.imagenes`.
- No lee documentos completos.
- No escribe usuarios, propiedades ni otros documentos.

Cloudinary:

- Lista recursos de tipo `image` con `type=upload`.
- Usa el prefijo `miportal_inmobiliario`.
- Sigue `next_cursor` con limite de paginas configurable.
- Si la paginacion falla, se repite un cursor, falta una respuesta o se alcanza el limite con cursor pendiente, marca la auditoria como incompleta.

## Extraccion de referencias

La aplicacion guarda actualmente `secure_url` en `Propiedad.imagenes`.

La auditoria deriva `public_id` solo cuando:

- la URL es `https://res.cloudinary.com/.../image/upload/...`;
- pertenece a la carpeta `miportal_inmobiliario`;
- tiene extension permitida `jpg`, `jpeg`, `png` o `webp`;
- no contiene segmentos inseguros;
- el parser existente puede extraer el identificador sin ambiguedad.

Tambien acepta referencias historicas que ya sean `public_id` directos bajo `miportal_inmobiliario/`.

Las URLs externas, malformadas, de otra carpeta o no resolubles se contabilizan como `urlsMongoSinPublicId` y requieren revision.

## Salida

El resumen incluye:

- `propiedadesAnalizadas`
- `referenciasMongoTotales`
- `publicIdsMongoUnicos`
- `urlsMongoSinPublicId`
- `recursosCloudinaryTotales`
- `recursosReferenciados`
- `recursosCloudinaryHuerfanosCandidatos`
- `referenciasMongoSinRecursoCloudinary`
- `publicIdsDuplicadosEnMongo`
- `referenciasCompartidasEntrePropiedades`
- `recursosFueraDelAmbito`
- `resultadosIncompletos`
- `auditoriaCompleta`
- `requiereRevision`
- `aplicariaCambios:false`
- `modo:"solo_lectura"`

No imprime emails, nombres, IDs de MongoDB, URLs, `public_id`, documentos, credenciales, respuestas crudas ni textos de errores externos.

## Candidatos huerfanos

Un recurso solo cuenta como `recursosCloudinaryHuerfanosCandidatos` si:

- pertenece al prefijo real `miportal_inmobiliario`;
- no aparece referenciado en MongoDB;
- la lectura de MongoDB fue completa;
- la paginacion de Cloudinary fue completa;
- no hubo errores parciales.

Un candidato no implica eliminacion automatica. Debe revisarse manualmente antes de plantear cualquier limpieza futura.

## Casos incompletos

Si hay incertidumbre, el script marca:

- `resultadosIncompletos:true`
- `auditoriaCompleta:false`
- `requiereRevision:true`

En ese estado no declara recursos huerfanos candidatos.

## Prohibiciones

Esta auditoria no debe:

- borrar recursos en Cloudinary;
- subir, renombrar o modificar recursos;
- actualizar documentos de MongoDB;
- borrar propiedades;
- tocar usuarios;
- enviar emails;
- importar `server.js`;
- iniciar rutas o schedulers;
- ejecutar migraciones.
