# use facet

Purpose: the job the asset does in a game or pipeline. One asset may carry more
than one `use:` tag when it genuinely serves several jobs; the counts below are
per tag occurrence.

Counts are from the four bundles currently in the catalog (2026-11-21).

## Values

| Value | Count | Meaning |
| --- | --- | --- |
| `use:tileset` | 1 | designed to repeat as terrain or floor |
| `use:ambience` | 1 | a background bed that loops under play |
| `use:concept-art` | 0 | mood, composition or design reference |
| `use:reference` | 2 | a plate or model kept to check proportions, colour or motion |
| `use:ui-icon` | 0 | small HUD, inventory or menu icon |
| `use:ui-sfx` | 0 | interface feedback sound |
| `use:palette` | 0 | colour reference for authoring other assets |

## Choice notes

- `use:` answers "what will the consumer do with it", so the same PNG can be
  `use:ui-icon` in one bundle and `use:reference` in another only by making two
  bundles. Do not duplicate files inside one bundle.
- `use:ui-icon` implies the asset is already trimmed and readable at small
  sizes; a large illustration that happens to be square is `use:concept-art`.
- `use:tileset` requires `technical.tileable = true`. If the art repeats but has
  a seam, it is `use:texture` (propose it) rather than a tileset.
- `use:ambience` is a bed that runs under other sound. A one-shot forest noise is
  a sound effect, and a composed track with a melody is music, not ambience.
- `use:reference` has no single medium: a texture, a camera loop and a model can
  all be kept as something to match.
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
