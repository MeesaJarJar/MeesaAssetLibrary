# use facet

Purpose: the job the asset does in a game or pipeline. One asset may carry more
than one `use:` tag when it genuinely serves several jobs; the counts below are
per tag occurrence.

Counts are from the eight bundles currently in the catalog (2026-11-20).

## Values

| Value | Count | Meaning |
| --- | --- | --- |
| `use:tileset` | 1 | designed to repeat as terrain or floor |
| `use:concept-art` | 4 | mood, composition or design reference |
| `use:ui-icon` | 1 | small HUD, inventory or menu icon |
| `use:ui-sfx` | 1 | interface feedback sound |
| `use:palette` | 1 | colour reference for authoring other assets |

## Choice notes

- `use:` answers "what will the consumer do with it", so the same PNG can be
  `use:ui-icon` in one bundle and `use:reference` in another only by making two
  bundles. Do not duplicate files inside one bundle.
- `use:ui-icon` implies the asset is already trimmed and readable at small
  sizes; a large illustration that happens to be square is `use:concept-art`.
- `use:tileset` requires `technical.tileable = true`. If the art repeats but has
  a seam, it is `use:texture` (propose it) rather than a tileset.
- `use:concept-art` is for human-facing plates. A turnaround sheet intended for
  modellers is `use:reference`.

## Aliases

- `use:game-asset` is too broad and must not be added; pick the concrete job.
- `use:sound-effect` and `use:sfx` overlap: the namespace already says use, so
  keep `ui-sfx`, `combat-sfx` style values and avoid a bare `sfx`.
- `use:icon` was rejected; `ui-icon` names the surface as well as the shape.

## Rule

Append new values freely; never rename or delete an existing value. Prefer a
specific job value over a broad one, and record genuinely new jobs in
`_proposed.md` before the first use if they need discussion.
