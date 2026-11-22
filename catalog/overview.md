# Catalog Overview

Snapshot of the library. Counts cover bundles currently on disk. The index is
maintained by hand; rebuild the browsable gallery with
`node scripts/build-gallery.mjs` after adding or moving assets.

## Bundles by kind

| Kind | Directory | Bundles | Notes |
| --- | --- | --- | --- |
| image | `assets/image/` | 8 | seamless stone texture + three dog concepts |
| audio | `assets/audio/` | 3 | ambient forest loop + dog bark |
| doc | `assets/doc/` | 0 | reserved roles only |
| model | `assets/model/` | 2 | sword totem + dog splats |
| video | `assets/video/` | 2 | two camera loops |
| font | `assets/font/` | 0 | reserved roles only |
| material | `assets/material/` | 0 | reserved roles only |
| project | `assets/project/` | 0 | engine export bundles |
| other | `assets/other/` | 0 | uncategorised, use sparingly |

Total: 15 bundles.

## Entry points

| File | Use it for |
| --- | --- |
| `AGENTS.md` | navigation contract, read order, add-asset checklist |
| `docs/SCHEMA.md` | every key, ID rule, variant and extension rule |
| `catalog/index.jsonl` | flat search index, one bundle per line |
| `catalog/facets/` | tag vocabulary and counts |
| `catalog/collections/` | curated sets that share a purpose |
| `catalog/moves.jsonl` | append-only history of bundle moves |
| `catalog/retired.jsonl` | append-only log of deleted IDs; IDs are never reused |

## How to search

Start broad with the index, narrow with tags, then confirm with the digest.

```sh
rg '"kind":"image"' catalog/index.jsonl
rg '"role":"texture"' catalog/index.jsonl
rg '"subject:environment/stone"' catalog/index.jsonl
rg '"use:tileset"' catalog/index.jsonl | rg '"palette:mossy-green"'
rg -i 'sword' catalog/index.jsonl
```

Or list bundles directly:

```sh
rg --files assets/image/texture
```

To read one asset, open `assets/<kind>/<role>/<id-suffix>/asset.md` first. The
JSON in the bundle is the authoritative record; the index line is a projection
of it. If they disagree, trust `asset.json` and regenerate the index.

## Current themes

The catalog now has two coherent slices. The mossy-stone slice holds a seamless
tile, a synthesized forest ambience loop, a camera drift rendered from that tile
and a Gaussian splat sword totem. The dog slice is the first cross-modal test
set: three stylized dog concepts sharing the `dog` family, a generated dog bark,
a camera loop over the golden retriever, and a 65k-gaussian dog splat. Searching
`dog` should return all six, with the three images collapsed into one family
card.
