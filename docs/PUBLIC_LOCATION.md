# Public location and privacy

`direccion` is a postal street when supplied, never a fabricated display value.
`ubicacionPublica` is display text; `precisionUbicacion` is exacta or aproximada.
New manual creation defaults to exacta. CRM without a street defaults to
aproximada. Both fields are optional for legacy records: no migration is needed.

The manual schema still requires a nonempty street. The separate CRM creation
schema accepts no street only with a nonempty locality. Owner edits preserve
omitted fields. Existing CRM records without a street can be edited without
introducing one; the manual form only permits this exception after loading an
owned CRM property with locality. New manual publication retains its validation.

The shared browser helper is imported by the server through publicLocation.js.
Display priority is explicit public text, exact/legacy address, zone + locality,
locality + province, locality, province, then an unavailable message. Comma
components are deduplicated case/accent-insensitively. No geocoding fills data.

Public list/detail/related/favorite responses remove street and coordinates from
approximate records. The owner/admin interfaces retain authorized access to the
stored values. Approximate map queries use only locality/province, ignore saved
coordinates and display no marker or exact popup. Failed lookups display a
controlled unavailable state. Exact/legacy maps retain their previous behavior.
JSON-LD excludes streetAddress on approximate records. Search does not match a
private street on approximate records; it includes public location, locality and
province. Titles/descriptions/photos remain advertiser-supplied content: they
may independently disclose location and are not automatically anonymized.

Location fields participate in content revisions/overrides. MISSING content
fingerprints omit the two new fields when absent, preserving historical causal
evidence. A later real change of precision/public text invalidates old evidence.

InmoWeb remains read-only. This change removes the conceptual missing-street
block only; rental frequency, unknown condition and incomplete publication data
may still block records. Provider completeness remains unverified and no NEW,
UPDATE, MISSING or REAPPEARED action is enabled for InmoWeb.
