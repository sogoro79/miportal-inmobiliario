# CRM synchronization: Phase 3A and 3B.1A

The normal simulation only simulates. No property insert/update/delete, photo download/upload,
visibility change, quota reservation, automatic job or scheduled synchronization.
The existing selected import remains 10 properties / 100 photos / 120 seconds.

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

### Profile simulation

Profile includes a separate “Sincronización CRM — Vista previa” section. Saving
clears the typed URL; only its masked form is subsequently displayed. Simulation
shows full counters, incomplete-snapshot notice, conflicts/overrides and at most
100 details. There is no apply button or automatic job.

UNCHANGED/UPDATE/CONFLICT require a matching CRM property enabled for comparison;
legacy properties with `syncEnabled=false` intentionally remain CONFLICT.
Simulation never enrolls properties or applies feed changes. Internal tests cover
normalized equality, price differences, manual overrides and complete-snapshot
MISSING classifications without public fixtures or external service calls.

## Endpoint and history

`POST /api/crm-import/sync/simulate`, Bearer auth, strict body `{ importSourceId }`.
The source must be active and belong to `req.user.id`. Body cannot supply a URL or
owner. Existing per-user and per-IP analyze limits also protect simulation.
The hardened fetcher is reused unchanged, including DNS validation of all records,
IP pinning, Host/SNI, redirect revalidation, streaming 5 MB limit and timeouts.

ImportSyncRun records timestamps, simulation status, completeness, counters,
safe warning/error codes and the bounded, hashed plan described below.
An index on user/source/start date supports history.
No URL, XML, ciphertext or photo URLs are stored in runs. Responses contain up to
100 results and report full counters and `resultsTruncated`. Prepared responses
omit photo details and full content values. Failure logs
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
- UPDATE: managed V1 fields differ, with valid enrollment baseline; field names are shown.
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

Photo source URLs differ from saved Cloudinary URLs. The original full-fingerprint
helper remains available, but the prepared V1 plan excludes photos from change and
enrollment compatibility checks. It never asserts image-content equivalence.
Signed photo URL rotation changes the full snapshot digest and will require fresh
review before a future apply. A source-photo manifest is needed for a later phase.

## Manual content edits

Owner/admin property edit routes compare effective before/after content, use an
atomic Mongoose `$inc` for `contentRevision`, and mark individual Spanish field
names in `syncOverrides` only for CRM properties with `syncEnabled === true`.
Visits, contacts, favorites and social statistics do not change this revision.
System plan/account lifecycle operations remain untouched. Properties are never
enrolled automatically, and creation transactions/publicationVersion are unchanged.
Returning a field to CRM and revision-checked/fenced real updates are future work.

## Phase 3B.1A: explicit enrollment, not apply

`POST /api/crm-import/sync/enroll` requires Bearer auth and strict body
`{ importSourceId, externalIds }`, between 1 and 10 distinct references. No owner,
feed URL, content or frontend fingerprints are accepted. The owner is `req.user.id`.
Only own active configured sources are available (foreign/missing source: 404).
The endpoint uses the existing 10/hour per-IP AND per-user CRM limits.

Enrollment decrypts and securely downloads the source URL, requires a complete
snapshot and checks exact CRM ownership/source/reference plus normalized content.
Explicit non-photo differences, withdrawal, overrides or an invalid existing
baseline reject the whole selection with 409. No automatic baseline repair.
An absent feed field is not a request to remove the saved value. No geographic
or publication defaults are invented. Photos are excluded because saved Cloudinary
URLs cannot be compared to feed image URLs as content equivalence.

Managed V1 fields: precio, titulo, descripcion, habitaciones, banos, superficie,
garaje, piscina, terraza. The ordered fingerprint uses SHA-256, fields version 1
and normalization version 1. Undefined has an explicit absence tag, null its own
tag, empty string remains a string, and zero/false retain their numeric/boolean
types. Text is trimmed and whitespace normalized. No numeric string coercion is
performed here; the feed parser already normalizes numbers. Null is allowed only
for descripcion and superficie; invalid empty numbers, null booleans and negative
or non-integer room counts cannot enroll or produce an applicable UPDATE.

Propiedad stores `syncApplyFingerprint` and `syncApplyFingerprintVersion=1`, distinct
from existing `syncFingerprint`/`syncFingerprintVersion`. The baseline captures
all managed saved fields, including values retained when the feed omits them.
Enrollment only sets these two fields plus `syncEnabled=true`, in a MongoDB
transaction. It never changes content, contentRevision, syncOverrides, statistics
or Usuario.publicationVersion. First enrollment can update the model timestamp;
repeated identical enrollment never updates/saves Propiedad or its timestamps.
Shared source lease acquisition/release remains necessary even on this no-op path.

## Shared lease and prepared simulations

Simulation and enrollment now acquire the same ImportSource importLockToken /
importLockUntil used by Phase 2 and source configuration. There is no second lock.
Only the owning token is released. Token, identity and lease are checked before
writes; enrollment writes the same lease document inside its transaction to fence
concurrent import/configuration, rereads properties and conditionally writes
metadata by revision. Downloading happens outside the retryable transaction.

Properties with syncEnabled=false remain blocked CONFLICT / PROPERTY_SYNC_DISABLED.
Only matching, override-free properties get enrollmentEligible=true. Linked
properties require a valid managed baseline; drift never becomes an applicable
UPDATE. All overrides block the property in V1, including overrides of excluded
fields. Unsupported non-photo changes are also conflicts. No automatic clearing.
Incomplete snapshots produce blocked runs and blocked UPDATE entries, no enrollment
or MISSING. UNCHANGED never writes property metadata, timestamps or lastSeenAt.

New run states support simulated, applying, applied, blocked, failed, aborted,
alongside old running/completed/incomplete values. This phase only generates
blocked (including preparation), simulated or failed. Applying/applied are reserved.
New runs have a logical 20-minute expiresAt, with no TTL index, sourceIdentityHash,
snapshotDigest, snapshotVersion=1, normalizationVersion=1 and applyFieldsVersion=1.
The digest hashes the complete normalized feed records (including excluded fields)
in stable reference order. Only the digest, not XML or URLs, is stored.

The first 100 safe plan entries are stored, with totalResults/planTruncated for the
full snapshot. Eligible UPDATE entries store property ID, externalId, expected
content revision, expected/proposed managed fingerprints and changed field names.
Conflicts store safe reason codes, field names and blocked=true. No before/after
content, description, photo URLs or XML is stored. Future apply must reject targets
outside this stored bounded plan; it must redownload, recompute, check expiration,
source identity/versions/revision/overrides and compare to the approved run.

`GET /api/crm-import/sync/runs/:id` requires auth, only reads runs of req.user.id,
returns 404 for foreign runs and a whitelisted summary with at most 100 details.
Internal hashes/preconditions are not exposed. Legacy runs remain readable but
have no prepared plan and are treated as expired/non-applicable.

Profile displays linked / requires enrollment / blocked states and offers an
explicit enrollment button only for compatible unlinked records. It clears that
preview after enrollment and asks for a fresh simulation. There is no apply button.

**Apply does not exist yet.** No NEW creation, MISSING hiding/removal, photo changes,
Cloudinary calls, quota changes, worker or cron are introduced by this phase.
Normal/admin editing still uses existing save + contentRevision increments. Before
3B.1B, optimistic concurrency for manual saves and future transactional apply must
be addressed: the source lease does not serialize manual edits. A simulation plan
is a set of preconditions, not a permission to ignore later changes.
