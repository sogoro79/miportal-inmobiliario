# Eliminación administrativa de usuarios desactivados

Esta función permite eliminar una única cuenta de usuario desde el panel de administración solo cuando ya está desactivada y no conserva dependencias de riesgo.

## Requisitos

La eliminación requiere:

- sesión de administrador válida;
- usuario existente;
- usuario distinto del administrador autenticado;
- `role` distinto de `admin`;
- `activo=false`;
- ausencia de `stripeCustomerId` y `stripeSubscriptionId`;
- ausencia de `pendingPlan`, `pendingPriceId` y `pendingPlanChangeAt`;
- confirmación exacta `ELIMINAR_USUARIO_DESACTIVADO`.

Primero debe desactivarse el usuario porque esa acción bloquea el acceso y oculta sus anuncios. La eliminación es irreversible y no debe usarse como sustituto de cancelaciones o reparaciones de suscripción.

## Resumen Previo

`GET /admin/usuarios/:id/eliminacion-resumen` devuelve solo conteos seguros:

- estado desactivado;
- presencia de datos Stripe;
- presencia de cambios pendientes;
- propiedades;
- chats;
- mensajes;
- favoritos propios;
- alertas;
- notificaciones;
- posibilidad de eliminar;
- motivos de bloqueo.

No devuelve contraseña, documentos personales, tokens, emails, nombres, IDs Stripe ni objetos completos.

## Datos Relacionados

La primera versión usa una estrategia conservadora:

- bloquea si el usuario tiene propiedades;
- bloquea si participa en conversaciones;
- bloquea si tiene mensajes;
- elimina únicamente alertas propias;
- elimina únicamente notificaciones propias;
- los favoritos propios desaparecen al eliminar el documento del usuario;
- no borra imágenes Cloudinary;
- no modifica propiedades;
- no llama Stripe;
- no envía correos.

Las propiedades bloquean la eliminación porque pueden tener imágenes, estadísticas, favoritos de terceros, SEO público y relaciones de chat. Las conversaciones y mensajes bloquean la eliminación porque son relaciones compartidas entre usuarios y requieren una estrategia específica de anonimización o desvinculación.

## Transacción

La eliminación se ejecuta dentro de una transacción MongoDB obligatoria. Si no se puede iniciar una sesión transaccional, la operación aborta antes de modificar datos.

Dentro de la transacción se revalida el estado del usuario y los conteos bloqueantes. Después se eliminan las alertas y notificaciones propias, y finalmente se elimina el usuario con un filtro condicional que vuelve a exigir `activo=false`, ausencia de Stripe y ausencia de cambios pendientes. No se usa `upsert` ni reintentos.

## Procedimiento Seguro de Prueba

Para una cuenta de prueba como `sonygr@gmail.com`, después del despliegue:

1. Confirmar visualmente en el panel que está desactivada.
2. Confirmar que no aparecen acciones de Stripe pendientes.
3. Abrir la acción de eliminar, que consultará el resumen previo.
4. Revisar que `puedeEliminar=true` y que no hay motivos de bloqueo.
5. Confirmar la eliminación solo si la cuenta es la prueba esperada.
6. Verificar que la lista de usuarios se recarga y que la cuenta ya no aparece.

Si el resumen indica datos Stripe, propiedades, chats, mensajes o cambios pendientes, no debe forzarse la eliminación desde el panel.
