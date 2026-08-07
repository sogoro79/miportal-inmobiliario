# Promoción Profesional 60 días

## Objetivo

La campaña permite a profesionales e inmobiliarias activar una única prueba gratuita de 60 días con prestaciones profesionales sin límites. Es gratuita, no requiere tarjeta, no tiene permanencia y no se renueva automáticamente.

## Campaña

- Nombre visible: `Promoción Profesional 60 días`.
- Identificador interno: `professional-60-2026`.
- Señal visual/entrada pública: `professional-60`.
- Fecha límite de activación: `2026-10-31 23:59:59 Europe/Madrid`, representada en backend como `2026-10-31T22:59:59.000Z`.
- Duración individual: 60 días exactos desde `activatedAt`.

Las activaciones realizadas el 30 o el 31 de octubre de 2026 reciben igualmente sus 60 días completos.

## Plan promocional

El entitlement interno es `professional_trial_60d`.

- No es plan comercial.
- No es visible como plan contratatable.
- No tiene Stripe Price ID.
- No llama a Stripe.
- No se mezcla con `vip_trial`.
- Reutiliza los límites centrales de `utils/planLimits.js`.

Durante la promoción:

- anuncios ilimitados;
- fotos ilimitadas;
- `planActivo: true`;
- `planFechaFin` apunta al fin individual de la promoción.

## Datos obligatorios

Para activar se requiere:

- usuario autenticado;
- email verificado mediante el sistema real existente (`Usuario.verificado`);
- nombre comercial;
- nombre del responsable;
- tipo profesional;
- teléfono móvil;
- NIF/DNI/NIE profesional;
- aceptación expresa de condiciones.

Se reutilizan `nombre`, `tipoDoc` y `numDoc` cuando corresponde. Se añaden campos mínimos para `telefonoMovil`, `nombreComercial` y `tipoProfesional`.

## NIF, DNI y NIE

La normalización:

- convierte a mayúsculas;
- elimina espacios, puntos, guiones y separadores admitidos;
- valida formato;
- valida letra/dígito de control.

Ejemplos equivalentes como `B-12345678`, `B12345678` y `b 12345678` se reducen a una única forma canónica cuando el control es válido.

## Móvil

Para España se normaliza a `+34XXXXXXXXX` y se aceptan espacios, guiones, paréntesis y prefijo `0034`. Solo se aceptan móviles españoles que empiezan por `6` o `7`.

No existe verificación SMS real en la arquitectura actual. Por tanto:

- `movilVerificadoRealDisponible:false`;
- no se integra Twilio ni ningún proveedor externo;
- no se marca internamente el móvil como verificado por OTP.

## Redención histórica antifraude

El modelo `ProfessionalTrialRedemption` mantiene memoria aunque se elimine el documento `Usuario`.

Campos principales:

- `campaign`;
- `normalizedIdentityHash`;
- `normalizedPhoneHash`;
- `hmacKeyVersion`;
- `userId`;
- `activatedAt`;
- `endsAt`;
- `status`;
- timestamps.

Los hashes son HMAC-SHA256 deterministas con separación de dominio por finalidad (`identity` y `mobile`). No se usa SHA-256 simple. No se guardan NIF/DNI/NIE ni móvil en claro en la colección histórica.

La configuración admite un secreto dedicado `PROFESSIONAL_PROMO_HMAC_SECRET` y versión `PROFESSIONAL_PROMO_HMAC_KEY_VERSION`. Mientras no se configure, existe un fallback compatible a `JWT_SECRET` con versión `jwt_secret_fallback_v1`. Antes de rotar `JWT_SECRET` en producción debe configurarse un secreto dedicado o conservar el secreto anterior en `PROFESSIONAL_PROMO_HMAC_LEGACY_SECRETS` para que las redenciones históricas sigan bloqueando reutilizaciones. Esta documentación no requiere ni aplica cambios de secrets.

## Concurrencia

La colección histórica define índices únicos:

- `campaign + normalizedIdentityHash`;
- `campaign + normalizedPhoneHash`.

La activación captura errores de clave duplicada y devuelve un mensaje público genérico: `No es posible activar esta promoción con los datos facilitados.`

## Activación

La activación revalida en backend:

- campaña activa;
- usuario autenticado;
- email verificado;
- usuario no admin;
- usuario activo;
- datos completos;
- documento válido;
- móvil válido;
- usuario no redimido anteriormente;
- documento no redimido anteriormente;
- móvil no redimido anteriormente;
- ausencia de plan de pago incompatible.

Después crea la redención y asigna `professional_trial_60d` dentro de una transacción MongoDB. Si no se puede iniciar sesión o transacción, la activación aborta con error seguro y no continúa sin atomicidad. No utiliza Stripe, no cobra y no envía SMS.

## Expiración

La expiración es idempotente y se ejecuta por scheduler periódico, no por `setTimeout` por usuario. Detecta promociones vencidas aunque el servidor haya estado apagado.

Al expirar:

- no cobra;
- no llama a Stripe;
- no renueva;
- cambia a `gratis`;
- aplica límites de plan gratis reutilizando `aplicarLimitesPlanTrasTrial`.

Las propiedades no se borran. Si hay más anuncios que el plan gratis permite, se reutiliza la lógica existente de visibilidad/downgrade.

## Contratación durante la promoción

Si durante la promoción el usuario contrata un plan de pago real, el plan de pago prevalece. La expiración promocional no debe sobrescribir un estado Stripe activo/trialing ni degradar un pago posterior.

## Eliminación de cuenta

La eliminación de `Usuario` no elimina `ProfessionalTrialRedemption`. Esta excepción conserva la huella antifraude mínima necesaria para impedir repetir la promoción con el mismo documento o móvil.

## IP y rate limit

La IP no es llave principal ni bloquea por sí sola. Se reutiliza rate limiting específico para proteger el endpoint de activación frente a fuerza bruta y enumeración.

## Privacidad

No se exponen ni deben registrarse:

- NIF/DNI/NIE completo;
- móvil completo;
- hashes;
- IP;
- documentos Mongo completos;
- tokens.

El endpoint público devuelve estados seguros y no enumerables. El panel admin muestra solo conteos agregados y estado promocional por usuario sin documento, móvil, hash ni IP.

## Panel admin

El panel muestra:

- activaciones totales;
- activas;
- expiradas;
- bloqueadas;
- próximas a expirar en 7 días.

En usuarios con promoción se muestra un distintivo `Promo profesional`, fecha de fin y estado.

## Qué no toca

- No usa Stripe.
- No tiene Price ID.
- No llama a Cloudinary.
- No envía SMS.
- No ejecuta migraciones manuales.
- No activa usuarios reales por sí mismo.
