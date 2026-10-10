# CRM synchronization: Phase 3A

This phase only simulates. No property insert/update/delete, photo download/upload,
visibility change, quota reservation, automatic job or scheduled synchronization.
The existing selected import remains 10 properties / 100 photos / 120 seconds.

## Source configuration

`encryptFeedUrl(url, env)` returns configuration fields; it does NOT persist them.
An authorized, separately approved configuration operation must associate those
fields with the existing user's ImportSource. Phase 3A does not add an enrollment
UI/endpoint or silently save URLs during Phase 2. Legacy sources remain usable for
manual import and return `SYNC_SOURCE_NOT_CONFIGURED` for simulation.

- `CRM_FEED_URL_KEY_VERSION`: active numeric key version (default `1`).
- `CRM_FEED_URL_KEY_V1`: dedicated random 32-byte key, base64 encoded.
- Rotation uses `CRM_FEED_URL_KEY_V2`, etc. Keep old keys while their ciphertexts
  exist. Do not use JWT/Stripe/Cloudinary secrets, or commit keys to the repository.
- AES-256-GCM: random 12-byte IV, 16-byte authentication tag, purpose/version AAD.
- Only ciphertext, version, URL hash and masked URL are persisted. The hash is
  checked after decryption. Ciphertext is excluded from ordinary Mongoose reads.
- `syncEnabled` defaults to false on source and properties. Explicit simulation
  is permitted without enabling any future automatic synchronization.

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

## Manual content edits

Owner/admin property edit routes compare effective before/after content, use an
atomic Mongoose `$inc` for `contentRevision`, and mark individual Spanish field
names in `syncOverrides` only for CRM properties with `syncEnabled === true`.
Visits, contacts, favorites and social statistics do not change this revision.
System plan/account lifecycle operations remain untouched. Properties are never
enrolled automatically, and creation transactions/publicationVersion are unchanged.
Returning a field to CRM and revision-checked/fenced real updates are future work.
