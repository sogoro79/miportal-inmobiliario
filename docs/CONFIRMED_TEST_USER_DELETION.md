# Eliminacion controlada de cuentas ficticias confirmadas

Esta herramienta elimina definitivamente cinco cuentas ficticias confirmadas y sus datos de prueba asociados, siempre mediante una ejecucion manual, transaccional y con confirmacion exacta.

No se ejecuta automaticamente, no se integra con `server.js`, no inicia schedulers y no anade procesos en segundo plano.

## Cuentas autorizadas

Las unicas cuentas que puede seleccionar son:

- `sonygr@gmail.com`
- `sogoro0705@gmail.com`
- `sogoro79@gmail.com`
- `elpuertoingles@gmail.com`
- `pujesoca@gmail.com`

La lista debe recibirse exactamente en `TARGET_TEST_EMAILS`. La herramienta rechaza cuentas adicionales, cuentas ausentes, duplicados, emails invalidos y cualquier intento de incluir la cuenta administradora protegida.

## Administrador protegido

La cuenta protegida es:

- `sogoro.portal@gmail.com`

Debe configurarse exactamente como:

```bash
PROTECTED_ADMIN_EMAIL=sogoro.portal@gmail.com
```

La herramienta exige que exista, este activa y tenga `role:"admin"`. No la modifica, no la elimina y verifica que siga intacta tras una aplicacion real.

## Activacion

Variables obligatorias:

```bash
DELETE_CONFIRMED_TEST_USERS=true
MONGODB_URI=...
TARGET_TEST_EMAILS=sonygr@gmail.com,sogoro0705@gmail.com,sogoro79@gmail.com,elpuertoingles@gmail.com,pujesoca@gmail.com
PROTECTED_ADMIN_EMAIL=sogoro.portal@gmail.com
```

Solo el valor exacto `true` activa la herramienta. Valores como `TRUE`, `1`, `yes`, `false` o cadena vacia no sirven.

El CLI rechaza argumentos adicionales.

## Dry-run por defecto

Sin confirmacion de aplicacion, la herramienta solo lee y devuelve conteos y booleanos:

- `usuariosEsperados`
- `usuariosEncontrados`
- `usuariosDesactivados`
- `usuariosActivos`
- `usuariosConRoleUser`
- `usuariosConRoleAdminHistorico`
- `propiedadesAsociadas`
- `conversacionesAutorizadas`
- `conversacionesConAdminProtegido`
- `conversacionesConUsuariosExternos`
- `mensajesAutorizados`
- `alertasPropias`
- `notificacionesPropias`
- `eliminacionPermitida`
- `motivosBloqueo`
- `aplicariaCambios:false`

No imprime emails, nombres, IDs de MongoDB, textos de mensajes, documentos, datos Stripe, URLs ni `public_id` de Cloudinary.

## Confirmacion de aplicacion

Para escribir exige ademas:

```bash
APPLY_CONFIRMED_TEST_USER_DELETION=true
CONFIRM_CONFIRMED_TEST_USER_DELETION=DELETE_FIVE_CONFIRMED_TEST_USERS_AND_TEST_DATA
```

La funcion principal tambien exige internamente:

- `apply === true`
- `confirm === "DELETE_FIVE_CONFIRMED_TEST_USERS_AND_TEST_DATA"`

Importar la funcion directamente no evita estas barreras.

## Condiciones de bloqueo

La eliminacion se bloquea si:

- falta alguna de las cinco cuentas;
- alguna esta activa;
- alguna tiene propiedades;
- alguna conserva `stripeCustomerId` o `stripeSubscriptionId`;
- alguna conserva cambios de plan pendientes;
- aparece una conversacion con usuarios externos reales;
- la cuenta protegida no existe, no esta activa o no tiene `role:"admin"`;
- cambia cualquier condicion entre el dry-run y la aplicacion.

Una cuenta ficticia con `role:"admin"` historico no bloquea por si sola si esta en la lista exacta autorizada, esta desactivada, no es la cuenta protegida y no tiene Stripe, propiedades ni relaciones externas.

## Datos que elimina

Dentro de una unica transaccion MongoDB:

1. Revalida las cinco cuentas.
2. Revalida que siguen desactivadas, sin propiedades, sin Stripe y sin cambios pendientes.
3. Revalida las conversaciones.
4. Elimina mensajes de conversaciones autorizadas.
5. Elimina esas conversaciones.
6. Elimina alertas propias.
7. Elimina notificaciones propias.
8. Elimina las cinco cuentas con filtros condicionales estrictos.
9. Verifica que la cuenta protegida sigue activa y con `role:"admin"`.

Si falla cualquier paso, la transaccion debe hacer rollback completo.

## Datos que preserva

No modifica ni elimina:

- `sogoro.portal@gmail.com`;
- propiedades;
- imagenes;
- recursos Cloudinary;
- datos Stripe remotos;
- usuarios reales;
- conversaciones con usuarios reales;
- backups;
- configuracion;
- credenciales;
- planes del administrador protegido.

## Cloudinary y Stripe

La herramienta no importa Cloudinary ni Stripe. Tampoco llama a APIs remotas de esos servicios.

Las antiguas imagenes de prueba deben estar retiradas antes de usar esta herramienta; esta eliminacion no intenta limpiar assets.

## Idempotencia

Si una segunda ejecucion encuentra que las cinco cuentas ya no existen, termina de forma segura, informa el estado y no toca ningun otro dato.

## Verificacion posterior

Tras aplicar comprueba mediante conteos y booleanos:

- las cinco cuentas ya no existen;
- sus conversaciones autorizadas ya no existen;
- sus mensajes ya no existen;
- sus alertas y notificaciones ya no existen;
- no se eliminaron propiedades;
- la cuenta administradora protegida sigue activa;
- `aplicoCambios:true`;
- `verificacionCorrecta:true`.
