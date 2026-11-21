# subject facet

Purpose: what the asset depicts, independent of file format or intended use.
Values are two-level (`subject:group/thing`) so a search can widen from
`subject:item/potion` to `subject:item/`.

Counts are from the eight bundles currently in the catalog (2026-11-20).

## Values

| Value | Count | Meaning |
| --- | --- | --- |
| `subject:environment/stone` | 1 | natural or worked stone surfaces: cobbles, walls, cliffs |
| `subject:environment/tree` | 3 | individual trees and tree variants: canopy, trunk and root structure |
| `subject:structure/tower` | 1 | a built vertical structure, ruined or intact |
| `subject:item/potion` | 1 | a consumable inventory object |
| `subject:ui/confirm` | 1 | positive acknowledgement feedback, not a click or hover |
| `subject:palette/forest` | 1 | a colour reference set for a biome |

## Choice notes

- Prefer the surface over the material when both apply: a cobblestone floor is
  `environment/stone`, not `environment/ground`.
- `subject:structure/*` is for recognisable architecture. A generic wall belongs
  under `environment/stone` unless the silhouette is the point.
- Do not add flat one-word values (`subject:stone`, `subject:tower`). Two levels
  keep the facet sortable and let queries widen by prefix.
- For UI sounds, describe the event (`ui/confirm`), not the input device. A
  click that confirms is still `ui/confirm`.

## Aliases

- `subject:rock` and `subject:terrain/stone` were considered and rejected; fold
  them into `environment/stone`.
- `subject:ui/click` is not a synonym: use `ui/confirm` for success feedback and
  propose a new value if you need a neutral pointer click.

## Rule

Append new values freely; never rename or delete an existing value. New
top-level groups are allowed but must be noted in `_proposed.md` in the same
change.
