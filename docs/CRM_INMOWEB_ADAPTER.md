# InmoWeb adapter: normalization and read-only preview

The adapter is opt-in through `analyzeFeedXml(xml, { feedType: "inmoweb" })`
and `buildFeedSnapshot(xml, { feedType: "inmoweb" })`. `detectFeedType(xml)`
recognizes the exact `properties/propiedad` shape. The default remains
`generic_xml`; InmoWeb import and sync actions are not enabled.

## Phase 2: opt-in analysis only

`POST /api/crm-import/analyze` accepts optional `feedType`:
`generic_xml` (also the default when omitted), `inmoweb`, or `auto`.
The profile selector defaults to generic XML; auto detection is explicitly
selected, never imposed on existing callers. InmoWeb uses the existing public
feed fetcher with unchanged SSRF/DNS pinning, redirects, deadlines, XML byte
limit and content-type rules. No images are downloaded by analysis.

The InmoWeb response has `previewOnly: true`, `importEnabled: false`,
`syncEnabled: false`, `puedePublicarAhora: false`, and `snapshotComplete: false`.
It includes a whitelist of display fields and safe issues with severity
`blocking` or `warning`. Metadata, full descriptions, image URLs and internal
evidence are excluded. Text links/contact details are redacted in display text.
The response is not cached; the private feed input is masked. Error logs mask
the feed URL and use an allowlist of error codes, never raw errors.

The UI renders no import checkboxes in this mode, hides the import button and
also guards its handler. Rental prices show the explicit currency without
assuming a monthly frequency. All normalized photos are counted, including
more than 60. There is no source creation or MongoDB write in this path.
Existing generic import, sync models and action contracts remain unchanged.

## Single canonical transformation

`normalizeInmowebXml` supplies both views. The snapshot keeps `{ data, metadata,
errors, warnings, publishableByData }`; preview flattens the same data and aliases
`imagenes` to `fotos`. Metadata is preparatory, not a new public HTTP contract.
It must not be passed wholesale to clients, persisted to business models or
logged when later integrating real preview.

- Identity: string attribute `propiedad/@id`, never a commercial reference.
  Leading zeroes survive; missing/unsafe/duplicate IDs block the record.
- Operation IDs: 1 -> venta; 2 -> alquiler; all others are unsupported.
- Family IDs: 1 apartamento; 3 chalet; 9 finca_rustica; 10 local_comercial;
  16 casa_campo; 20 casa; 21 adosado; 22 duplex; 24 piso.
  IDs, not display labels, are authoritative. Unknown values never default to piso.
- Condition: ON -> obra_nueva; SM -> segunda_mano; unknown/empty -> null + block.
- Commercial status: activo -> Disponible; reservado -> Reservado + block.
  captacion/unknown/empty remain unavailable, never inferred as active.
- Currency is explicit; only EUR is supported. Prices are not converted or
  corrected. Prices <= 1 produce a review warning and retain their value.
- Rental periodicity is null and blocks publication. The public price renderer
  currently labels alquiler as monthly; product policy must be resolved first.
- Missing bedrooms/bathrooms remain null and block; explicit zero survives.
  Toilets are metadata, never added to bathrooms.
- superficie is exclusively built area; there is no fallback to living area.
  Living area and original areas are retained in metadata; plot area is separate.
- Locality, province, postcode, country, zone and valid coordinate pairs survive.
  No street address is invented. `direccion` stays empty; `ubicacionPublica` uses
  zone + locality or locality + province, with approximate precision. The CRM-only
  schema requires locality when street is absent; missing locality is blocked
  with INMOWEB_LOCATION_INSUFFICIENT. Manual creation still requires a street.
- Only Spanish provides primary content; English is preserved in metadata, not
  used as fallback. Duplicate language blocks the record.
- Known rich feature values map to booleans, preserving originals in metadata.
  Absent/unknown values are omitted, not converted to false.
- Photos: principal first, otherwise XML order, stable deduplication, HTTP/HTTPS
  URL validation through existing policy. No downloading, DNS or Cloudinary.
  All photos remain available, including more than 60. Later transport must
  revalidate DNS/pin IPs and enforce commercial and 10/100/120 batch limits.

## Completeness and future integration

`snapshotComplete` is always false in Phase 1. XML validity or traversal alone
cannot prove the feed is the complete source catalogue. `structurallyComplete`
only describes the root/record traversal, not authorization for MISSING.
The existing 5 MB XML ceiling and 2000-record snapshot ceiling are reused;
preview is bounded and explicitly reports truncation. No caller flag enables
MISSING. Future work must validate provider completeness and retain all existing
MISSING/reappearance evidence, identity, ownership, reconciliation and locks.

Read-only preview now supplies safe response shaping and messages. Do not pass
raw metadata (especially translations/features) to the UI unchecked.
Before NEW, resolve rental period/unknown values, reuse Phase 2
validation and ensure the adapter's nulls are not silently replaced by defaults.
Keep source URL hashes and the one-source-per-user protection unchanged.
Before UPDATE, version normalization and adapt baseline/digest consumers while
preserving the current allowed fields, revisions and overrides.
Before MISSING, establish trusted full-catalogue evidence; never infer removal
from filtering out unsupported or invalid records. Before REAPPEARED, reuse
causal hide receipts and content/capacity checks, not just an ID match.
Models currently accept only generic_xml sources; they are intentionally not
extended here. All tests use invented data and reserved example.test image hosts.
