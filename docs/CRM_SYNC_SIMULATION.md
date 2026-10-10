# CRM synchronization: Phase 3A

The normal simulation only simulates. No property insert/update/delete, photo download/upload,
visibility change, quota reservation, automatic job or scheduled synchronization.
The existing selected import remains 10 properties / 100 photos / 120 seconds.
The separately gated second test below can explicitly enroll four test properties
by updating comparison metadata only; it never applies feed changes.

## Source configuration

`PUT /api/crm-import/sync/source`, Bearer auth, strict body `{ feedUrl }`, configures
only `req.user.id`'s single source. URL syntax, protocols, credentials and all DNS
addresses are validated using the existing SSRF policy before persistence; no HTTP
download takes place. Simulation revalidates DNS and pins the actual connection.
The endpoint encrypts the URL and atomically creates/updates the existing source,
keeping `syncEnabled=false`. Configuration acquires the same token/lease lock as
Phase 2 before checking CRM associations. A different hash with linked properties
returns `SYNC_SOURCE_URL_MISMATCH` without changing identity/ciphertext/settings.
The original URL can be encrypted; sources without linked properties can explicitly
change URL. Updates require the owned, unexpired lock and cleanup releases only
that token, on success or error. A live Phase 2 import lock prevents configuration;
the unique user index prevents a second source during concurrent requests.
Phase 2 acquires its lock only if the source still has the analyzed feed hash,
closing the read/configure/lock race before any image download or property write.
The existing 10/hour per-user AND per-IP analyze limits also protect configuration.
No property enrollment or property write occurs in source configuration.

`GET /api/crm-import/sync/source` only reads the authenticated user's source.
It returns own `importSourceId`, configured flag, masked URL and safe status/date,
never plaintext, ciphertext, hash, key/version or foreign IDs. Legacy sources can
be explicitly configured; deleting imported properties does not delete the source.
Changing the configured URL is only allowed without linked CRM properties; otherwise
use the original URL or a separate authorized test account (not a second source).
Existing properties and import timestamps are retained. GET status describes source metadata; simulation
history continues to live in ImportSyncRun and does not update source success dates.

- `CRM_FEED_URL_KEY_VERSION`: active numeric key version (default `1`).
- `CRM_FEED_URL_KEY_V1`: dedicated random 32-byte key, base64 encoded.
- Rotation uses `CRM_FEED_URL_KEY_V2`, etc. Keep old keys while their ciphertexts
  exist. Do not use JWT/Stripe/Cloudinary secrets, or commit keys to the repository.
- AES-256-GCM: random 12-byte IV, 16-byte authentication tag, purpose/version AAD.
- Only ciphertext, version, URL hash and masked URL are persisted. The hash is
  checked after decryption. Ciphertext is excluded from ordinary Mongoose reads.
- `syncEnabled` defaults to false on source and properties. Explicit simulation
  is permitted without enabling any future automatic synchronization.

### Render configuration (do not commit the values)

Set `CRM_FEED_URL_KEY_VERSION=1` and `CRM_FEED_URL_KEY_V1` to 32 random bytes encoded
as canonical Base64 (44 characters, normally ending in `=`). To generate locally:

```sh
openssl rand -base64 32
```

This command is documentation only; it was not executed. Transfer the output only
to Render's secret environment variable, never Git, frontend, logs or API responses.
Without the key the app still starts; configuration/simulation returns a controlled
409 and manual Phase 2 remains available. No environment changes in this task.

### Controlled temporary feed and scenarios

Profile includes a separate “Sincronización CRM — Vista previa” section. Saving
clears the typed URL; only its masked form is subsequently displayed. Simulation
shows full counters, incomplete-snapshot notice, conflicts/overrides and at most
100 details. There is no apply button or automatic job.

Temporary public resource (remove after the controlled test):
`https://www.homeclick24.com/test-sync/homeclick24-sync-simulation.xml`.
Four fictional `SYNC-DEMO-001..004` records, sale/rent, valid statuses and zero photos.
It is not added to sitemap and nothing imports it automatically.
With no matching stored references it yields four NEW simulation entries only.
Public data contains no customer information, credentials, coordinates or images.

