# MISSING: subfase 1, evidencia para revision manual

MISSING significa que una propiedad CRM existente de una source no figura en
el snapshot completo actual. Nunca implica borrado ni ocultado automatico.
Feeds vacios, ambiguos, invalidos o con mas de 2000 registros bloquean MISSING.
Un plan con mas de 100 detalles no prepara elegibilidad de ocultado.

El plan conserva blocked=true para UPDATE y expone solo hideMissingEligible y
hideMissingBlockCode. No existe endpoint hide-missing ni selector nuevo.
La UI existente sigue mostrando MISSING como bloqueado/requiere revision.

La elegibilidad exige propietario/source exactos, identidad unica, source crm,
syncEnabled, baseline V1 vigente, revision no negativa, sin overrides, visibilidad
true, sin marca de retirada previa y sin ningun registro de reconciliacion ligado
a la propiedad o identidad CRM. La consulta de reconciliaciones falla cerrada.

missingEvidence persiste version, usuario/source, revision y visibilidad esperadas,
enrollment, fingerprint/version de baseline y hash del contenido actual. El ID de
propiedad y externalId estan en la entrada; digest, identidad de source y versiones
de snapshot/normalizacion estan en el run. Nada de esta evidencia se expone al
frontend. Runs legacy sin evidencia, expirados o incompletos quedan bloqueados.
Es evidencia del instante de simulacion, no autorizacion ni garantia de estado
actual: toda condicion debe volver a comprobarse en subfase 2.

La subfase 2 debera redescargar con SSRF/DNS pinning, exigir snapshot completo y
digest igual, ausencia real del externalId, owner/source/ID/revision/visibilidad
iguales, baseline y overrides actuales y ninguna reconciliacion pendiente.
Debera usar lock/fence de source, transaccion y recibo idempotente del run.
No podra borrar propiedades, recursos ni relaciones.

El marcador hiddenByMissingRunId se pospone a subfase 2: no es necesario anadir
campos a Propiedad hasta implementar ocultado. Se comprueba defensivamente si
existiera. removedFromFeedAt ya existe, pero esta subfase no lo escribe.

Republicacion: trialPlanLimits.aplicarLimitesPlanTrasTrial puede volver a poner
visiblePublicamente=true al reparar/redistribuir limites. Antes de habilitar
ocultado, debera respetar el marcador de MISSING con condiciones de escritura
seguras; poner solo visiblePublicamente=false no basta. No se cambia este
comportamiento ahora. Admin tambien permite editar visibilidad manualmente.
Reaparicion futura: solo revision/restauracion manual con cupo y plan vigentes.
