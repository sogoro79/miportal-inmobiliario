# Auditoría de chats de un usuario de prueba desactivado

Esta fase prepara una auditoría segura para conversaciones y mensajes asociados a una única cuenta de prueba desactivada. No borra conversaciones, no borra mensajes, no modifica usuarios, no modifica propiedades y no llama servicios externos.

## Relaciones Encontradas

El chat usa estas relaciones:

- `Conversacion.propiedadId`: propiedad sobre la que se abre la conversación.
- `Conversacion.compradorId`: usuario interesado.
- `Conversacion.anuncianteId`: usuario propietario/anunciante.
- `Mensaje.conversacionId`: conversación a la que pertenece el mensaje.
- `Mensaje.userId`: usuario que envió el mensaje.

Los mensajes dependen funcionalmente de la conversación. Si se elimina una conversación sin eliminar sus mensajes, los mensajes quedan huérfanos. Si se eliminan mensajes de una conversación compartida, el otro participante puede perder historial útil.

No se han encontrado archivos ni imágenes asociadas directamente a `Mensaje` o `Conversacion`. Sí pueden existir notificaciones derivadas por `Notificacion.usuarioId` y `Notificacion.propiedadId`, pero la auditoría de chat no las modifica.

## Herramienta

`scripts/clear-single-test-user-chat-data.js` clasifica el estado de una única cuenta seleccionada por:

- `TARGET_USER_ID`
- `TARGET_EMAIL`
- `EXPECTED_ACTIVE=false`

El CLI requiere:

- `CLEAR_SINGLE_TEST_USER_CHAT=true`
- `MONGODB_URI`
- `TARGET_USER_ID`
- `TARGET_EMAIL`
- `KNOWN_TEST_EMAILS`
- `EXPECTED_ACTIVE=false`

`KNOWN_TEST_EMAILS` debe ser una lista explícita, separada por comas, de cuentas confirmadas como pruebas. Todos sus valores deben ser emails válidos, no puede contener duplicados y debe incluir `TARGET_EMAIL`. La auditoría usa esta lista solo para clasificar participantes relacionados; nunca imprime los emails.

Para una futura aplicación exigiría además:

- `APPLY_SINGLE_TEST_USER_CHAT=true`
- `CONFIRM_SINGLE_TEST_USER_CHAT=CLEAR_ONE_DISABLED_TEST_USER_CHAT`

La función core también recibe `apply` y `confirm` como parámetros explícitos, pero en esta primera fase no contiene ninguna escritura. Importarla directamente no permite borrar datos.

## Salida Segura

La auditoría devuelve solo conteos:

- `conversacionesTotales`
- `mensajesTotales`
- `conversacionesConOtroUsuarioActivo`
- `conversacionesSoloUsuariosDesactivados`
- `conversacionesConPropiedadExistente`
- `conversacionesConParticipanteTestActivo`
- `conversacionesConParticipanteTestDesactivado`
- `conversacionesConParticipanteNoTest`
- `conversacionesConParticipanteNoResoluble`
- `todosLosParticipantesSonTest`
- `mensajesPropios`
- `mensajesDeOtros`
- `conversacionesAmbiguas`
- `conversacionesAmbiguasPorMotivo`
- `eliminablesConSeguridad`
- `bloqueadas`
- `motivosBloqueo`
- `aplicariaCambios:false`

No devuelve nombres, emails, IDs, textos de mensajes, documentos completos, tokens ni datos Stripe.

## Criterio Conservador

La estrategia recomendada es combinar A y C:

- permitir una limpieza futura solo para conversaciones donde todos los participantes sean cuentas de prueba/desactivadas y no exista propiedad asociada;
- bloquear cualquier conversación donde el otro participante siga activo;
- bloquear cualquier conversación donde el otro participante no pertenezca exactamente a `KNOWN_TEST_EMAILS`;
- bloquear cualquier conversación con participantes ausentes, inválidos, inconsistentes o no resolubles;
- bloquear cualquier conversación vinculada a una propiedad existente;
- bloquear si `propiedadId` está ausente, es inválido o la consulta de propiedad no es concluyente;
- bloquear mensajes sin autor válido, con autor desconocido o cuya relación con la conversación sea incoherente;
- bloquear si hay mensajes de otros usuarios hasta validar que esos usuarios son también cuentas de prueba/desactivadas y participantes de la conversación;
- eliminar conversación completa y todos sus mensajes solo en una fase posterior, con transacción y confirmación explícita.

La regla general es `incertidumbre = bloqueo`: la auditoría no infiere que un dato ausente, inválido, desconocido o no resoluble es seguro. Tampoco interpreta automáticamente que un resultado vacío sea seguro salvo que la consulta se haya ejecutado correctamente y los identificadores auditados sean válidos.

Las conversaciones ambiguas se agrupan con motivos genéricos: `falta_comprador`, `falta_anunciante`, `ambos_participantes_iguales`, `usuario_objetivo_no_participa`, `participante_no_encontrado`, `identificador_invalido`, `estructura_inconsistente` u `otra_ambiguedad`. Estos motivos no incluyen nombres, emails, IDs, textos ni documentos completos.

No se recomienda anonimizar en esta primera fase porque el modelo actual exige `compradorId`, `anuncianteId` y `userId`, y cambiar esas referencias podría afectar lecturas, no leídos e historial de participantes.

## Procedimiento Seguro

1. Ejecutar primero la auditoría real de solo lectura con la cuenta de prueba seleccionada.
2. Revisar los conteos y motivos de bloqueo.
3. Confirmar fuera del output que la cuenta corresponde a `sonygr@gmail.com`.
4. Si existen usuarios activos, propiedades existentes o mensajes ajenos no verificados como prueba, no limpiar.
5. Implementar una segunda fase separada solo si la auditoría demuestra que todas las conversaciones son de prueba y no quedan propiedades activas o existentes asociadas.

Esta fase no implementa ninguna limpieza real: no borra conversaciones, no borra mensajes y mantiene siempre `aplicariaCambios:false`.