UNCHANGED/UPDATE/CONFLICT need an explicitly enrolled, matching CRM property;
legacy properties with `syncEnabled=false` intentionally remain CONFLICT. The
normal simulation does not enroll or edit them. Those scenarios are covered with internal mocks:
equal normalized data -> UNCHANGED; different price -> UPDATE; manual price override
-> CONFLICT; absent reference in a complete snapshot -> MISSING. To exercise those
scenarios in production needs separate authorization and suitable test data;
never alter MongoDB manually. The second controlled procedure below uses normal
Phase 2 import only in the authorized test account, not real customer accounts.

## Endpoint and history

`POST /api/crm-import/sync/simulate`, Bearer auth, strict body `{ importSourceId }`.
The source must be active and belong to `req.user.id`. Body cannot supply a URL or
owner. Existing per-user and per-IP analyze limits also protect simulation.
The hardened fetcher is reused unchanged, including DNS validation of all records,
IP pinning, Host/SNI, redirect revalidation, streaming 5 MB limit and timeouts.

ImportSyncRun records only timestamps, simulation status, completeness, counters,
safe warning/error codes. An index on user/source/start date supports history.
No URL, XML, ciphertext or photo URLs are stored in runs. Responses contain up to
100 results and report full counters and `resultsTruncated`. Photos are represented
by count/hash; links embedded in other response text are redacted. Failure logs
contain only allowlisted codes, not arbitrary error messages or URLs.
Runs before URL validation are not created; a fetch/parser failure records a failed
run where MongoDB permits it. A persistence outage can prevent recording a run.

## Complete snapshot

Maximum 2,000 properties, within the existing 5 MB XML ceiling. This bounds CPU,
comparison and response memory while exceeding the 500-property preview limit.
The parser observes one additional record to detect overflow; it never calls the
truncated preview parser. Declared malformed records are retained as INVALID.
Empty/unrecognized feeds, malformed/duplicate references, pagination signals,
advertised totals greater than observed records, nesting beyond 64, or overflow
produce an incomplete snapshot. No MISSING decision is allowed in these cases.
XML syntax errors, DOCTYPE and ENTITY declarations abort the run entirely.
This generic adapter cannot prove a provider has not silently omitted upstream
data; future automatic removals need additional safeguards (not part of 3A).

## Normalization, fingerprint and comparison

The sync normalizer keeps omitted keys distinct from empty strings, zero, false
and null. Invalid supplied values get fixed field/error codes, not creation defaults.
The generic XML aliases are explicit. No default property type, price, condition,
operation or commercial status is invented.
SHA-256 fingerprint version 1 uses a deterministic ordered field list and ordered
photo list. Absence and null are different. A matching fingerprint is only a hint:
actual field differences and manual protections always take precedence.

- UNCHANGED: supplied normalized fields equal persisted fields.
- UPDATE: non-protected, non-identity fields differ; old/new values are shown.
- NEW: unknown stable reference, summary and publication-data validity; no quota
  is reserved. Missing required creation fields mean not publishable.
- MISSING: stored CRM reference absent from a complete snapshot only; no hiding.
- CONFLICT: manual override, disabled/legacy property, ambiguous identity,
  suspicious reference reuse, locality/province/operation/type change or withdrawal.
- INVALID: malformed references, duplicate feed references or unsupported values.

Commercial status mapping:

| Feed status | Interpretation |
| --- | --- |
| available / active / disponible | Disponible |
| reserved / reservado | Reservado |
| sold / vendido | Vendido |
| rented / alquilado | Alquilado |
| withdrawn / inactive / deleted | CRM withdrawal; review conflict only |
| unknown / explicit empty or null | INVALID, never Disponible |

Photo source URLs differ from saved Cloudinary URLs: an explicitly enrolled
property may show a photo UPDATE even for the same visual image. Version 1 does
not assert image-content equivalence or establish baselines by writing properties.
Signed photo URL rotation also changes the fingerprint. Neither can cause a real
update in 3A; a source-photo baseline is needed before implementing real photo sync.

