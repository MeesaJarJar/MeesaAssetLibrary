# Catalog Overview

Snapshot of the library. Counts cover bundles currently on disk. The index is
maintained by hand; rebuild the browsable gallery with
`node scripts/build-gallery.mjs` after adding or moving assets.

## Bundles by kind

| Kind | Directory | Bundles | Notes |
| --- | --- | --- | --- |
| image | `assets/image/` | 3 | tiles, concept art, icon |
| audio | `assets/audio/` | 1 | UI sfx |
| doc | `assets/doc/` | 1 | palette reference |
| model | `assets/model/` | 0 | reserved roles only |
| video | `assets/video/` | 0 | reserved roles only |
| font | `assets/font/` | 0 | reserved roles only |
| material | `assets/material/` | 0 | reserved roles only |
| project | `assets/project/` | 0 | engine export bundles |
| other | `assets/other/` | 0 | uncategorised, use sparingly |

Total: 5 bundles.

## Entry points

| File | Use it for |
| --- | --- |
| `AGENTS.md` | navigation contract, read order, add-asset checklist |
| `docs/SCHEMA.md` | every key, ID rule, variant and extension rule |
| `catalog/index.jsonl` | flat search index, one bundle per line |
| `catalog/facets/` | tag vocabulary and counts |
| `catalog/collections/` | curated sets that share a purpose |
| `catalog/moves.jsonl` | append-only history of bundle moves |

## How to search

Start broad with the index, narrow with tags, then confirm with the digest.

```sh
rg '"kind":"image"' catalog/index.jsonl
rg '"role":"tile"' catalog/index.jsonl
rg '"subject:environment/stone"' catalog/index.jsonl
rg '"use:tileset"' catalog/index.jsonl | rg '"palette:mossy-green"'
rg -i 'potion' catalog/index.jsonl
```

Or list bundles directly:

```sh
rg --files assets/image/tile
```

To read one asset, open `assets/<kind>/<role>/<id-suffix>/asset.md` first. The
JSON in the bundle is the authoritative record; the index line is a projection
of it. If they disagree, trust `asset.json` and regenerate the index.

## Current themes

The starter set is a coherent mossy-forest / ruined-stone slice: one seamless
floor tile, one mood plate, one HUD icon, one UI sound and the palette that ties
them together. All five are in the `demo-starter` collection.
