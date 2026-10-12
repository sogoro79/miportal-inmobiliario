# Prueba temporal backend MISSING CRM

Preparacion local solamente: no autoriza despliegue ni operaciones reales.
Objetivo: ocultar una unica propiedad ficticia sin borrarla ni alterar contenido.

## Identidades y feeds

- Objetivo: SYNC-MISSING-TEST-001, Piso de prueba MISSING CRM en Rota.
- Venta, 214000, piso, segunda_mano, 3 habitaciones, 2 banos, 88 m2.
- Rota, Cadiz, Direccion de prueba MISSING, terraza si, garaje/piscina no.
- Sin fotos, video, coordenadas ni datos personales.
- BASE: https://www.homeclick24.com/test-sync-missing/homeclick24-missing-base.xml
- MISSING: https://www.homeclick24.com/test-sync-missing/homeclick24-missing-empty.xml

El segundo fichero NO esta literalmente vacio, pese a su nombre: contiene solo
SYNC-MISSING-CONTROL-001, registro ficticio sin fotos que NO debe importarse.
Un XML <properties/> queda incompleto en el parser actual y bloquea MISSING.
El registro distinto mantiene snapshotComplete=true dejando ausente el objetivo.
La simulacion esperada es 1 MISSING objetivo + 1 NEW control, cero invalidos.

## Orden manual posterior, con autorizaciones separadas

1. Usar cuenta de prueba aislada y activa, con permiso/cupo, sin otras propiedades
   CRM ni fuente vinculada a otra URL. Guardar sus IDs reales para verificacion.
2. Analizar BASE e importar SOLO SYNC-MISSING-TEST-001 por Fase 2. No importar CONTROL.
3. Configurar la misma URL BASE en sincronizacion y vincular/enrollar ese objetivo
   mediante el flujo normal. Simular BASE: debe dar UNCHANGED y Vinculado.
4. Guardar ID de propiedad, source y revision actuales; verificar contenido y
   imagenes=[] mediante lectura privada antes de continuar.
5. NO cambiar la source a la URL MISSING: su hash seria diferente y la proteccion
   de identidad rechazaria el cambio. NO debilitarla ni crear otra source.
6. Pedir autorizacion para un commit/deploy posterior que cambie SOLO el contenido
   de homeclick24-missing-base.xml por el contenido del XML MISSING, conservando
   ruta, nombre y URL configurada. Este paso no se ejecuta en esta preparacion.
   Mantener baseline original en un fixture interno si sus tests lo necesitan.
7. Tras ese deploy autorizado, verificar la URL BASE: debe contener CONTROL y no
   el objetivo. Simular otra vez contra la source BASE. GET del run debe mostrar
   snapshotComplete=true, plan no truncado y la entrada objetivo:
   type=MISSING, hideMissingEligible=true, hideMissingBlockCode=null.
8. NO pulsar Aplicar cambios, Importar nuevos ni ningun boton para CONTROL.
   No hay UI de ocultado en esta fase. Con el runId recien obtenido, hacer UNA
   solicitud manual autenticada al backend, solo tras confirmacion humana:

```http
POST /api/crm-import/sync/hide-missing
Authorization: Bearer <TOKEN_SESION_CUENTA_PRUEBA>
Content-Type: application/json

{"runId":"<RUN_ID_MISSING>","externalIds":["SYNC-MISSING-TEST-001"]}
```

No compartir/imprimir el token ni usar credenciales del administrador principal.
No se proporciona un automatismo que aplique cambios en produccion.

9. Esperar completed, countHidden=1, countAlreadyHidden=0, resultado hidden.
   Ante fallo/timeout/503 consultar GET /api/crm-import/sync/runs/<RUN_ID_MISSING>;
   nunca asumir rollback ni repetir automaticamente.
10. Verificar que sigue en Mis propiedades con el mismo _id. La ficha publica
    debe quedar inaccesible. Comparar con la lectura previa: contenido e imagenes
    identicos, visiblePublicamente=false, removedFromFeedAt con fecha,
    hiddenByMissingRunId=<RUN_ID_MISSING> y contentRevision exactamente +1.
11. Con resultado confirmed completed, repetir manualmente el MISMO POST y
    seleccion una vez para comprobar idempotencia: recibo igual, revision y
    timestamps de propiedad sin nuevos cambios. GET run debe recuperar el recibo
    sin evidencia interna. No cambiar seleccion ni usar run expirado para iniciar.

El marcador es privado/select=false: para verificarlo usar lectura privilegiada
explicita en Render Shell, no esperar que aparezca en payloads publicos. Un
comando de lectura posterior (no ejecutar ahora) desde la raiz del proyecto:

```sh
node --input-type=module <<'NODE'
import "dotenv/config";
import mongoose from "mongoose";
mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);
try {
  const { default: Propiedad } = await import("./models/Propiedad.js");
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, autoCreate: false });
  const p = await Propiedad.findOne({ _id: "<PROPERTY_ID>", usuarioId: "<USER_ID>",
    importSourceId: "<SOURCE_ID>", source: "crm", externalId: "SYNC-MISSING-TEST-001" })
    .select("titulo descripcion precio tipoOperacion tipoInmueble estado habitaciones banos superficie " +
      "direccion localidad provincia terraza garaje piscina imagenes visiblePublicamente removedFromFeedAt " +
      "contentRevision +hiddenByMissingRunId").lean();
  console.log(JSON.stringify(p ? { existe: true, ...p } : { existe: false }, null, 2));
} catch { console.error("Lectura fallida; sin detalles de conexion."); }
finally { await mongoose.disconnect(); }
NODE
```

## Limpieza posterior

No hay cleanup preparado todavia. Tras conocer IDs/resultados reales, disenar
dry-run de limpieza exclusivo de propiedad objetivo, source BASE, runs y recibos
dedicados. No borrar usuarios/planes/chats/favoritos ni recursos ajenos; abortar
ante relaciones ambiguas. CONTROL no debe existir como propiedad. Retirar luego
ambos XML, esta nota y tests exclusivamente temporales; conservar la cobertura
generica de concurrencia. No automatizar restauracion ni borrado en esta prueba.

## Alcance de los tests

Parser/mapper y servicios reales de simulacion/ocultado/UPDATE/NEW/Fase 2, rutas
Express y autenticacion: persistencia inyectada y simulada, sin MongoDB ni
Cloudinary reales. La coordinacion se prueba compartiendo source/run y dejando
competir ambos servicios, con ambos ordenes de llegada. No hay infraestructura
de replica set ni mongodb-memory-server en el repo: no se instala una dependencia
grande. Los tests no prueban WriteConflict ni commit del driver sobre Mongo real.
