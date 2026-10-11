# CRM synchronization: manual UPDATE apply (Phase 3B.1B)

## Scope and request

`POST /api/crm-import/sync/apply` requires Bearer authentication and the strict body
`{ runId, externalIds }`. The owner always comes from req.user.id. The selection
contains 1-10 distinct references already present as eligible UPDATE entries in
the owned run. Foreign runs/sources return 404; malformed IDs/body return 400.
No client URL, new values, owner or fingerprints are accepted.

Only precio, titulo, descripcion, habitaciones, banos, superficie, garaje, piscina
and terraza are writable. Only effective changed fields are set. The V1 baseline
policy preserves zero, false, empty description and allowed null values. The XML
adapter accepts explicit scalar nil for surface without accepting nested objects.
No NEW/MISSING action, photos, Cloudinary, visibility, geography, operation, status,
publicationVersion, quotas, automation, worker or cron is changed.

## Revalidation and atomicity

The run must be simulated, globally applicable, complete, non-truncated and within
its original 20-minute expiry. Its source identity and all normalization/snapshot/
managed-field versions must still match. An active, configured own source is required.

Apply acquires the existing shared ImportSource token/lease, decrypts its URL and
downloads once through the hardened fetcher (all-address SSRF validation, DNS
pinning, Host/SNI, redirects, timeout and streaming size limits unchanged). A new
complete snapshot must have exactly the original full digest, including excluded
fields. Changed or incomplete feeds require a new simulation; no silent rebase.

Inside one MongoDB session.withTransaction, snapshot reads and majority writes:

- Fence the source lease by writing the common locked source document.
- Re-read the owned run and selected CRM properties.
- Recompute the plan from newly downloaded data; validate property ID, ownership,
  source, externalId, syncEnabled, revision, baseline/version, proposed fingerprint
  and changed field names. Any override, including excluded fields, blocks apply.
- Conditionally claim simulated -> applying before writing properties.
- Update each property by revision/baseline CAS, increment contentRevision once,
  advance the managed baseline and lastSyncedAt/lastSeenAt; retain full fingerprint
  and all overrides unchanged.
- Check lease and wall-clock expiry again, then record applied with selected IDs,
  appliedCount, blockedCount, appliedAt and safe result codes in the same transaction.

Any failure rolls back every property and the run claim. The run remains simulated,
not falsely applied. A conflict requires a fresh simulation, not automatic retry
with new content. Downloads are outside the retryable callback; transaction retries
cannot repeat downloads or external side effects. Atlas must support transactions
(replica set or compatible sharded cluster); no standalone fallback is provided.

Unknown commit results return a controlled 503 without claiming success or failure.
Read the run status before retrying. No out-of-transaction failure write can erase
a committed result.

## Idempotence and manual editing

An applied run accepts only the same reference set (order independent), returning
the saved safe result with alreadyApplied=true. No download, property write,
revision increment or property timestamp update occurs. Different selections are
rejected; applying remaining entries requires a fresh simulation.

Owner/admin forms send expectedContentRevision from the loaded property. Both save
routes compare it and include contentRevision in Mongoose's actual save filter.
Stale revisions return 409; the user must reload. Manual edits retain normal
per-field overrides and revision increments. Legacy callers omitting the revision
remain compatible: the server uses its freshly read revision and protects the
read-to-save race, but cannot detect a page opened earlier without a supplied
revision. New forms always supply it.

## UI, limits and safe data

Profile offers checkboxes only for eligible UPDATE, maximum 10, and an explicit
confirmation before POST. Success refreshes the run via GET; nothing is applied or
simulated automatically. Expired runs ask the user to simulate again.

Apply has separate fixed-window rate limits: 5 requests/hour per authenticated user
AND 5 requests/hour per IP, independent of analyze/simulate buckets. Repeated calls,
including idempotent calls, are subject to those request limits.

Runs/results/logs contain safe IDs, counters, dates and allowlisted codes, not full
before/after values, descriptions, XML, feed URLs, ciphertext or secrets. Phase 2
remains 10 properties / 100 photos / 120 seconds; commercial plan limits are unchanged.

Tests use mock persistence/transport and a mocked Mongoose collection to verify
save CAS. No real MongoDB or Cloudinary is used for this implementation's checks.
