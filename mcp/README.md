# Meesa Asset Library MCP server

A zero-dependency MCP server that exposes the Meesa media asset catalog to LLM
agents over stdio. It reads the published search catalog
(`catalog/search-index.json`, `catalog/concepts.json`,
`catalog/embeddings.json` and the embedding `.bin` files), the per-asset
`asset.json` metadata, the `asset.md` digests, and the catalog taxonomy.

The server speaks newline-delimited JSON-RPC 2.0 on stdin/stdout. It never
writes diagnostics to stdout; logs go to stderr.

## Requirements

- Node.js 18 or newer (`node --version`)
- Either the published catalog URL or a local catalog. If both are missing the
  server still starts; data tools return a clear error instead of crashing.

The library root defaults to the parent directory of this `mcp/` directory.
Override it with `MEESA_LIBRARY_ROOT`.

## Catalog sources

### Remote (default)

`MEESA_LIBRARY_URL` sets the base URL of the published site. It defaults to
`https://meesajarjar.github.io/MeesaAssetLibrary/`.

When remote loading is enabled, the server fetches:

- `catalog/search-index.json`
- `catalog/concepts.json`
- `catalog/embeddings.json`
- the two `.bin` files named by the embeddings manifest

The parsed catalog and its `Float32Array` embedding bins are cached in memory.
After five minutes the next request refreshes them with `If-None-Match` /
`If-Modified-Since` conditional requests. A failed refresh falls back to the
local root when it contains `catalog/search-index.json` or
`catalog/index.jsonl`; otherwise search tools return an error that names both
the remote failure and the missing local catalog. Failures are remembered for
five minutes so an offline server does not stall every request.

Set `MEESA_LIBRARY_URL` to an empty string to disable remote loading entirely.

### Local

The local root is read from `catalog/search-index.json`, `catalog/concepts.json`
and `catalog/embeddings.json`. The JSON and bins are reloaded automatically when
their mtime or size changes. If `search-index.json` is absent, the server falls
back to `catalog/index.jsonl` with keyword-only scoring, so older libraries and
partially generated catalogs keep working.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `MEESA_LIBRARY_ROOT` | parent of `mcp/` | Local library root, used for assets, taxonomy and fallback search data. |
| `MEESA_LIBRARY_URL` | `https://meesajarjar.github.io/MeesaAssetLibrary/` | Published base URL. Empty string disables remote catalog loading. |
| `MEESA_ISSUE_REPO` | `meesajarjar/MeesaAssetLibrary` | GitHub `owner/repo` used by `request_asset`. |

## Tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `search_assets` | `query?`, `kind?`, `tags?`, `limit?` | Compact JSON array: `id`, `title`, `kind`, `role`, `summary`, `tags`, `family`, `license`, `contributor`, `score`, `matchedConcepts` |
| `get_asset` | `id` (required) | JSON object with `id`, `dir`, the full `asset` metadata, the raw `markdown` of `asset.md`, and the `searchIndex` entry. Remote metadata 404s return `metadataUnavailable: true` and a note instead of an error. |
| `list_taxonomy` | none | JSON object with `facets`, `collections`, `families`, `topConcepts`, `conceptCount` and `catalogSource` |
| `checkout_pack` | `ids` (required), `outDir?`, `includePreview?`, `acknowledgeRestricted?` | JSON object with `outDir`, `fileCount`, `bytes`, per-file `verification`, `failures` and `allVerified` |
| `request_asset` | `query` (required), `note?` | JSON object with a prefilled GitHub issue `url`; nothing is opened or posted |

### search_assets

Every tag supplied in `tags` must match, in `namespace:value` form. `kind` is an
exact kind filter. `limit` defaults to 20 and is capped at 100.

Scoring uses media vectors only:

- Concept matching by concept `id`, `label` and `synonyms`. A concept matches
  when a query token is one of its terms, or when a multiword term appears in
  the query.
- Query vectors are the normalized mean of the matched concepts' `clip` and
  `clap` text vectors.
- Concept `modality` is respected: `audio` concepts search audio assets only,
  `visual` concepts search visual assets only, and `both` searches both. A query
  with no matched concept may search either modality.
- Visual assets (image, video, model and the rest) score with `clipImage`
  cosine and must reach 0.22. Audio assets score with `clapAudio` cosine and
  must reach 0.10.
- `clipText` and `clapText` are never used for scoring. Text-to-text CLIP/CLAP
  similarity is anisotropic and produces false positives.
- The final score is `0.55 * semantic + 0.45 * keyword`. When no media vector
  exists or the cosine is below the floor, the semantic score is absent and the
  asset falls back to its keyword score.
- Keyword fields are title (which includes the id) 5, tags 4, keywords 3,
  summary 2, prompt 2, and role (which includes the kind) 1. Each term's field
  weights are capped at 5 and the total is divided by `5 * term count`, so the
  keyword score is always in 0..1.

