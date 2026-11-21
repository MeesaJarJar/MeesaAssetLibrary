# Proposed facets and values

Landing log for vocabulary that is in use, or under discussion, but is not yet
promoted to a facet file. Everything here is valid to use today unless an entry
says otherwise.

Counts are from the four bundles currently in the catalog (2026-11-21).

## Namespaces in use without a facet file

| Namespace | Values in use | Why it exists | Promotion trigger |
| --- | --- | --- | --- |
| `palette:` | `mossy-green` (3), `twilight` (0), `crimson` (0) | groups assets that share a colour ramp so sets can be matched by mood and hue | promote to `palette.md` once a fifth palette value appears |
| `mood:` | `melancholic` (0) | emotional framing, mainly for concept plates and music | promote to `mood.md` when mood becomes a common filter |

These were introduced by the starter set and remain valid to use; deleted bundles
keep their values documented with count 0 so the vocabulary does not churn. They
are listed here rather than in a facet file because one or two values do not
justify a file yet; do not treat them as provisional or discouraged.

## Open values

| Proposed value | Status | Reason |
| --- | --- | --- |
| `use:texture` | in use by policy, no asset yet | repeating non-seamless surfaces; `use:tileset` requires `technical.tileable = true` |
| `subject:ui/click` | proposed | neutral pointer feedback; currently no asset needs it |

## Promotion procedure

1. Copy the namespace into its own `catalog/facets/<namespace>.md` with purpose,
   values, counts, aliases and the never-rename rule.
2. Leave the entry here, marked `promoted YYYY-MM-DD`.
3. Do not change existing assets. The tags are already correct; promotion only
   changes where they are documented.

## Rule

Append freely. Never delete an entry: the history explains why names exist.
Never use this file to rename a live value; add the new value and migrate only
new assets.
