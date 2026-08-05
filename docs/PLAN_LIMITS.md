# Límites de planes

La fuente única de límites de planes es `utils/planLimits.js`.

No dupliques manualmente límites de anuncios, fotografías o vigencia en rutas, HTML o scripts inline. Si una pantalla necesita mostrar límites, debe consumir el catálogo público `GET /api/planes/catalogo` o una función derivada de `utils/planLimits.js` en backend.

## Tabla definitiva

| Plan | Categoría | Anuncios | Fotos por anuncio | Vigencia | Stripe | Trial | Destino al expirar |
| --- | --- | ---: | ---: | ---: | --- | --- | --- |
| `gratis` | particular | 2 | 7 | 15 días | no | no | - |
| `basico` | particular | 3 | 10 | - | sí | no | `gratis` |
| `destacado` | particular | 4 | 15 | - | sí | no | `gratis` |
| `starter` | profesional | 15 | 20 | - | sí | no | `gratis` |
| `pro_agentes` | profesional | 40 | 30 | - | sí | no | `gratis` |
| `agencia_basica` | profesional | 50 | 40 | - | sí | no | `gratis` |
| `agencia_pro` | profesional | ilimitados | 50 | - | no | no | `gratis` |
| `vip_trial` | interno | ilimitados | ilimitadas | - | no | sí | `gratis` |
| `vip` | interno | ilimitados | ilimitadas | - | no | no | - |

## Categorías

- `particular`: planes orientados a usuarios particulares.
- `profesional`: planes orientados a agentes o agencias.
- `interno`: planes no listados comercialmente de forma pública, usados para operaciones especiales o pruebas.

## Uso en backend

Usa siempre las funciones exportadas por `utils/planLimits.js`:

- `getPlanConfig(plan)`
- `getKnownPlanIds()`
- `getStripePlanIds()`
- `getLimiteAnunciosPlan(plan)`
- `getLimiteFotosPlan(plan)`
- `planTieneLimiteFotos(plan)`
- `getDuracionAnunciosDiasPlan(plan)`
- `calcularFechaExpiracionPlan(plan, desde)`
- `getPublicPlanCatalog()`

El endpoint `GET /api/planes/catalogo` devuelve solo información pública: nombres, categorías, límites, flags de Stripe/trial y precios visibles. No expone variables de entorno, Price IDs, secretos ni datos de usuarios.

## Añadir `professional_trial` después

Cuando se implemente la promoción profesional, añade primero el plan al catálogo central con:

- identificador interno `professional_trial`;
- categoría `profesional` o `interno`, según se quiera listar;
- límites exactos de anuncios y fotos;
- `dependeDeStripe: false`;
- `esTrial: true`;
- `planDestinoAlExpirar: "gratis"` u otro destino definido.

Después adapta la activación, expiración y admin para consumir ese plan desde el catálogo. No actives la campaña ni añadas campos fiscales desde este documento: esa implementación debe ir en fases separadas.
