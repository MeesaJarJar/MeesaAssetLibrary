# Mossy Forest Palette

Eight swatches for wet stone, bark and undergrowth under cool overcast light.
Ordered dark to light; keep to that order when building ramps so the value
structure survives the muted hues.

| Name | Hex | RGB | Use |
| --- | --- | --- | --- |
| Deep Canopy | `#14201a` | 20, 32, 26 | background fill, silhouettes, letterbox |
| Pine Shadow | `#223229` | 34, 50, 41 | shadow masses, distant foliage |
| Moss Bed | `#3d5233` | 61, 82, 51 | ground base, large mid-dark planes |
| Fern Green | `#55703c` | 85, 112, 60 | mid foliage, moss highlights |
| Lichen | `#7d8f5f` | 125, 143, 95 | lit foliage edges, small UI tint |
| Bark Brown | `#4a3a2a` | 74, 58, 42 | trunks, wooden props, trodden dirt |
| Stone Grey | `#6a7365` | 106, 115, 101 | cobble midtone, ruined walls |
| Mist | `#c9d2c0` | 201, 210, 192 | fog, rim light, text on dark |

## Contrast checks

- Mist on Deep Canopy is 10.8:1: safe for body text and small labels.
- Mist on Moss Bed is 5.5:1: still passes AA for normal text.
- Lichen on Pine Shadow is 3.8:1 and Stone Grey on Deep Canopy is 3.4:1: use
  these for large text, icon shapes and surfaces, not paragraphs.

## Pairing notes

- Stone Grey is sampled from IMG-TILE-000001, so cobble floors and UI panels
  built from this palette sit next to that tile without a hue shift.
- Build foliage ramps as Canopy, Moss Bed, Fern Green, Lichen. Reserve Bark
  Brown as the only warm hue; more than about one tenth of the frame reads as
  autumn rather than mossy forest.
- For dusk scenes shift the top of the ramp toward a desaturated violet and keep
  Mist for the fog band, as in IMG-CONCEPT-000002.