## Second controlled test: temporary enrollment and v2

Disabled by default. Only for the existing authorized SYNC-DEMO test account:
`CRM_SYNC_TEST_ENABLED=true` and `CRM_SYNC_TEST_USER_ID=<its exact 24-character id>`.
Do not set a real customer's ID. No environment variables or live accounts were
changed while preparing this code. Remove both variables and these temporary
endpoints/UI/feed resources after validation; do not use this for general enrollment.

Temporary authenticated routes, strict body `{ importSourceId }`:
- `POST /api/crm-import/sync/test/enroll`
- `POST /api/crm-import/sync/test/simulate-v2`

The profile reveals the two test controls only to that account when enabled. The
server independently enforces the gate, ownership, active generic source, automatic
sync disabled, and exact encrypted v1 URL:
`https://www.homeclick24.com/test-sync/homeclick24-sync-simulation.xml`.
There is no arbitrary feed URL override, second source, scheduler or apply endpoint.
Configuring v2 through PUT remains forbidden with linked CRM properties.

Procedure after separately authorized deployment/environment configuration:
1. Keep the test source on v1. Analyze/import 001..004 using normal Phase 2 UI.
   All four records now have importable status/type/condition; no photos, uploads
   or coordinates. Existing real import policies remain unchanged.
2. Confirm four successful imports, same importSourceId, stable externalIds and
   `source=crm`. Initially schema default `syncEnabled=false` remains untouched.
   A normal baseline simulation should show four PROPERTY_SYNC_DISABLED conflicts.
3. Press “Vincular cuatro anuncios de prueba” and explicitly confirm. It rejects
   extra/missing/duplicate records, foreign ownership, different feed, existing
   overrides, already-enrolled rows or content different from normalized v1.
   Under the same Phase 2 source lock, one MongoDB transaction sets ONLY each
   property's syncEnabled=true, fingerprint and fingerprint version. Source
   syncEnabled remains false. No content, revision, quotas or visibility change.
   This flag permits comparison/manual override tracking, not automatic sync.
   Downloads are outside the retryable callback; failures abort all four updates.
4. Normal v1 simulation now shows four UNCHANGED. From the normal owner edit form,
   edit ONLY description of SYNC-DEMO-003 to a distinct sentence; save it once.
   The existing route/helper records only syncOverrides.descripcion=true and
   increments contentRevision. No direct MongoDB edit, no test endpoint for overrides.
5. Press “Simular escenario v2”. The temporary wrapper fetches the fixed sibling
   XML through the hardened fetcher, without changing v1's stored URL/hash/source.
   001 is identical; 002 price is 1750 instead of 1650; 003 description differs from
   both baseline and manual text; 004 is absent; 005 is new. Zero images in both.

Expected v2: Encontrados=4 (current snapshot), UNCHANGED=1, UPDATE=1, NEW=1,
MISSING=1, CONFLICT=1, INVALID=0. There are FIVE details: MISSING refers to a stored
property not in the four-record snapshot. 003's description change has
blockedByOverride=true. 004 stays visible/unchanged and 005 is never created.
Baseline/diff, real Phase 2 code with mocks, and the normal manual-edit helper
are tested locally; no production import/enrollment/manual edit was executed.

Public v2 resource:
`https://www.homeclick24.com/test-sync/homeclick24-sync-simulation-v2.xml`.
Do NOT import v2. Test controls do not automatically import anything. Repeating
enrollment after editing is deliberately rejected to protect overrides/baselines.

## Manual content edits

Owner/admin property edit routes compare effective before/after content, use an
atomic Mongoose `$inc` for `contentRevision`, and mark individual Spanish field
names in `syncOverrides` only for CRM properties with `syncEnabled === true`.
Visits, contacts, favorites and social statistics do not change this revision.
System plan/account lifecycle operations remain untouched. Properties are never
enrolled automatically, and creation transactions/publicationVersion are unchanged.
Returning a field to CRM and revision-checked/fenced real updates are future work.
