# demo-starter

A five-asset vertical slice proving the bundle format across image, audio and
doc kinds. The pieces share one look, so they can dress a small ruined-forest
scene without any other imports.

| ID | Title | Why it belongs |
| --- | --- | --- |
| `IMG-TILE-000001` | Mossy Stone Tile | the ground layer: a seamless floor that sets the grey-green stone tone |
| `IMG-CONCEPT-000002` | Ruined Tower on a Hill | the mood target and title-screen plate for the same ruin |
| `IMG-ICON-000003` | Health Potion Icon | the HUD layer, readable at 16px over the dark palette |
| `SND-SFX-000004` | UI Confirm Blip | the interaction layer, matching the scene's clean and quiet tone |
| `DOC-PALETTE-000005` | Mossy Forest Palette | the contract that keeps the other four in one colour family |

## Notes

- Palette first, then tile, then concept: that is also the intended authoring
  order if the set is extended.
- The collection is curated by hand. Adding an asset here is a human decision;
  agents may propose a collection but must not invent one silently.
- Collection membership is mirrored in each bundle's `relations.collections`.
