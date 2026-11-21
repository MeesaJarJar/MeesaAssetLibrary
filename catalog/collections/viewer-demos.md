# viewer-demos

A four-asset slice that exercises every media viewer path in the gallery: image,
audio, video and 3D splat. The pieces share one mossy stone theme, so the set can
also dress a small forest-ruin scene.

| ID | Title | Why it belongs |
| --- | --- | --- |
| `IMG-TEXTURE-000009` | Mossy Cobblestone Texture | Exercises the image viewer: the 768x768 tile opens with zoom and pan at 100% and 200%. |
| `SND-AMBIENCE-000010` | Mossloop Ambience | Exercises the audio player: the six-second loop repeats cleanly thanks to its fade. |
| `VID-CAPTURE-000011` | Mossy Tile Camera Loop | Exercises the video player: a 1280x720 H.264 clip with no audio track. |
| `MDL-PROP-000012` | Sword Totem Splat | Exercises the WebGL splat viewer: 32,768 gaussians load from the PLY original. |

## Notes

- One bundle per viewer keeps a viewer regression obvious: if a path breaks, its
  single asset fails to load.
- The collection is curated by hand. Adding an asset here is a human decision;
  agents may propose a collection but must not invent one silently.
- The four bundles do not yet list this collection in `relations.collections`;
  add it on the next bundle edit rather than rewriting the existing records.
