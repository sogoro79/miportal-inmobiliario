# MISSING: evidencia y ocultado manual, subfases 1 y 2

MISSING significa que una propiedad CRM existente de una source no figura en
el snapshot completo actual. Nunca implica borrado ni ocultado automatico.
Feeds vacios, ambiguos, invalidos o con mas de 2000 registros bloquean MISSING.
Un plan con mas de 100 detalles no prepara elegibilidad de ocultado.

El plan conserva blocked=true para UPDATE y expone solo hideMissingEligible y
hideMissingBlockCode. Existe un endpoint backend de ocultado; no hay selector nuevo.
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
actual: toda condicion se vuelve a comprobar al ocultar en subfase 2.

La subfase 2 redescarga con SSRF/DNS pinning, exige snapshot completo y
digest igual, ausencia real del externalId, owner/source/ID/revision/visibilidad
iguales, baseline y overrides actuales y ninguna reconciliacion pendiente.
Usa lock/fence de source, transaccion y recibo idempotente del run.
No borra propiedades, recursos ni relaciones.

El marcador hiddenByMissingRunId es ObjectId interno, select=false y no editable
en formularios/HTTP normal. removedFromFeedAt aporta el timestamp sin duplicarlo.
El ocultado cambia solo visiblePublicamente=false, removedFromFeedAt,
hiddenByMissingRunId y contentRevision+1 (updatedAt cambia normalmente). No toca
contenido, imagenes, fingerprints ni overrides manuales.

Republicacion: trialPlanLimits.aplicarLimitesPlanTrasTrial puede volver a poner
visiblePublicamente=true al reparar/redistribuir limites. Ahora excluye anuncios
marcados y su escritura de recuperacion exige hiddenByMissingRunId=null en Mongo:
una lectura anterior al ocultado no permite republicarlos. Las propiedades
normales conservan su recuperacion. Admin mantiene su edicion manual existente.
Reaparicion futura: solo revision/restauracion manual con cupo y plan vigentes.

## Endpoint y contrato

POST /api/crm-import/sync/hide-missing con autenticacion activa y body estricto:
{ runId, externalIds }. Entre 1 y 10 referencias unicas, sin IDs de propiedad,
fuente, precios, valores de visibilidad ni bypass del cliente. Limite de 5/hora
por IP y por usuario, presupuesto compartido de hasta 120 segundos.

Run/fuente ajenos devuelven 404. El backend verifica version/identidad de run,
vigencia, plan completo, evidencia, ausencia real en el feed redescargado y
digest identico. Revalida propietario, fuente, ID, visibilidad, revision,
baseline, hash del contenido, overrides y reconciliaciones dentro de la transaccion.

## Atomicidad, concurrencia y recibo

Se adquiere el lock CRM existente. Antes de la transaccion se persiste un intento
missingHide=preparing con operationId interno y seleccion congelada; no cambia
propiedades. Permite reconocer una respuesta perdida incluso antes del commit.
Dentro de withTransaction (snapshot/majority) se escribe la source para contender,
se revalida todo y se oculta el lote completo con filtros condicionales y
modifiedCount=1 por propiedad. El recibo completed se confirma en la misma
transaccion que los anuncios. Si falla el segundo, revierte tambien el primero.
El callback reintentable no descarga feeds ni realiza operaciones externas.

Tras rollback confirmado queda un recibo failed con resultados de fallo, no
exitos parciales. Si Mongo no confirma el commit, devuelve MISSING_UNCONFIRMED:
el recibo se marca indeterminate solo si no se habia confirmado completed.
Un fallo al guardar el estado secundario no autoriza retry; preparing sigue
bloqueado. GET /api/crm-import/sync/runs/:id recupera un recibo sanitizado sin
operationId, IDs de propiedad/source, hashes ni evidencia.

Mismo run y seleccion completed: resultado guardado, sin nuevas escrituras ni
refetch, incluso si el run ya expiro. Seleccion distinta: rechazo. Preparing,
applying, failed e indeterminate: no retry automatico; consultar y resimular.
Una propiedad ya oculta por este mismo run se reconoce solo con causa exacta,
revision esperada+1 y contenido/baseline intactos; no incrementa otra vez.
Una ocultacion ajena no se atribuye a MISSING. UPDATE/NEW iniciados o completados
bloquean MISSING; un missingHide iniciado bloquea acciones nuevas UPDATE/NEW.

## Pendientes

Subfase 3: selector/confirmacion "Ocultar anuncios", resultado inmediato y
consulta GET ante respuesta perdida, sin mezclar UPDATE/NEW. No hay UI nueva ahora.
Subfase 4: restauracion manual. Si el inmueble reaparece, la simulacion puede
clasificarlo segun sus datos, pero ni la simulacion ni UPDATE limpian el marcador
o cambian visiblePublicamente; permanece oculto. Nunca se borra automaticamente.
