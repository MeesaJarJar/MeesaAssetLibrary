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

The first entry is the primary deliverable. The index mirrors its `path` and
`mime` in the `file` and `mime` keys.

### source

| Key | Type | Notes |
| --- | --- | --- |
| `origin` | string | `original`, `generated`, `captured`, `third-party`, or `community` for bundles under `community/` |
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

## catalog/index.jsonl

One JSON object per line, one line per bundle. UTF-8, LF, no trailing spaces.
Keys are required and appear in exactly this order:

| Key | Type | Notes |
| --- | --- | --- |
| `id` | string | `KIND-ROLE-NNNNNN`, matches `asset.json` |
| `kind` | string | matches `asset.json` |
| `role` | string | matches `asset.json` |
| `title` | string | short human-readable name |
| `summary` | string | when to use the asset, not just what it is |
| `tags` | string[] | the same namespace:value tags as `asset.json` |
| `preview` | string | bundle-relative preview filename, e.g. `preview.svg` |
| `file` | string | repo-relative forward-slash path to the primary deliverable; equals `<dir>/<files[0].path>` |
| `mime` | string | MIME type of `file`; equals `asset.json.files[0].mime` |
| `dir` | string | repo-relative bundle directory |
| `bytes` | integer | exact size of the primary file on disk |
| `added` | string | ISO date `YYYY-MM-DD` the bundle entered the library |

`preview` is bundle-relative, while `file` and `dir` are repo-relative. A
consumer can resolve `file` directly from the repository root.

```json
{"id":"IMG-TILE-000001","kind":"image","role":"tile","title":"Mossy Stone Tile","summary":"Seamless 64x64 top-down cobblestone with cold grey-green stones and moss in the joints; low contrast keeps repeated ground tiles clean.","tags":["subject:environment/stone","style:pixel-art","use:tileset","palette:mossy-green","format:png","engine:any"],"preview":"preview.svg","file":"assets/image/tile/000001-mossy-stone/src/mossy-stone.png","mime":"image/png","dir":"assets/image/tile/000001-mossy-stone","bytes":5151,"added":"2026-11-20"}
```

Entries written before the `file` and `mime` keys existed are legacy.
`check-library.mjs` accepts a legacy entry with exactly one warning. New ingest
output always carries both keys, and a legacy line must be rewritten with them
when it is next edited; an entry with only one of the two keys is an error.

## Community catalog

Community assets are contributed by invited collaborators and form a separate
publication surface. They use the same bundle layout and metadata rules as
curated assets, but they live under `community/` and are indexed in
`catalog/community.jsonl`; they are never mixed into `assets/` or
`catalog/index.jsonl`.

```
community/<kind>/<role>/<6-digit>-<slug>/
  asset.json    schema 1 plus contributor and license
  asset.md      LLM digest, same rules as curated bundles
  preview.<ext> cheap thumbnail
  src/          originals, one or more files
```

`catalog/community.jsonl` has one JSON object per line, one line per bundle.
Keys are required and appear in exactly this order:

| Key | Type | Notes |
| --- | --- | --- |
| `id` | string | `COM-KIND-NNNNNN`, e.g. `COM-IMG-000001`; matches `asset.json` |
| `kind` | string | matches `asset.json` |
| `role` | string | matches `asset.json` |
| `title` | string | short human-readable name |
| `summary` | string | when to use the asset, not just what it is |
| `tags` | string[] | the same namespace:value tags as `asset.json` |
| `preview` | string | bundle-relative preview filename |
| `file` | string | repo-relative path to the primary deliverable; equals `<dir>/<files[0].path>` |
| `mime` | string | MIME type of `file`; equals `asset.json.files[0].mime` |
| `dir` | string | repo-relative bundle directory; must start with `community/` |
| `bytes` | integer | exact size of the primary file on disk |
| `sha256` | string | 64-character hex digest of the primary file |
| `added` | string | ISO date `YYYY-MM-DD` the bundle entered the library |
| `contributor` | string | GitHub login of the collaborator; required and non-empty |
| `license` | string | license identifier; required and non-empty |

`preview` is bundle-relative, while `file` and `dir` are repo-relative. The
catalog repeats `contributor` and `license` so a consumer can attribute an asset
without opening the bundle.

```json
{"id":"COM-IMG-000001","kind":"image","role":"concept","title":"Moss Gate","summary":"...","tags":["subject:structure/gate","style:painterly","use:concept-art","format:png","engine:any"],"preview":"preview.webp","file":"community/image/concept/000001-moss-gate/src/moss-gate.png","mime":"image/png","dir":"community/image/concept/000001-moss-gate","bytes":123456,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","added":"2026-11-21","contributor":"octocat","license":"CC-BY-4.0"}
```

### Community asset.json

A community `asset.json` is schema 1 plus two required top-level keys:

```json
"contributor": {"login": "octocat", "url": "https://github.com/octocat"},
"license": "CC-BY-4.0"
```

`contributor.url` is the collaborator's GitHub profile. `source.origin` is
`"community"`. The contributor and license values must agree with the catalog
line, and `files[].sha256` is mandatory for every community file.

### Community IDs

- Format: `COM-KIND-NNNNNN`, for example `COM-IMG-000001`, using the same kind
  abbreviations as curated IDs.
- The six-digit sequence is independent of the curated sequence: community
  bundles start at `000001` and never consume a curated number.
- The six digits must match the directory prefix.
- IDs never change and sequences are never reused.
- Community bundles never move into `assets/`, and curated bundles never move
  into `community/`. The two trees and their catalogs stay separate.

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
