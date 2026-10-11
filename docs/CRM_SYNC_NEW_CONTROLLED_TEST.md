# Prueba controlada NEW CRM

URL futura tras deploy:
https://www.homeclick24.com/test-sync-new/homeclick24-sync-new-test.xml

Referencia CRM: `SYNC-NEW-TEST-001`.
Objetivo: comprobar manualmente la seleccion e importacion de un unico NEW
desde sincronizacion. Es un anuncio ficticio, sin fotos, video ni coordenadas.
Este documento no autoriza ejecutar importaciones ni desplegar los archivos.

## Procedimiento manual posterior

1. Usar una cuenta de prueba con permiso y cupo, sin este externalId importado.
2. Analizar el feed si se desea revisar sus datos, sin pulsar importar en Fase 2.
3. Configurar la URL anterior con la funcion existente Guardar fuente.
   No importar el anuncio para establecer la fuente: eso lo convertiria en
   existente y ya no permitiria comprobar NEW. No hace falta vincular un NEW.
4. Simular sincronizacion y verificar exactamente un NEW listo para importar.
5. Seleccionarlo en la seleccion NEW y pulsar Importar nuevos una sola vez,
   aceptando la confirmacion de creacion y consumo de cupo.
6. Revisar el resultado confirmado y la propiedad creada en Mis propiedades.

Si la cuenta tiene inmuebles CRM asociados a otra URL, la proteccion de identidad
rechazara el cambio. No eludirla: usar una cuenta de prueba aislada cuya fuente
pueda configurarse mediante el flujo normal. Mantener siempre esta misma URL.
Si el externalId ya existe, detener la prueba; no crear duplicados ni borrar datos
para forzar NEW. La elegibilidad real depende del run vigente y del backend.

Tras validar la prueba, preparar una limpieza limitada a la identidad real
resultante: propiedad, fuente de prueba y runs asociados. No ejecutar limpieza
sin verificar sus IDs y relaciones. Retirar despues este feed, esta nota y sus
tests temporales. No hay script de limpieza en esta preparacion.
