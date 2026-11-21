# AGENTS.md - navigation contract

This repository is a media asset library for game development. It holds finished
images, audio, video, models, fonts, materials and reference docs, plus the
metadata an agent needs to choose between them. It does not hold game source,
shaders, or Unity/Godot project trees.

## 30-second orientation

- One bundle per asset: `assets/<kind>/<role>/<6-digit>-<slug>/`.
- Every bundle has `asset.json` (machine truth), `asset.md` (LLM digest),
  `preview.svg` (cheap thumbnail) and `src/` (originals, often binary).
- `catalog/index.jsonl` is the flat search index: one bundle per line.
- IDs look like `IMG-TILE-000001` and never change.

## Read order

`catalog/overview.md` -> `catalog/facets/*.md` -> `catalog/index.jsonl` ->
`<bundle>/asset.md` -> `<bundle>/preview.svg` -> `<bundle>/src/`

1. Overview: counts, entry points, what exists at all.
2. Facets: the tag vocabulary and how many assets carry each value.
3. Index: filter to a shortlist of IDs and bundle paths.
4. `asset.md`: when to use it, when not to, what it pairs with.
5. `preview.svg`: only when the digest leaves a visual question open.
6. `src/`: only when a pipeline must process the original. Never load a binary
   original into context to "look at it".

## Search recipes

Run from the repository root. Paths and tags are case-sensitive.

```sh
rg '"kind":"image"' catalog/index.jsonl                    # all images
rg '"role":"tile"' catalog/index.jsonl                     # all tiles
rg '"subject:environment/stone"' catalog/index.jsonl       # by subject tag
rg '"use:tileset"' catalog/index.jsonl | rg '"palette:mossy-green"'
rg -i 'cobblestone' catalog/index.jsonl                    # free text
rg 'IMG-TILE-000001' catalog/index.jsonl                   # one asset by ID
rg --files assets/audio/sfx                                # bundles on disk
```

Combine `rg` with `jq -c 'select(...)'` when you need structured output. Treat a
tag match as a candidate, not a decision: confirm with `asset.md`.

## Add an asset (checklist)

1. Choose `kind` and `role`. If the role directory does not exist, add it and a
   line to the matching facet.
2. Allocate the next ID: highest 6-digit sequence anywhere in the catalog plus
   one. Never reuse or renumber an ID.
3. Create `assets/<kind>/<role>/<6-digit>-<slug>/` with a `src/` subdirectory.
   Use a lowercase hyphenated slug that describes the asset.
4. Copy originals into `src/`. Do not edit, overwrite or delete an existing
   bundle's files.
5. Compute the byte size and SHA-256 of every file in `src/`.
6. Write `asset.json` per `docs/SCHEMA.md`. The summary must say when to use the
   asset, not just what it is.
7. Write `asset.md`: 3-8 lines, use/avoid guidance, and IDs of related assets.
8. Write `preview.svg`: self-contained, no external references, cheap to render.
9. Add one line to `catalog/index.jsonl` with the exact key set and order in
   `docs/SCHEMA.md`.
10. Add the asset to a collection file if it belongs to one.
11. Run `node scripts/check-library.mjs` and `node scripts/build-gallery.mjs`.

## Token discipline

- Never open binary originals (wav, png, glb, mp4, ttf). Read `asset.md` first.
- Open `preview.svg` only when the summary cannot answer the question.
- Prefer `rg` on `catalog/index.jsonl` over walking the tree.
- Read only the facet files for namespaces you actually filter on.
- Summaries must describe *when to use* the asset, including the cases where it
  is the wrong choice, so the next agent can decide without pixels.

## Immutability

- IDs never change, even if the title or role wording changes.
- Bundles never move silently. Record every move in `catalog/moves.jsonl` with
  `id`, `from`, `to`, `at` and `reason`, then update the index.
- Never rewrite `src/` bytes in place; publish a new bundle or a variant.
- Deleting a bundle requires an explicit human decision; agents must not.

## Extension rules

- New tag namespace: just use `namespace:value`, then note the namespace and its
  values in `catalog/facets/_proposed.md`.
- New role: add the directory, its `.gitkeep` while empty, and a line in the
  facet that governs it.
- New kind: add the kind directory, an ID abbreviation, a row in
  `catalog/overview.md` and a `technical` block in `docs/SCHEMA.md`.
- Never rename or delete an existing tag value; append new ones.

## Validation

```sh
node scripts/check-library.mjs    # schema, hashes, index and preview checks
node scripts/build-gallery.mjs    # regenerate the static gallery
```

If either script is missing, validate by hand against `docs/SCHEMA.md` and say
so in your report.
