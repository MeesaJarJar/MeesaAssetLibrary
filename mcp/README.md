# Meesa Asset Library MCP server

A zero-dependency MCP server that exposes the local media asset catalog to LLM
agents over stdio. It reads `catalog/index.jsonl`, the per-asset `asset.json`
metadata, the `asset.md` digests, and the catalog taxonomy.

The server speaks newline-delimited JSON-RPC 2.0 on stdin/stdout. It never
writes diagnostics to stdout; logs go to stderr.

## Requirements

- Node.js 18 or newer (`node --version`)
- A populated `catalog/index.jsonl`. If the catalog is missing or empty, the
  server still starts and returns empty search results; it does not crash.

The library root defaults to the parent directory of this `mcp/` directory.
Override it with the `MEESA_LIBRARY_ROOT` environment variable.

## Tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `search_assets` | `query?`, `kind?`, `tags?`, `limit?` | Compact JSON array of matching assets: `id`, `title`, `kind`, `role`, `summary`, `tags`, `dir` |
| `get_asset` | `id` (required) | JSON object with `id`, `dir`, the full `asset` metadata object, and the raw `markdown` text of `asset.md` |
| `list_taxonomy` | none | JSON object with `facets` and `collections` arrays |

`search_assets` uses token scoring over id, title, summary, tags, and role.
Every tag supplied in `tags` (in `namespace:value` form) must match. `limit`
defaults to 20 and is capped at 100.

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

## Test

From the repository root:

```powershell
node mcp/test.mjs
```

If `catalog/index.jsonl` is missing or empty, the data-dependent checks print a
`SKIP` message and the protocol checks still run. To exercise every check
against a temporary generated fixture without touching the real catalog:

```powershell
node mcp/test.mjs --fixture
```

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

The `env` entry is optional when the default root is correct.

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
`meesa-asset-library_search_assets`, `meesa-asset-library_get_asset`, and
`meesa-asset-library_list_taxonomy` (normalized by the client). In older V1
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
- The catalog index is cached in memory and reloaded automatically when its
  mtime or size changes.
