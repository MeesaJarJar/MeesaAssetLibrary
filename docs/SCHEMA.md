# Library Schema v1

Reference for every file the library stores. If a rule here conflicts with a
sample bundle, the sample is wrong: fix the sample, not the rule.

## Bundle layout

```
assets/<kind>/<role>/<6-digit>-<slug>/
  asset.json    machine truth; schema described below
  asset.md      LLM digest, 3-8 lines, focused on when to use the asset
  preview.svg   cheap self-contained thumbnail; never the full-size original
  src/          originals, one or more files
```

- `<slug>` is lowercase ASCII with hyphens, 2-40 characters, descriptive.
- `preview.svg` must render without network access and must not embed a
  full-resolution copy of the original.
- `src/` may hold one file or several that belong together (for example a model
  plus its texture set). Each file gets its own entry in `files[]`.
- `src/` must contain at least one file. Empty marker-only bundles are invalid.

## asset.json

Top-level object, UTF-8, 2-space indentation, trailing newline. Keys are
required unless marked optional.

| Key | Type | Notes |
| --- | --- | --- |
| `schema` | integer | exactly `1` |
| `id` | string | `KIND-ROLE-NNNNNN`, see ID rules |
| `kind` | string | one of the kinds in the counts table |
| `role` | string | the role directory this bundle lives in |
| `title` | string | human-readable name, at most 80 characters |
| `summary` | string | one or two sentences; says what it is and when to use it |
| `tags` | string[] | `namespace:value` strings, at least two |
| `preview` | string | bundle-relative filename, currently `preview.svg` |
| `files` | object[] | at least one entry, see below |
| `technical` | object | kind-specific block, see below |
| `source` | object | `origin`, `tool`, `captured` |
| `relations` | object | `parent`, `variants`, `collections` |
| `notes` | string | free text, may be `""` |

### files[] entries

| Key | Type | Notes |
| --- | --- | --- |
| `path` | string | bundle-relative, forward slashes, starts with `src/` |
| `bytes` | integer | exact file size on disk, `>= 1` |
| `mime` | string | IANA type, e.g. `image/svg+xml`, `audio/wav` |
| `sha256` | string | 64 lowercase hex characters of the exact bytes |

### source

| Key | Type | Notes |
| --- | --- | --- |
| `origin` | string | `original`, `generated`, `captured` or `third-party` |
| `tool` | string | authoring tool, pipeline or `""` when not applicable |
| `captured` | string | ISO date `YYYY-MM-DD` the bytes entered the library |

### relations

| Key | Type | Notes |
| --- | --- | --- |
| `parent` | string \| null | canonical bundle ID for a variant |
| `variants` | string[] | IDs of bundles derived from this one, may be empty |
| `collections` | string[] | collection slugs, may be empty |

Relations are advisory: the index and directories are the source of truth for
existence, so never point at a bundle that does not exist.

## ID rules

- Format: `KIND-ROLE-NNNNNN`, uppercase, three segments, hyphen separated.
- `KIND` is the abbreviation in the table below and must equal `kind`.
- `ROLE` is the role directory name uppercased, with `_` replaced by `-`.
- `NNNNNN` is a zero-padded sequence that is monotonic across the whole library.
  The next asset takes the highest existing sequence plus one. Sequences are
  never reused, even after a bundle is retired.
- The six digits must match the directory prefix: `IMG-TILE-000001` lives in
  `assets/image/tile/000001-*`.
- `id`, `kind`, `role` and the on-disk path must always agree.

| Kind | Abbreviation |
| --- | --- |
| image | `IMG` |
| model | `MDL` |
| audio | `SND` |
| video | `VID` |
| font | `FNT` |
| material | `MAT` |
| doc | `DOC` |
| project | `PRJ` |
| other | `MSC` |

## technical blocks

Use `null` for a field that is genuinely unknown or not applicable. Never omit a
required field, and never invent a value to avoid `null`.

### image

| Key | Type | Notes |
| --- | --- | --- |
| `width` | integer | pixels |
| `height` | integer | pixels |
| `alpha` | boolean | true when the file carries transparency |
| `tileable` | boolean | true only when edges repeat without a visible seam |
| `palette` | string[] \| null | 3-8 dominant `#rrggbb` values |

