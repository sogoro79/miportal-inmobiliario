# Emails de chat y recordatorios

El mensaje se guarda antes de notificar al otro participante. El email contiene un
extracto escapado de hasta 400 caracteres y un enlace `/chat?id=...`, que utiliza
la autorización existente. El helper de Resend solo confirma éxito si devuelve
`data.id` sin `error`; nunca registra respuestas ni excepciones completas.

## Ejecución

Job independiente, sin conexiones ni envíos al importar el módulo:

```sh
node scripts/send-unread-message-reminders.js
```

Reutiliza `MONGODB_URI` y `RESEND_API_KEY` existentes y la configuración habitual
del remitente. No hay variables nuevas, endpoint público ni timer nuevo. No se
ha ejecutado contra servicios reales.

El servidor tiene temporizadores específicos de caducidad de planes, sin un
scheduler compartido para jobs de email. No hay configuración Render versionada
que defina este job. Se propone ejecutarlo posteriormente como tarea periódica
independiente (por ejemplo, cada hora) en Render, con las credenciales existentes.
Esto no está activado ni configurado en esta entrega. El envío ocurre en la
primera ejecución posterior a 24h, no necesariamente en el segundo exacto.

## Persistencia y agrupación

`Mensaje.leido` sigue siendo la única fuente de verdad. Se reutilizan `creado`,
`userId` y `conversacionId`; el receptor se deriva de comprador/anunciante.
`reminderSentAt` guarda la fecha de envío confirmado. Su ausencia legacy equivale
a null. Solo se incluyen fechas BSON válidas, `leido:false` explícito, edad >=24h,
participantes coherentes y receptor existente/activo con email. Se excluyen
conversaciones ocultas para el receptor o con participantes eliminados.

Cada ejecución envía como máximo un email por conversación. Si hay pendientes
en ambos sentidos, atiende primero el grupo del mensaje más antiguo; el otro
queda para la siguiente ejecución. Marca únicamente los IDs incluidos, nunca
mensajes recientes ni los que lleguen durante el envío. No se hace backfill de
mensajes antiguos. La primera ejecución puede incluir pendientes legacy antiguos.

Índice añadido a Mensaje: `leido, reminderSentAt, creado, conversacionId`.

## Concurrencia y límites

Un claim Mongo atómico sobre la conversación (`reminderLockToken`,
`reminderLockUntil`, ocultos en consultas normales) excluye ejecuciones concurrentes.
La liberación exige el token propio. El marcado de mensajes y la liberación final
se realizan en una transacción con escritura condicional sobre el claim vigente;
un worker cuyo token o lease ya no es válido no puede finalizar. Requiere MongoDB
con transacciones (replica set, como el resto de operaciones transaccionales del chat).
Un proceso caído deja un lease recuperable
tras 15 minutos. Se revalida el lease y se relee el estado no leído antes de enviar.
Una clave de idempotencia SHA-256 de conversación, receptor e IDs ordenados del
lote se pasa como segundo argumento de emails.send; el SDK instalado la convierte
en la cabecera Idempotency-Key. No contiene identificadores legibles.

No existe transacción distribuida con el proveedor de email: si confirma el envío
y falla el marcado en Mongo, el lote sigue pendiente. La idempotencia del proveedor
ayuda en reintentos del mismo lote, pero su retención es limitada; un lote distinto,
un envío que dure más que el lease o una recuperación muy tardía pueden duplicar.
Tampoco puede eliminarse la carrera de lectura/desactivación entre la última
comprobación y el envío externo. No se promete entrega exactamente una vez.

Un fallo de envío no marca reminderSentAt y no detiene otras conversaciones.
Los fallos de consulta/marcado/liberación solo registran phase/provider/safeCode.
El job resume fallos individuales y continúa con código cero; solo un fallo global
(configuración, conexión, consulta inicial o cierre de conexión) produce código no cero.
La consulta inicial filtra pendientes y agrupa en Mongo, devolviendo máximo 100
conversaciones. Cada lote carga máximo 500 mensajes (solo ID, remitente y fecha);
los restantes siguen pendientes. No hay consultas por cada mensaje. La agrupación
puede recorrer todos los pendientes en Mongo; estos límites acotan memoria y emails
del proceso, no todo el coste del servidor. Si muchas conversaciones inválidas ocupan
repetidamente el cupo, será necesario un cursor persistido para asegurar progreso
sobre carteras muy grandes. No se ha activado ninguna tarea periódica.
