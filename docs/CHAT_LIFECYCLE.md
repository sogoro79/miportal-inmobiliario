# Gestión segura de conversaciones y mensajes

## Alcance

HomeClick24 permite que cada usuario gestione su propio historial de chat sin borrar automáticamente información que otro participante real todavía puede necesitar.

## Reglas de usuario

- Un usuario puede eliminar únicamente mensajes enviados por su propia cuenta.
- Un usuario puede eliminar una conversación de su historial mediante `hiddenFor`.
- La conversación se borra físicamente solo cuando todos sus participantes la han eliminado de su historial.
- Si la conversación sigue visible para otra persona, sus mensajes se conservan.

## Cuentas eliminadas

Cuando un administrador elimina una cuenta desactivada:

- se eliminan solo los mensajes enviados por esa cuenta;
- las conversaciones con mensajes de otros participantes se conservan;
- la cuenta eliminada se marca en `deletedParticipants`;
- el participante restante ve `Usuario eliminado`;
- no se permite responder a una cuenta eliminada;
- no se crea un usuario ficticio de reemplazo.

## Anuncios eliminados

Si una conversación apunta a una propiedad que ya no existe, la interfaz muestra `Anuncio no disponible`. No se borran mensajes por la ausencia del anuncio.

## Eliminación física

Una conversación solo se elimina físicamente cuando:

- ningún participante la conserva en su historial; o
- al eliminar una cuenta desactivada no quedan mensajes de otros participantes.

## Seguridad

Esta gestión no llama a Stripe ni Cloudinary, no envía correos adicionales y no modifica propiedades. La eliminación administrativa sigue exigiendo usuario desactivado, no administrador, sin Stripe local activo, sin cambios de plan pendientes y sin propiedades asociadas.