Keyword matches still return even when the semantic score is below the floor or
the concept is unknown; the modality restriction above still applies when a
concept matched. Results combine assets carrying every term, then assets
carrying any term, with assets that pass the semantic floor. A query that
matches neither returns an empty JSON array. When that happens and a query was
supplied, `search_assets` adds a second text content block with a prefilled
`request_asset` issue URL; the first block remains `[]` so JSON parsing is
unchanged. Quoted phrases are matched as contiguous text.

### get_asset

Always returns the catalog `searchIndex` entry, read from the active search
catalog.

When the active source is remote, `<MEESA_LIBRARY_URL>/<dir>/asset.json` and
`<MEESA_LIBRARY_URL>/<dir>/asset.md` are fetched over HTTP with each path
segment URL-encoded. Results are cached per asset id for five minutes. A
missing or unreadable `asset.md` is reported as `markdownError` without failing
the call. If remote `asset.json` returns HTTP 404, the response contains
`asset: null`, `markdown: null`, `metadataUnavailable: true`, a `note` naming
the URL, and the `searchIndex` entry; it is not an error.

When the active source is local, `<libraryRoot>/<dir>/asset.json` and
`<dir>/asset.md` are read from disk as before.

### list_taxonomy

Reads `catalog/facets/*.md` and `catalog/collections/*.md`, then adds asset
families with counts and the most used concepts from the search catalog.

### checkout_pack

Downloads each asset's `file` and, when `includePreview` is true (the default),
its `preview`. Files are fetched from `MEESA_LIBRARY_URL` first and from the
local root as a fallback.

Every downloaded payload file is hashed with SHA-256. The expected primary hash
comes from the search-index entry, or from `asset.json`'s `files[]` block when
the search index has no hash (the deployed library leaves `sha256: null` for
some assets). A mismatch removes the file and adds a failure. Previews without a
catalog hash record the computed hash and are marked verified; a primary file
with no hash in either source is marked `unverified` and makes the pack fail
verification.

The layout is:

```
<pack>/
  pack.json
  CREDITS.md
  LICENSE.txt
  README.md
  assets/<id>/<filename>
  assets/<id>/<preview filename>   (optional)
```

`pack.json` matches the gallery pack shape and keeps the richer verification
blocks:

```json
{
  "version": 1,
  "name": "mdl-prop-000012",
  "restrictedAcknowledged": true,
  "assets": [
    {
      "sha256": "<primary hash>",
      "path": "assets/<id>/<primary file>",
      "files": [
        {
          "path": "assets/<id>/<file>",
          "sha256": "<hash>",
          "expected": "<catalog hash or null>",
          "verified": true,
          "status": "verified",
          "kind": "file",
          "source": "remote"
        }
      ]
    }
  ],
  "totals": {
    "assets": 1,
    "files": 2,
    "bytes": 2263870,
    "verified": true
  },
  "verification": { "allVerified": true, "failures": [] }
}
```

`totals.files` counts only asset payload files (primary and preview); it does
not include `pack.json`, `CREDITS.md`, `LICENSE.txt`, or `README.md`. The tool
result also reports `fileCount` (all files on disk, including metadata) and
`payloadFileCount` (the same count as `totals.files`).

`outDir` defaults to a new directory under the OS temp directory. Every id is
validated against `^[A-Za-z0-9][A-Za-z0-9._-]*$`, and `outDir` or asset paths
containing `..`, absolute paths, drive-prefixed asset paths, Windows-reserved
file names, or characters such as `<>:"|?*` are refused.

Assets licensed `LicenseRef-All-Rights-Reserved` make the tool refuse the whole
pack unless `acknowledgeRestricted: true` is passed. The acknowledgement flag
reflects the caller's argument even when the pack contains no restricted asset,
and it is written to `pack.json`, `LICENSE.txt`, and the tool result.

### request_asset

Builds `https://github.com/<MEESA_ISSUE_REPO>/issues/new` with a title and body
containing the query and optional note. It is a link only; the server does not
open a browser or call GitHub.

## Run

```powershell
node D:\repos\MeesaAssetLibrary\mcp\server.mjs
```

The process is normally started by an MCP client, not by hand. Set
`MEESA_LIBRARY_ROOT` when the catalog lives somewhere other than the parent of
`mcp/`:

```powershell
$env:MEESA_LIBRARY_ROOT = "D:\repos\MeesaAssetLibrary"
node D:\repos\MeesaAssetLibrary\mcp\server.mjs
```

To test offline against the local catalog only:

```powershell
$env:MEESA_LIBRARY_URL = ""
node D:\repos\MeesaAssetLibrary\mcp\server.mjs
```

## Test

From the repository root:

```powershell
node mcp/test.mjs
```

The default mode is self-contained and does not touch the real catalog. It
builds a temporary fixture library with four assets (sword, stone texture,
forest ambience, copper pot), 512-dimension crafted embedding vectors and five
concepts (sword, stone, ambience, dog, music), then runs:

