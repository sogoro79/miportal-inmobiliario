# Procesamiento de expiraciones de planes

Esta fase deja procesadores seguros e idempotentes preparados sin crear migraciones ni colecciones nuevas.

Los nuevos mecanismos están apagados por defecto. Solo se activan con la cadena exacta `true`:

- `ENABLE_PENDING_PLAN_CHANGES`
- `ENABLE_MANUAL_PLAN_EXPIRATIONS`
- `ENABLE_PLAN_READ_REPAIR`

`vip_trial` conserva su scheduler histórico.

## Cambios programados

`utils/planChanges.js` procesa cambios Stripe programados desde los campos `pendingPlan`, `pendingPriceId` y `pendingPlanChangeAt` solo si `ENABLE_PENDING_PLAN_CHANGES=true`.

- Stripe sigue siendo la fuente de verdad.
- Si Stripe falla, los campos pending se conservan.
- Si el webhook ya aplicó el cambio, se limpian los campos pending sin llamar a Stripe.
- El scheduler devuelve un resumen con candidatos, aplicados, omitidos y errores.

## Planes manuales vencidos

`utils/manualPlanExpirations.js` detecta planes manuales vencidos sin escribir por defecto. La aplicación requiere `apply:true` y el scheduler solo arranca con `ENABLE_MANUAL_PLAN_EXPIRATIONS=true`.

- `vip_trial` queda excluido porque lo gestiona `utils/trials.js`.
- `gratis`, fechas futuras y fechas ausentes se omiten.
- Planes desconocidos generan alerta y no se modifican.
- Los planes manuales procesables iniciales son solo `vip` y `agencia_pro`.
- `basico`, `destacado`, `starter`, `pro_agentes` y `agencia_basica` quedan omitidos por defecto aunque estén vencidos sin Stripe.
- Si se aplica una expiración, el usuario pasa a `gratis`, con `planActivo=false` y `planFechaFin=null`.
- No se borran anuncios ni imágenes, pero `aplicarLimitesPlanTrasTrial` puede cambiar `visiblePublicamente` y `fechaExpiracion` de propiedades. Por eso no debe activarse sin auditoría previa.

## Historial futuro

La utilidad devuelve una estructura mínima `before`/`after` por cambio aplicado o simulado. En una fase posterior conviene persistir esa información en una colección dedicada, por ejemplo `PlanChangeEvent`, con:

- `usuarioId`
- `source`
- `reason`
- `before`
- `after`
- `createdAt`
- `dryRun`

No debe incluir emails, tokens, secretos ni datos personales innecesarios.

## Dry-run y auditoría

`scripts/plan-expirations-dry-run.js` es una simulación local con datos inventados. No conecta a MongoDB, no llama a Stripe y no informa sobre producción.

`scripts/audit-plan-expirations.js` es una auditoría agregada de solo lectura. Requiere `AUDIT_PLAN_EXPIRATIONS=true` y `MONGODB_URI`, no importa Stripe, no guarda documentos y no muestra identificadores personales.

`scripts/audit-pending-plan-changes.js` es una auditoría detallada de cambios de plan programados vencidos. Requiere `AUDIT_PENDING_PLAN_CHANGES=true` y `MONGODB_URI`; si existe `STRIPE_SECRET_KEY`, consulta Stripe únicamente con `subscriptions.retrieve` para clasificar cada caso sin mostrar identificadores reales.

- No modifica MongoDB.
- No modifica Stripe.
- No envía correos.
- No importa rutas del servidor ni arranca schedulers.
- Si falta `STRIPE_SECRET_KEY`, completa la parte MongoDB, marca `stripeDisponible=false` y deja la comprobación Stripe como pendiente.
- Devuelve agregados y casos numerados efímeros, sin emails, nombres, IDs completos, customer IDs, subscription IDs, price IDs, metadata ni documentos.

## Procedimiento posterior

1. Desplegar con todos los nuevos flags apagados.
2. Ejecutar la auditoría real agregada.
3. Ejecutar la auditoría detallada de cambios programados.
4. Revisar conteos, clasificación y bloqueos.
5. Decidir si procede una ejecución controlada.
6. No activar todavía el scheduler periódico.

No deben activarse a la vez varios procesadores ni cambiar red/credenciales durante una corrección.