### audio

| Key | Type | Notes |
| --- | --- | --- |
| `duration_s` | number | seconds, up to 3 decimals |
| `sample_rate` | integer | Hz, e.g. `22050`, `44100`, `48000` |
| `channels` | integer | `1` mono, `2` stereo |
| `bit_depth` | integer | `16` or `24` |
| `loopable` | boolean | true when the file loops without a click |

### model

| Key | Type | Notes |
| --- | --- | --- |
| `format` | string | `glb`, `gltf`, `fbx`, `obj`, `blend` |
| `polycount` | integer | triangles after triangulation |
| `uv` | boolean | true when UVs are present |
| `materials` | integer | number of material slots |
| `rigged` | boolean | true when a skeleton is included |
| `animations` | integer | number of clips, `0` when none |
| `scale_units` | string | `meters`, `centimeters`, `inches` |

### video

| Key | Type | Notes |
| --- | --- | --- |
| `duration_s` | number | seconds, up to 3 decimals |
| `resolution` | string | `WIDTHxHEIGHT`, e.g. `1920x1080` |
| `fps` | number | frames per second |
| `codec` | string | `h264`, `vp9`, `prores`, `gif` |

### font

| Key | Type | Notes |
| --- | --- | --- |
| `family` | string | family name as shipped |
| `weights` | string[] | e.g. `["regular", "bold"]` |
| `glyphs` | integer | supported codepoint count |

### doc

| Key | Type | Notes |
| --- | --- | --- |
| `format` | string | `markdown`, `pdf`, `csv`, `json`, `txt` |
| `pages` | integer | rendered pages; `1` for single-screen documents |

### material

`format` (`sbsar`, `mtlx`, `png-set`), `channels` (string[] such as
`["albedo", "normal", "roughness"]`), `resolution` (integer pixels) and
`tileable` (boolean).

### project

`engine` (`godot`, `unity`, `unreal`, `other`), `engine_version` (string) and
`bundle_type` (`import-package`, `export-preset`, `sample`).

### other

`format`: a short format identifier.

## Tags

- Tag strings are `namespace:value`, lowercase, no spaces. Use `/` for
  sub-values: `subject:environment/stone`.
- Existing namespaces: `subject`, `style`, `use`, `palette`, `mood`, `format`,
  `engine`. Facet files document the first five; `_proposed.md` tracks the rest.
- `format:` mirrors the main file format, `engine:` names a target engine or
  `any` for engine-neutral files.
- Append values freely; never rename or delete an existing value.
- A tag with no count in a facet file is still valid if an asset uses it. The
  facet files list what is known, not what is permitted.

## Variants

- A variant is a full bundle with its own ID, directory, `preview.svg` and
  `src/` files. Never point at another bundle's files.
- The canonical bundle lists the variant in `relations.variants`; the variant
  sets `relations.parent` to the canonical ID. Both directions are required.
- Variants must differ in a way the `title`, `summary` or `notes` states, such as
  resolution, palette, or a clean versus damaged state.
- Retiring a variant means leaving it in place with a note; deletion is a human
  decision.

## Moves

`catalog/moves.jsonl` is append-only. One JSON object per line:

```json
{"id": "IMG-TILE-000001", "from": "assets/image/tile/000001-mossy-stone", "to": "assets/image/texture/000001-mossy-stone", "at": "2026-11-20", "reason": "role corrected to texture"}
```

After a move, update `catalog/index.jsonl`, the facet counts, and any collection
that references the bundle. The ID does not change.

## Extension rules

- New tag namespace: use it immediately, then document it in
  `catalog/facets/_proposed.md` with its values and counts.
- New role: create the directory with a `.gitkeep` while empty, then add a line
  to the facet that governs that role.
- New kind: add the kind directory, an abbreviation above, a row in
  `catalog/overview.md`, and a `technical` block in this file. New kinds are rare
  and need a human decision first.
- Never add a required key to `asset.json` without bumping `schema`.
