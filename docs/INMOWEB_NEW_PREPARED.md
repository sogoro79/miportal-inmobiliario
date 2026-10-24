# InmoWeb NEW: integration prepared, activation pending

`INMOWEB_NEW_ENABLED` is OFF by default. Only the exact string `true` enables
the server-side NEW path. No environment value is changed by this implementation.
Keep it OFF until a separately authorized controlled test.

Real NEW execution requires BOTH `INMOWEB_NEW_ENABLED=true` and
`INMOWEB_NEW_ALLOWED_EXTERNAL_IDS=<authorized IDs>`. The latter is an operational
allowlist of exact strings separated by commas: whitespace around entries is
trimmed, empty entries are ignored and entries containing `*` never grant access.
An absent or empty allowlist denies all InmoWeb selections. There is no substring
or wildcard matching. If any selected ID is unauthorized, the entire request is
rejected with `INMOWEB_NEW_EXTERNAL_ID_NOT_ALLOWED` before the lease, feed refetch,
images or writes. The shared importer checks the same policy again.

For the first controlled test the allowlist must contain exactly ONE external ID.
Do not commit the real production ID or feed credentials. Configuration is never
returned to the frontend or logged; UI selection alone does not authorize an ID.
The allowlist does not replace ownership, run, plan, quota or snapshot checks,
and does not enable any other InmoWeb action. Neither variable is configured by
this implementation. Generic XML is unaffected by this policy.

Configure the encrypted source with `PUT /api/crm-import/sync/source`, providing
`feedUrl` and `feedType: inmoweb`. There is still one source per user. Changing
the URL hash or feed type is forbidden while CRM properties reference that source.
No full URL, provider credential or plaintext URL belongs in this document.

The simulation stores a NEW-only presence check independently of
`snapshotComplete`, which remains false for InmoWeb. Missing catalogue entries
cannot authorize hiding. UPDATE, enrollment and REAPPEARED remain unsupported for
InmoWeb even when NEW is explicitly enabled.

`POST /api/crm-import/sync/import-new` retains the body `{ runId, externalIds }`.
It reacquires the existing source lease, downloads through the pinned fetcher,
rechecks the canonical snapshot digest and data eligibility, then delegates to
the same selected importer, images, plan/capacity fences and reconciliation journal
used by generic XML. Persistence and NEW receipts are atomic per property, not
globally across the batch. Technical limits remain 10 properties / 100 importable
images / 120 seconds. Plan photo caps are reported as omitted images for InmoWeb.

The current analysis UI remains read-only. With the gate OFF, a simulation cannot
offer an active NEW selector and backend execution rejects with
`INMOWEB_NEW_DISABLED` before fetching images or claiming the import operation.

Before a first real test: review this integration, authorize activation separately,
use one eligible reference and a fresh source-owned simulation, confirm plan/quota
and expected image count, then verify the persistent receipt and public-location
privacy. Never retry an indeterminate outcome; consult the run and reconciliation.
Any cleanup needs its own explicit authorization and identity validation.

Automated tests use synthetic XML, injected image/upload implementations and
in-memory transactional model mocks. They do not access production services.
