# Prueba temporal de UI REAPPEARED

Datos ficticios exclusivos para una prueba autorizada con Alberto. No son un
anuncio real. Este commit prepara solo BASE: no importa, oculta ni vuelve a
publicar, no conecta a MongoDB ni Cloudinary y no despliega ni hace push.

- Archivo: `public/test-sync-reappeared-ui/homeclick24-reappeared-ui.xml`
- URL estable: `https://www.homeclick24.com/test-sync-reappeared-ui/homeclick24-reappeared-ui.xml`
- Target: `SYNC-REAPPEARED-UI-001`
- Control posterior: `SYNC-REAPPEARED-UI-CONTROL-001` (no incluido en BASE).

## Precondiciones

Usar únicamente la cuenta de prueba autorizada Alberto, con plan vigente y
cupo. Confirmar que no tiene una fuente distinta con anuncios vinculados:
si existe, detenerse, no reemplazar su identidad ni saltar la protección de
fuente. No cambiar planes, usuarios ni configuración de pagos para esta prueba.

Mantener la misma URL y archivo durante todo el ciclo. Cada cambio del feed y
push/deploy posterior requiere autorización independiente. Anotar los IDs
reales de propiedad, fuente y runs y los receipts seguros; no copiar tokens,
claves, ciphertext ni evidencia privada. No editar manualmente ningún campo
del target, incluidos precio, descripción, imágenes y fechas.

## Fase A: BASE

1. Desplegar el feed solo cuando se autorice y verificar la URL pública.
2. Entrar con Alberto en su perfil.
3. Guardar/usar la URL estable como fuente CRM; sync automática sigue desactivada.
4. Analizar esa misma URL en el importador de Fase 2.
5. Importar **solo** `SYNC-REAPPEARED-UI-001` una vez. Debe tener precio 231000,
   venta, piso, segunda_mano, Rota/Cádiz, CP 11520, 2 habitaciones, 1 baño,
   82 m² y 0 fotos. La dirección es ficticia; no inventar coordenadas.
6. Simular. Si pide vinculación, usar Vincular anuncio y volver a simular hasta
   obtener `UNCHANGED · Vinculado`. Anotar el ID original del anuncio.

Esta primera preparación termina aquí. No pulsar Ocultar anuncios ni Volver a
publicar todavía. La ausencia de fotos puede generar un warning informativo.

## Fase B: MISSING

7. En una tarea posterior autorizada, sustituir el contenido del **mismo archivo**
   por este único control. No cambiar la URL ni configurar otra fuente:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<properties>
  <property>
    <externalId>SYNC-REAPPEARED-UI-CONTROL-001</externalId>
    <title>Control prueba REAPPEARED</title>
    <description>Registro de control temporal para prueba REAPPEARED CRM.</description>
    <operation>venta</operation>
    <price>226000</price>
    <address>Dirección de control REAPPEARED</address>
    <city>Rota</city>
    <province>Cádiz</province>
    <postalCode>11520</postalCode>
    <propertyType>piso</propertyType>
    <condition>used</condition>
    <commercialStatus>available</commercialStatus>
    <bedrooms>1</bedrooms>
    <bathrooms>1</bathrooms>
    <surface>61</surface>
    <garage>false</garage>
    <pool>false</pool>
    <terrace>false</terrace>
  </property>
</properties>
```

8. Validar snapshot completo y desplegar el cambio cuando se autorice.
9. Simular con la misma fuente.
10. Verificar control `NEW` y target `MISSING`, con `hideMissingEligible=true`
    y `hideMissingBlockCode=null`. Si hay un bloqueo, detenerse y diagnosticar.
11. Seleccionar únicamente el MISSING target. **Nunca importar el control NEW.**
12. Solo con autorización del ocultado real, confirmar Ocultar anuncios.
13. Comprobar receipt completed, 1 ocultado y 0 ya ocultos; el mismo anuncio
    sigue en Mis propiedades y desaparece de listados/ficha públicos. No borrarlo.

## Fase C: REAPPEARED

14. En una tarea posterior autorizada, reintroducir el target en el mismo archivo,
    recuperando exactamente el bloque BASE de este commit, no reconstruyéndolo
    de memoria. Consultarlo con `git show <COMMIT_BASE>:public/test-sync-reappeared-ui/homeclick24-reappeared-ui.xml`.
    Mantener todos sus campos, incluidos booleans, dirección y estado. Se puede
    conservar además el control, sin importarlo. No editar la propiedad local.
15. Validar y desplegar cuando se autorice, manteniendo la identidad de fuente.
16. Simular de nuevo para obtener un run vigente.
17. Verificar target `REAPPEARED`, `restoreEligible=true`, `restoreBlockCode=null`,
    "Este anuncio ha vuelto a aparecer en tu CRM." y "Listo para volver a publicar".
    Si aparece CONTENT_CHANGED, falta cupo o el anuncio/plan ha caducado, detenerse:
    no editar datos ni borrar marcadores para forzar elegibilidad.
18. Seleccionar únicamente el target REAPPEARED.
19. Pulsar Volver a publicar solo cuando se autorice esa operación real.
20. Revisar y aceptar la confirmación de publicación y consumo de cupo.
21. Comprobar "Publicación completada.", target "Publicado", 1 publicado y
    0 ya publicados; vuelve al listado público con el **mismo ID original** y sin
    duplicados. Contenido y fotos siguen intactos. Si el resultado es incierto,
    no repetir POST: usar Consultar estado (solo GET) hasta confirmar el receipt.

## Fase D: cleanup posterior

22. Tras confirmar la prueba, revisar que la eliminación desde Mis propiedades
    es segura para este anuncio ficticio y eliminarlo manualmente solo con
    autorización. Comprobar que ya no existe; no borrar otras propiedades.
23. Preparar entonces un script específico (no existe en esta tarea) para los
    restos de esta fuente/usuario y ambos externalIds: ImportSyncRun, receipts
    embebidos, ImportReconciliation inequívocas e ImportSource temporal.
    Debe detectar referencias históricas y hiddenByMissingRunId, abortar ante
    datos ajenos/ambiguos y no tocar usuarios, planes, chats o Cloudinary.
24. Ejecutar primero su dry-run y revisar IDs, conteos y planHash.
25. Apply solo con autorización, confirmación exacta y hash, revalidando en
    transacción. No inventar ahora comandos para una herramienta aún inexistente.
26. Repetir dry-run y exigir `YA LIMPIO` y verificación posterior correcta.
27. Retirar feed, esta nota y tests temporales del repositorio en otra tarea,
    conservando toda la funcionalidad productiva REAPPEARED/MISSING/NEW/UPDATE.