1. 26 stdio checks: protocol, sword and stone ranking, media-only concept
   synonyms, CLAP audio matching, audio-only modality gating, `dog` and `music`
   misses with request hints, blade/weapon keyword fallback, `request_asset`,
   `get_asset`, taxonomy, filters, pack checkout and payload-only totals,
   restricted-licence refusal and acknowledgement, `../` rejection, previews,
   corrupted local payload verification, index reload, malformed JSON and clean
   EOF.
2. 9 HTTP checks against a temporary static server: identical search results,
   cache verification by request count, local fallback on a remote failure, the
   clear error when neither source exists, remote pack checkout with SHA-256
   verification, corrupted remote payload verification, `get_asset`, remote-only
   `get_asset` metadata fetching with caching and a 404 fallback, and clean EOF.

The run prints `Summary: 35 passed, 0 failed, 0 skipped, 365 assertions`.

Other modes:

```powershell
node mcp/test.mjs --fixture   # alias for the default fixture mode
node mcp/test.mjs --live      # read-only checks against the real library; remote loading disabled
```

`--live` skips its search checks when the repository has no catalog index. When
`catalog/search-index.json` and `catalog/embeddings.json` are both present, it
also verifies the current library expectations: `sword`, `blade` and `weapon`
rank the model first; `stone` returns a video and a texture image; `ambience`
returns audio only; and `music`/`dog` return an empty result with a request
hint.

## Claude Desktop

Add this to `%APPDATA%\Claude\claude_desktop_config.json`, then restart Claude
Desktop:

```json
{
  "mcpServers": {
    "meesa-asset-library": {
      "command": "node",
      "args": ["D:\\repos\\MeesaAssetLibrary\\mcp\\server.mjs"],
      "env": {
        "MEESA_LIBRARY_ROOT": "D:\\repos\\MeesaAssetLibrary"
      }
    }
  }
}
```

The `env` entry is optional when the default root is correct. Remote loading is
on by default; add `"MEESA_LIBRARY_URL": ""` to the `env` object to force local
only.

## OpenCode

Current OpenCode configuration (V2) nests MCP server definitions under
`mcp.servers`. Add this to `opencode.json` or `opencode.jsonc`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "meesa-asset-library": {
        "type": "local",
        "command": ["node", "D:\\repos\\MeesaAssetLibrary\\mcp\\server.mjs"],
        "environment": {
          "MEESA_LIBRARY_ROOT": "D:\\repos\\MeesaAssetLibrary"
        }
      }
    }
  }
}
```

The `environment` entry is optional. OpenCode exposes the tools as
`meesa-asset-library_search_assets`, `meesa-asset-library_get_asset`,
`meesa-asset-library_list_taxonomy`, `meesa-asset-library_checkout_pack` and
`meesa-asset-library_request_asset` (normalized by the client). In older V1
configs, server entries lived directly under `mcp`; V2 requires the
`mcp.servers` nesting shown above.

## Windows paths in JSON

JSON treats a backslash as an escape character. Use double backslashes in
absolute Windows paths, as shown above. Forward slashes also work with Node,
for example `"D:/repos/MeesaAssetLibrary/mcp/server.mjs"`.

## Protocol notes

- Supported MCP protocol version: `2024-11-05`.
- Supported methods: `initialize`, `notifications/initialized`, `ping`,
  `tools/list`, and `tools/call`.
- Unknown methods return JSON-RPC error `-32601`; malformed JSON lines return
  `-32700` and do not stop the server.
- Tool failures are returned as a normal tool result with `isError: true` and a
  readable message.
- Input lines may end in LF or CRLF, and a UTF-8 BOM is ignored.
- Requests are processed in arrival order. A stdin EOF with a partial final
  line still processes that line, then the process exits cleanly.
- All network reads use `fetch` with a 30 second timeout. Errors name the URL
  and, for timeouts, the limit.
- The legacy `catalog/index.jsonl` is still supported and reloaded when its mtime
  or size changes.

## Limitations

- Search vectors come from the precomputed concept embeddings. The server does
  not run a CLIP or CLAP text encoder, so a query with no concept match is
  keyword-only.
- Media-vector floors deliberately drop weak semantic-only matches. Text
  vectors are not scored, because text-to-text cosine is anisotropic.
- `checkout_pack` resolves the primary hash from the search index or
  `asset.json`'s `files[]`. A primary with no hash in either source is written
  but marked `unverified` and makes `allVerified` false. Previews normally have
  no catalog hash; their computed SHA-256 is recorded and they are marked
  verified.
- An existing non-empty `outDir` is reused; known pack files are overwritten and
  unrelated files are left alone, so the returned `fileCount` can exceed the
  pack's own files if the directory was not empty. `totals.files` still counts
  only the payload files written by this pack.
