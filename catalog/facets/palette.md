# palette facet

Purpose: the dominant colour ramp of an asset, so a set can be matched by hue
and mood. Palette describes the colours that carry the piece, not the file
format or the subject.

Counts are from the ten bundles currently in the catalog (2026-11-21).

## Values

| Value | Count | Meaning |
| --- | --- | --- |
| `palette:mossy-green` | 3 | cold greens over grey stone, moss and wet timber |
| `palette:warm` | 2 | amber, sand and golden-hour tones |
| `palette:earth` | 1 | browns, tans and natural wood or leather |
| `palette:monochrome` | 1 | near-black, white and neutral greys |
| `palette:twilight` | 0 | indigo, violet and amber dusk |
| `palette:crimson` | 0 | deep reds and warm highlights |

## Choice notes

- Tag the palette the viewer actually sees, not the palette of the source
  material. A grey stone tile with moss is `mossy-green`, not `monochrome`.
- `warm` and `earth` can coexist on different assets; do not use both for the
  same asset unless two distinct ramps genuinely carry it.
- `monochrome` means the whole image is neutral, not just that one material is
  grey.

## Aliases

- `palette:green` is too broad; use `mossy-green` or propose a specific value.
- `palette:grey` overlaps `monochrome`; prefer `monochrome` for a neutral image.
- `palette:gold` is a synonym for `warm` unless the piece is literally metallic.

## Rule

Append new values freely; never rename or delete an existing value.
