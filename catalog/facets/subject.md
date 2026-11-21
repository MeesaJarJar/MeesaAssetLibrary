# subject facet

Purpose: what the asset depicts, independent of file format or intended use.
Values are two-level (`subject:group/thing`) so a search can widen from
`subject:item/potion` to `subject:item/`.

Counts are from the ten bundles currently in the catalog (2026-11-21).

## Values

| Value | Count | Meaning |
| --- | --- | --- |
| `subject:environment/stone` | 2 | natural or worked stone surfaces: cobbles, walls, cliffs |
| `subject:creature/dog` | 6 | dogs and dog variants: portraits, action poses, barks and 3D reconstructions |
| `subject:environment/tree` | 0 | individual trees and tree variants: canopy, trunk and root structure |
| `subject:ambience/forest` | 1 | a non-musical bed that places the listener in a biome |
| `subject:structure/tower` | 0 | a built vertical structure, ruined or intact |
| `subject:item/potion` | 0 | a consumable inventory object |
| `subject:item/sword` | 1 | a held or displayed weapon; the silhouette is the point |
| `subject:ui/confirm` | 0 | positive acknowledgement feedback, not a click or hover |
| `subject:palette/forest` | 0 | a colour reference set for a biome |

## Choice notes

- Prefer the surface over the material when both apply: a cobblestone floor is
  `environment/stone`, not `environment/ground`.
- `subject:structure/*` is for recognisable architecture. A generic wall belongs
  under `environment/stone` unless the silhouette is the point.
- Sound beds take `ambience/<place>`; `environment/*` is for depicted places and
  surfaces, so a forest loop is `ambience/forest` while a forest image would take
  an `environment/*` value.
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
