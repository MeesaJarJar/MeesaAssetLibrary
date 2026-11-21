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

## Quick start

1. Read `AGENTS.md` for the navigation contract.
2. Search `catalog/index.jsonl` with `rg` to shortlist IDs.
3. Read the bundle's `asset.md` before opening any original file.
4. Validate with `node scripts/check-library.mjs`.
5. Browse the generated gallery in `gallery/`.

## Tools

| Command | Purpose |
| --- | --- |
| `npm run ingest` | add one file as a complete bundle (see `AGENTS.md`) |
| `npm run gallery` | rebuild `gallery/index.html` from the catalog |
| `npm run check` | verify IDs, hashes, sizes, previews and index integrity |
| `npm run serve` | serve the repo at `http://localhost:4173` for browsing |
| `node mcp/test.mjs` | smoke-test the MCP server |

The MCP server in `mcp/` exposes `search_assets`, `get_asset` and
`list_taxonomy` to any MCP client. See `mcp/README.md` for Claude Desktop and
OpenCode configuration.

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
| `catalog/` | index, facets, collections, move log |
| `scripts/` | single-asset ingest, gallery builder, integrity checker, static server |
| `gallery/` | generated static browser, safe to open from disk |
| `mcp/` | stdio MCP server exposing the catalog to agents |
| `_inbox/` | drop zone for raw dumps, never authoritative |
| `docs/` | schema reference |
