# style facet

Purpose: how the asset is drawn or produced, so an agent can keep a set visually
consistent. Style is about rendering, not subject and not quality.

Counts are from the five starter bundles (2026-11-20).

## Values

| Value | Count | Meaning |
| --- | --- | --- |
| `style:pixel-art` | 1 | authored on a pixel grid; crisp edges, integer scaling |
| `style:painted` | 1 | soft brushes, gradients and atmospheric depth |
| `style:flat` | 1 | hard shapes, few tones, no gradients; UI-first |
| `style:clean-synth` | 1 | simple waveforms, no noise or distortion |
| `style:reference` | 1 | a documentation artifact, not a rendered scene |

## Choice notes

- `pixel-art` promises a pixel grid. The mossy tile is a 64x64 vector file but is
  drawn on whole pixels with 1px joints, so it belongs here; a smooth vector
  tile would not.
- `flat` is for icons and UI, where gradients are absent or minimal. Do not use
  it for a painted scene with a limited palette.
- `painted` covers concept art and matte work; it implies visible brush or
  gradient layering, not photorealism.
- Audio styles describe synthesis character. `clean-synth` means tonal and
  noise-free; use a different value for chiptune, foley or orchestral.

## Aliases

- `style:vector` is deliberately not used: vector is a file property, not a
  look. Choose `flat`, `pixel-art` or `painted` by appearance.
- `style:concept` duplicates the role; use `painted` plus `use:concept-art`.

## Rule

Append new values freely; never rename or delete an existing value. If two styles
keep being confused, add a distinction note here rather than renaming.
