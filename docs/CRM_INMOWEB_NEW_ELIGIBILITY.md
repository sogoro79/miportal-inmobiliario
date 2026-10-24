# InmoWeb: future NEW data eligibility (preview only)

This policy does not enable import, UPDATE, MISSING or REAPPEARED. It does not
evaluate the user's plan, capacity, source ownership, locks or feed freshness.
`futureNewEligible` means data eligibility only, never authorization to publish.
The global preview remains read-only, with importEnabled/syncEnabled false.

## Required

- Stable, unique provider externalId; Spanish title within existing length limits.
- Supported sale/rental operation, supported property type, numeric finite price
  >= 0, EUR, and available commercial status.
- Locality for this street-less provider; public location is derived without
  inventing a street, with approximate precision.
- Explicit nonnegative integer bedrooms (0 is valid).
- Known ON/SM condition. The general schema permits omission, but the creation
  helper/model default to segunda_mano; an unknown provider value must not reach
  that path. It remains null and blocked in this preview.

## Rental period

Propiedad has no periodicity field. public/js/precios.js unconditionally renders
alquiler as EUR/month; detail SEO and listing/profile cards consume that helper.
The InmoWeb normalized preview's periodicidadPrecio=null is not persisted.
All InmoWeb rentals therefore stay blocked with INMOWEB_RENT_PERIOD_UNKNOWN.
Do not infer monthly pricing from text, price magnitude or operation ID.
Adding a persistent periodicity field is a separate future change requiring
end-to-end schema, persistence, display, SEO, filtering and alert decisions.

## Optional / warnings

- Bathrooms, built surface and images may be absent: warn, do not fabricate or
  block. Missing bedrooms blocks because the actual creation schema requires it.
- Description, reference, province, postcode, coordinates, zone, energy rating,
  features, plot/living areas and video are not required. No video is invented.
- Existing invalid-value/duplicate/unsupported diagnostics stay blocking.
- Price 0/1 is preserved and receives a strong review warning, not a new minimum.
  Current schema accepts >=0; numeric filters/alerts can include it, and JSON-LD
  emits the numeric price. Some legacy truthy fallbacks omit price 0 in copy.
  The public common formatter renders 0/1 normally, including /mes for rentals.
- Missing images are not a reason to upload placeholders or generic assets.

## Preview labels

- No blockers/no warnings: Apto para futura importacion.
- No blockers/one or more warnings: Requiere revision (eligible by data).
- One or more blockers: No apto (warnings remain visible alongside blockers).

The evaluator is isolated from generic_xml. Adapter and preview reuse it; the
preview returns only safe codes/messages and flags, never provider metadata.
Before activating NEW, explicitly integrate the provider with the existing Phase
2 persistence/identity/plan/locking/reconciliation path, prevent condition/type
defaults and missing-number coercion, and revalidate all data on a fresh feed.
Source type support, normalization/fingerprint versions, privacy and action
isolation require dedicated tests. Snapshot completeness remains unverified;
MISSING/REAPPEARED must not be enabled as a side effect of NEW.
