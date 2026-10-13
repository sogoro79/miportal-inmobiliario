# Contención del cupo de publicaciones

## Predicado único

El predicado es el ya utilizado por getPublicationAvailability:

```js
{
  usuarioId,
  visiblePublicamente: { $ne: false },
  activo: { $ne: false },
  eliminada: { $ne: true },
  oculto: { $ne: true },
  estadoComercial: { $nin: ["Vendido", "Alquilado", "Reservado", "No disponible"] }
}
```

consumesPublicationQuota es su equivalente en memoria. Campos ausentes pasan
los $ne/$nin. La fecha de caducidad no forma parte del conteo comercial actual,
ni se añaden otras banderas de ocultación al predicado de cupo. Las exclusiones
más estrictas del helper de recuperación se conservan como elegibilidad, no
como una segunda forma de contar capacidad.

## Fence compartido

fencePublicationUser hace $inc de Usuario.publicationVersion dentro de sesión,
antes del conteo. No es un contador comercial ni un mutex fuera de MongoDB.
Dos escritores del mismo usuario provocan conflicto documental: withTransaction
reintenta con snapshot nuevo y vuelve a contar. No hay retries manuales.
La actualización, el conteo y la escritura de propiedades comparten sesión,
readConcern snapshot y writeConcern majority. El aborto revierte el fence.

## Ediciones normales y admin

savePropertyWithCapacity conserva el save existente si la edición ya consumía
cupo, sigue sin consumirlo o lo reduce. Una descripción/precio en 10/10 no
adquiere cupo y no se rechaza por el límite.

Para false -> true respecto al predicado: captura/valida los cambios una vez,
fence, relee usuario y propiedad, comprueba plan/vencimientos, revisión y cupo,
y persiste el mismo patch con condiciones de owner, revisión y marcadores.
El cambio Vendido -> Disponible también ocupa cupo aunque la visibilidad sea true.
Admin no está exento. No hay bypass administrativo implícito.

Las revisiones y syncOverrides se calculan una sola vez fuera del callback;
los retries solo repiten trabajo MongoDB. Subidas y borrados de imágenes siguen
fuera. Ante UnknownTransactionCommitResult no se limpian nuevas imágenes a
ciegas ni se afirma guardado: respuesta 503 segura, recargar antes de repetir.
El helper no ejecuta emails, Cloudinary, notificaciones ni otros efectos externos.

hiddenByMissingRunId o removedFromFeedAt bloquean la publicación por edición.
Solo restore-reappeared puede restaurar manualmente un anuncio ocultado por CRM.

## Recuperación de planes

aplicarLimitesPlanTrasTrial relee usuario, destino y propiedades dentro de una
transacción. Cuando los flags permiten recuperar anuncios, escribe el mismo
fence antes de leer/cuantificar capacidad. Si el plan cambió, aborta el destino
obsoleto. Una reducción/renovación sin recuperación no incrementa la versión.

Conserva primero los anuncios ya publicados. Una reducción real de plan puede
ocultar exceso, como antes; nunca se oculta un publicado para favorecer a un
oculto por una recuperación. Usa el conteo común para el cupo ocupado y asigna
solo huecos disponibles a candidatos normales. Toda selección/escritura se
rehace en la sesión al reintentar; no se usa una lista anterior a la transacción.

Se excluyen siempre hiddenByMissingRunId, removedFromFeedAt y las ocultaciones
manuales/administrativas/estados no disponibles existentes. La escritura de
recuperación vuelve a exigir marcadores null y revisión esperada.
La reparación periódica no intenta recuperar usuarios inactivos.

## Inventario final

| Escritor online que incorpora cupo | Fence compartido |
| --- | --- |
| POST /propiedades (publicación manual) | Sí, publicationPersistence |
| Fase 2 / import selected | Sí, mismo servicio de persistencia |
| sync/import-new | Sí, reutiliza Fase 2 y sus transacciones/receipts |
| sync/restore-reappeared | Sí, conserva un único lote atómico |
| PUT /propiedades/:id, reincorporación por estado comercial | Sí, savePropertyWithCapacity |
| PUT admin/propiedades/:id, false -> true | Sí, mismo helper y límite del propietario |
| Reparación/recuperación de planes | Sí, aplicarLimitesPlanTrasTrial |

UPDATE CRM no modifica estados comerciales ni visibilidad. MISSING,
caducidad gratuita y desactivación solo reducen ocupación. Reactivar usuario,
asignar planes, aceptar VIP/promociones y webhooks Stripe no hacen visibles
propiedades directamente. Las expiraciones que llaman al helper de límites
usan ahora la misma decisión transaccional. Configuración de planLimits y el
default visiblePublicamente del modelo no son escritores independientes.
La restauración de backups a una base aislada no es un escritor online del portal.

No queda una excepción online implícita para incorporar cupo. Un futuro bypass
de admin requeriría una decisión comercial y contrato explícitos.

## Verificación y alcance

Tests con modelos in-memory fuerzan dos snapshots iguales, conflicto de versión
al commit y reejecución del callback. Cubren restore/edición, restore/admin,
restore/recuperación, NEW/edición, NEW/admin, NEW/recuperación,
publicación/recuperación y admin/recuperación, además de rollback y casos HTTP.
No sustituyen una prueba de integración con un replica set real.

La garantía es para transiciones de ocupación de estos escritores online;
no sanea automáticamente documentos históricos ni un cambio de plan que reduzca
el límite sin ejecutar su aplicación de límites. Cambios manuales en MongoDB
quedan fuera. No se cambian catálogo, límites, Stripe o política de planes.
