# style facet

Purpose: how the asset is drawn or produced, so an agent can keep a set visually
consistent. Style is about rendering, not subject and not quality.

Counts are from the ten bundles currently in the catalog (2026-11-21).

## Values

| Value | Count | Meaning |
| --- | --- | --- |
| `style:pixel-art` | 0 | authored on a pixel grid; crisp edges, integer scaling |
| `style:painted` | 0 | soft brushes, gradients and atmospheric depth |
| `style:realistic` | 4 | true-to-life surfaces, lighting and proportions; not stylised |
| `style:stylized` | 5 | deliberate simplification or exaggeration; not photoreal, not a pixel grid |
| `style:flat` | 0 | hard shapes, few tones, no gradients; UI-first |
| `style:clean-synth` | 1 | simple waveforms, no noise or distortion |
| `style:reference` | 0 | a documentation artifact, not a rendered scene |

## Choice notes

- `pixel-art` promises a pixel grid. A 64x64 vector file drawn on whole pixels
  with 1px joints belongs here; a smooth vector tile would not.
- `flat` is for icons and UI, where gradients are absent or minimal. Do not use
  it for a painted scene with a limited palette.
- `painted` covers concept art and matte work; it implies visible brush or
  gradient layering, not photorealism.
- `realistic` covers both generated and captured material: it says the result
  reads as physical, not that it came from a camera. A painted plate with
  realistic lighting is still `painted`.
- Audio styles describe synthesis character. `clean-synth` means tonal and
  noise-free; use a different value for chiptune, foley or orchestral.

## Aliases

- `style:vector` is deliberately not used: vector is a file property, not a
  look. Choose `flat`, `pixel-art`, `painted` or `realistic` by appearance.
- `style:concept` duplicates the role; use `painted` plus `use:concept-art`.

## Rule

Append new values freely; never rename or delete an existing value. If two styles
keep being confused, add a distinction note here rather than renaming.
