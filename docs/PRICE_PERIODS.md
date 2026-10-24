# Rental price periods

`periodicidadPrecio`: mes, semana, dia, temporada, desconocida. Sale is null.
There is no monthly schema default and no mass migration. Historical rental
documents without the field retain monthly presentation/queries. Explicit null
on a rental is unknown, not legacy monthly. New creation helpers always persist
the field; the model validation hook also protects new direct model writes.

Manual rental creation requires a decision, including unknown if appropriate.
Changing sale to rental also requires a decision. Owner/admin partial edits
preserve omitted periods; unchanged edit selectors do not materialize a legacy
field or add a CRM override. Sale transitions clear the period. No price amount
is converted or corrected, including 0/1. The numeric input/parser stays numeric.

The shared browser/server formatter in public/js/precios.js accepts price,
operation, period. Historical two-argument calls remain compatible. All property
renderers and server email/SEO copy pass the field. Subscription prices are a
separate concept and unaffected. No monetary currency conversion is introduced.

Rental listings select a period (monthly initially), including unknown. The
backend min/max filter defaults to the monthly bucket for old rental clients;
explicit filters isolate their bucket. Monthly includes legacy absence but not
null/unknown. Client numeric sorting is preceded by the same period filter.
Unfiltered rental discovery may contain all periods, without comparing prices.
There is no automatic day/week/month conversion. Zero price bounds are valid.

Budget alerts compare only the same period. Legacy alerts missing the field
remain monthly. New rental budget alerts require an explicit period; unknown
properties cannot match monthly/weekly/daily alerts. They may match an explicitly
unknown alert. The existing alert delivery rules beyond period are unchanged.

Offer.price/priceCurrency remain numeric/EUR. Known periods add a minimal
UnitPriceSpecification with referenceQuantity=1 and unitText month/week/day/season;
unknown adds no temporal unit. Visible SEO text uses the same shared formatter.
No claim about Google rich-result eligibility is made.

Generic XML accepts canonical periodicidadPrecio (or pricePeriod) with the five
enum values. Unknown explicit values are invalid. New imports without it store
desconocida; they do not inherit a monthly assumption. Historical generic imports
without the persisted field remain legacy monthly. Snapshot absence remains
omitted so an old feed does not silently rewrite enrolled properties. An explicit
period participates in snapshot/managed fingerprints, diff and allowed UPDATE.
Manual period changes participate in contentRevision/syncOverrides.

Existing snapshot fingerprints are unchanged when the field is absent. Managed
fingerprints omit this additive field when undefined, preserving the historical
V1 encoding. MISSING fingerprints likewise omit the absent optional field. New
period data becomes part of evidence; no old run is granted new eligibility by a
default or migration. Existing locking, fencing and transaction logic is intact.

InmoWeb is still exclusively preview. Rental period is unknown with a warning;
sales stay nonperiodic. All other data blocks remain. ImportSource still only
supports generic_xml and no InmoWeb action is enabled. Activating NEW requires a
separate provider integration with Phase 2 identity, capacity, locking, images,
reconciliation and fresh-feed validation; do not infer completeness for MISSING.
