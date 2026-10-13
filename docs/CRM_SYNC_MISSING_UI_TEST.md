# Prueba temporal de UI MISSING CRM: BASE

URL futura, solo disponible cuando se autorice y complete el despliegue:
https://www.homeclick24.com/test-sync-missing-ui/homeclick24-missing-ui.xml

Referencia única: SYNC-MISSING-UI-001.
Título: Piso prueba UI MISSING en Rota.
Venta, 219.000 EUR, piso de segunda mano, 2 habitaciones, 1 baño,
80 m2, terraza. Dirección y descripción ficticias. Sin fotos ni vídeo.

Este commit prepara SOLO el BASE. Mientras el feed incluya este inmueble,
no debe producir MISSING para él. La comprobación de checkbox, contador,
botón y confirmación de ocultado queda para un paso posterior autorizado.

## Preparación manual posterior en la cuenta de Alberto

1. Comprobar que la cuenta tiene cupo para un anuncio y que no hay otra
   fuente vinculada a propiedades ajenas a esta prueba. Si la protección
   de identidad rechaza esta URL, detenerse: no saltarla ni usar otra cuenta.
2. En /perfil, Importar desde CRM, introducir la URL exacta y pulsar
   Analizar feed. Verificar que aparece únicamente SYNC-MISSING-UI-001
   y que no hay imágenes.
3. Seleccionar solo SYNC-MISSING-UI-001 y pulsar Importar seleccionados
   una sola vez, confirmando la importación. Comprobar su resultado.
   Ante respuesta incierta, detenerse y consultar estado; no repetir.
4. En Sincronización CRM — Vista previa, guardar exactamente la misma URL
   como fuente. No usar otra ruta ni cambiar la identidad de la source.
5. Pulsar Simular sincronización.
6. Si aparece Requiere vinculación, pulsar Vincular anuncio exclusivamente
   para SYNC-MISSING-UI-001. No editar sus datos.
7. Volver a simular y verificar UNCHANGED · Vinculado para esa referencia.
   Si no coincide, detenerse para diagnosticar. Esta fase termina aquí.

## Qué NO hacer

- No pulsar Ocultar anuncios, ni confirmar ningún ocultado real.
- No pulsar Aplicar cambios ni Importar nuevos.
- No importar otros anuncios ni volver a importar esta referencia.
- No editar el anuncio, cambiar el feed o sustituir la URL configurada.
- No ejecutar comandos directos contra MongoDB ni Cloudinary.

Todavía no se prepara ningún contenido MISSING ni registro de control.
El cambio posterior de contenido requerirá autorización y mantendrá la
misma URL. También se autorizará por separado la retirada final de los
datos y archivos temporales. No se añade ningún endpoint, flag o bypass.
