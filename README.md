# Meesa Asset Library

**Live gallery:** https://meesajarjar.github.io/MeesaAssetLibrary/

A media asset library for game development, built for LLM agents first and
humans second. Every asset is a self-describing bundle: machine-readable
metadata, a short digest written for agents, a cheap thumbnail, and the
original files.

## What belongs here

- Game-ready and reference media: images, audio, video, 3D models, fonts,
  materials, palettes and design documents.
- Engine-ready export bundles: prepared packages for Godot, Unity or other
  targets under `assets/project/`.
- The metadata that explains what each asset is and when to use it.

## What does not belong here

- Game source code, shaders, or Unity/Godot/Unreal project trees.
- Build output, caches, `node_modules`, secrets, or unlicensed third-party files.
- Raw dumps and scratch captures. Those go to `_inbox/` and are never
  authoritative until promoted into a bundle.

## Community uploads

Invited collaborators publish community assets directly through the
[contribute page](contribute/). Community bundles live under `community/` and
are indexed separately in `catalog/community.jsonl`; they appear in the gallery
with a Community badge and contributor attribution, and never mix with the
curated `assets/` tree.

## Asset requests

The request queue at
[meesajarjar.github.io/MeesaAssetLibrary/queue](https://meesajarjar.github.io/MeesaAssetLibrary/queue/)
records demand for assets the library does not have. When a gallery search
returns nothing, **Submit to queue** opens the queue with the query prefilled.
Invited collaborators append one JSON line per request to
`catalog/asset-requests.jsonl`; the page aggregates totals, requesters and notes
at read time. A request is not an asset: nothing is ingested into `assets/`, and
maintainers decide what to add next.

Submitting needs a fine-grained personal access token:

1. Open [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new).
2. Set **Repository access** to **Only select repositories**, then choose
   **MeesaAssetLibrary**.
3. Under **Permissions**, set **Contents** to **Read and write**. No other
   permission is required.
4. Connect the token on the queue page. It stays in that tab's
   `sessionStorage`, is sent only to `api.github.com`, and is removed by
   **Sign out**.

The queue checks each query against `catalog/words.txt`, a 10,000-word English
frequency list from
[first20hours/google-10000-english](https://github.com/first20hours/google-10000-english),
derived from Google's Trillion Word Corpus and Peter Norvig's frequency list.
A small embedded genre vocabulary (for example `treant`, `goblin`, `tileset`,
`mushroom`) covers game terms missing from that list. The upstream data is
distributed under the LDC license for educational and personal/research use;
read the upstream `LICENSE.md` before commercial use.

## Pack console

Maintainers turn queue demand into published assets from a local operator
console. It is not deployed to Pages. From the repository root:

```sh
node admin/server.mjs
```

Open `http://127.0.0.1:4310/`. The server binds loopback only; use `--port` or
`ADMIN_PORT` to change the port, and `admin/.env.local` or environment variables
for ComfyUI, Ollama and the optional local admin token.

The P0 workflow is one queued request to one small pack:

1. Pick an open or planned request and read the queue demand (requests,
   requesters, first and last ask).
2. Review the generated plan, then set the per-group counts: image, audio,
   video and model, each 0-5, with at least one asset total. P0 is one image and
   one four-second audio; video and model stay at 0.
3. Generate on local ComfyUI and inspect every result before publishing
   anything.
4. Generate ingests the bundles, marks the request `fulfilled` with the new
   asset IDs, and rebuilds embeddings/search/gallery. Review `git diff`.
5. Publish commits and pushes the reviewed changes. The public queue then shows
   the new status and links the request to `../gallery/#q=<query>`.

The console is local-only because it needs ComfyUI, and optionally Ollama for
planning. The end-to-end operator guide, status meanings and limits are in
`docs/PACK-CONSOLE.md`.

## Semantic refresh

`.github/workflows/embed-refresh.yml` rebuilds the semantic artifacts every day
at 04:17 UTC and on manual dispatch: **Actions** -> **Refresh semantic
embeddings** -> **Run workflow**. It runs `python scripts/embed.py` and
`node scripts/build-search-index.mjs`, then commits and pushes only
`catalog/embeddings.json`, the two embedding bins, `catalog/concepts.json` and
`catalog/search-index.json` when they changed. The message is
`Refresh semantic embeddings`; the job then dispatches the Pages workflow so the
site rebuilds with the new artifacts (a `GITHUB_TOKEN` push alone does not
trigger other workflows).

This makes new community uploads semantically searchable within a day. The pack
console embeds immediately when it publishes, so the daily job is a safety net,
not the primary path. `.github/workflows/embed.yml` is the older manual,
no-commit variant that fails when the generated diff is not empty.

## Quick start

1. Read `AGENTS.md` for the navigation contract.
2. Search `catalog/index.jsonl` with `rg`, or use the gallery search for
   natural-language queries, to shortlist IDs.
3. Read the bundle's `asset.md` before opening any original file.
4. Validate with `node scripts/check-library.mjs`.
5. Browse the generated gallery in `gallery/`.

## Tools

| Command | Purpose |
| --- | --- |
| `npm run ingest` | add one file as a complete bundle (see `AGENTS.md`) |
| `npm run index` | rebuild `catalog/search-index.json` from the catalogs and embeddings |
| `npm run embed` | regenerate the semantic embedding bins (Python maintenance task) |
| `npm run gallery` | rebuild the search index, then `gallery/index.html` |
| `npm run check` | verify IDs, hashes, sizes, previews and index integrity |
| `npm run serve` | serve the repo at `http://localhost:4173` for browsing |
| `node mcp/test.mjs` | smoke-test the MCP server |

`npm run embed` invokes `python` from `PATH`. If that is not the right
interpreter, run the script directly with the portable path for your machine:
`python3 scripts/embed.py` on Linux/macOS, `py -3 scripts/embed.py` on Windows,
or an activated virtual environment such as `.venv/Scripts/python.exe
scripts/embed.py`. The dependencies are CPU Torch, `transformers`,
`soundfile` and `pillow`; `.github/workflows/embed-refresh.yml` installs the
same set for the daily refresh.

## Search and packs

`catalog/search-index.json` is the generated search corpus. It adds normalized
text, `keywords`, `prompt` and `family` to each catalog record; the gallery and
the MCP server read it for keyword and semantic ranking. `catalog/concepts.json`
holds the concept vocabulary used to expand queries, and the embedding bins are
optional vectors built by `npm run embed`. Rebuild the index after changing
metadata, then rebuild the gallery. `npm run index` expects
`catalog/embeddings.json`; run `npm run embed` first on a checkout that does
not have the embedding artifacts yet. The generated files are disposable; the
JSONL catalogs and bundles remain the source of truth. `docs/SEARCH.md` documents
the concept lexicon and query flow.

Families group related assets and variants. They are advisory: use
`relations.parent` and `relations.variants` for authoritative variant links.

The gallery cart checks output hashes and then builds a downloadable pack. A
pack is a `pack.json` manifest plus the bundles it lists, not a third catalog
and not a copy of the library. Treat a pack as read-only when checking it out,
resolve every listed ID against the catalogs, and keep community contributor
and license metadata attached.

The MCP server in `mcp/` exposes `search_assets`, `get_asset`, `list_taxonomy`
and `checkout_pack` to any MCP client. See `mcp/README.md` for Claude Desktop
and OpenCode configuration.

## Layout

| Directory | Contents |
| --- | --- |
| `assets/image/` | tiles, sprites, textures, icons, UI, concept art, sheets |
| `assets/model/` | props, characters, environments, rigs, animation |
| `assets/audio/` | sfx, music, ambience, voice |
| `assets/video/` | trailers, captures, reference footage |
| `assets/font/` | display, text and mono typefaces |
| `assets/material/` | surface and VFX materials |
| `assets/doc/` | design notes, specs, palettes, tables |
| `assets/project/` | engine export bundles |
| `catalog/` | index, facets, collections, move log, generated search index and embedding bins |
| `scripts/` | ingest, search index builder, embedding job, gallery builder, integrity checker, static server |
| `gallery/` | generated static browser, safe to open from disk |
| `queue/` | public asset-request queue page |
| `admin/` | local pack console, loopback only and never deployed |
| `mcp/` | stdio MCP server exposing the catalog to agents |
| `_inbox/` | drop zone for raw dumps, never authoritative |
| `docs/` | schema, semantic search and pack-console reference |
