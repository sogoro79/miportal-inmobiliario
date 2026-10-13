# Prueba temporal de UI MISSING CRM: escenario MISSING

URL estable, sin cambio de ruta ni identidad de source:
https://www.homeclick24.com/test-sync-missing-ui/homeclick24-missing-ui.xml

## Estado previo confirmado

Alberto ya importó y vinculó SYNC-MISSING-UI-001:
Piso prueba UI MISSING en Rota, 219.000 EUR, 2 habitaciones,
1 baño, 80 m2 y terraza. La simulación BASE mostró UNCHANGED · Vinculado.
No repetir esa preparación ni volver a importar el anuncio.

## Contenido del feed tras este despliegue autorizado

El mismo archivo contiene únicamente SYNC-MISSING-UI-CONTROL-001:
Control prueba UI MISSING, venta, 225.000 EUR, Rota, piso de segunda mano,
1 habitación, 1 baño, 60 m2. Datos ficticios, sin fotos ni vídeo.
El registro original ya no aparece. El control mantiene un snapshot completo.
NO importar CONTROL.

## Siguiente paso: SOLO simulación y comprobación visual

1. Esperar a que se autorice y complete el despliegue de este cambio.
2. Entrar en /perfil con Alberto. Mantener la source configurada exactamente
   con la URL anterior; no guardarla de nuevo ni cambiarla por otra URL.
3. Pulsar Simular sincronización para generar un run nuevo.
4. Comprobar SYNC-MISSING-UI-CONTROL-001 como NEW.
5. Comprobar SYNC-MISSING-UI-001 como MISSING, con texto indicando que ya
   no aparece en el feed, Listo para ocultar y checkbox seleccionable.
   Elegibilidad esperada: hideMissingEligible=true, hideMissingBlockCode=null.
6. Comprobar el contador independiente 0 anuncios seleccionados / 10
   y el botón Ocultar anuncios inicialmente deshabilitado.
7. Se puede marcar únicamente el MISSING original para comprobar que el
   contador pasa a 1 y el botón se habilita. Desmarcarlo al terminar.
8. Detenerse aquí. Si falta elegibilidad, diagnosticar sin forzar ningún flag.

## Qué NO hacer

- No pulsar Ocultar anuncios ni confirmar ocultado: requiere otra autorización.
- No pulsar Importar nuevos, Importar seleccionados ni Aplicar cambios.
- No importar CONTROL ni otros inmuebles.
- No editar el anuncio ni modificar su vinculación/baseline.
- No cambiar la URL de source, hacer escrituras directas en MongoDB o llamar Cloudinary.

Simular no modifica anuncios. Este commit no ejecuta acciones en producción
ni añade endpoints, flags o bypasses. La retirada final de datos y archivos
temporales se preparará después y requerirá autorización independiente.
