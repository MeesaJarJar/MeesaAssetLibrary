# format facet

Purpose: the main file format of the asset, so an agent can match a pipeline
without opening the bundle. `files[].mime` in `asset.json` remains the
authoritative type for every individual file.

Counts are from the four bundles currently in the catalog (2026-11-21).

## Values

| Value | Count | Meaning |
| --- | --- | --- |
| `format:svg` | 0 | vector image; renders anywhere, scales cleanly |
| `format:png` | 1 | raster image with optional alpha; lossless |
| `format:ogg` | 1 | compressed audio in an Ogg container |
| `format:wav` | 0 | uncompressed PCM audio |
| `format:mp4` | 1 | compressed video in an MP4 container |
| `format:ply` | 1 | 3D geometry, including Gaussian splat point clouds |
| `format:markdown` | 0 | plain-text document with light markup |

## Choice notes

- Tag the primary deliverable, not every file in `src/`. A model bundle with a
  GLB plus textures is `format:glb`; the textures are listed in `files[]`.
- Use the container, not the codec: WAV is `wav`, even though the interior is
  16-bit PCM; a Godot package is `format:zip` if that is what ships.
- `ply` covers both scanned meshes and Gaussian splat point clouds. The facet
  follows the shipped extension, not the payload's internal structure.
- SVG is tagged `svg` even when the content is pixel-art; the facet describes
  bytes, `style:` describes the look.
- Format values are lowercase and have no dots (`markdown`, not `.md`).

## Aliases

- `format:md` and `format:text` were rejected; use `markdown`.
- `format:vector` is not a format. Use `svg`.
- `format:audio` is not a format. Name the container.

## Rule

Append new values freely; never rename or delete an existing value. When a new
kind of file enters the library, add its format value here and note it in
`_proposed.md` if the name is debatable.
