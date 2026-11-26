# Pack Console

A local, zero-dependency console for turning one public queue request into a
reviewed asset pack.

It reads the request queue, asks Ollama for a four-group plan (image, audio,
video, model), lets the owner edit every group count and prompt, starts a
background ComfyUI generation job, streams progress, and publishes the result
with the local git credentials.

The server binds to `127.0.0.1:4310` only. It serves one page and a small JSON
API. There is no CDN, no framework, no telemetry, and no GitHub token.

## Requirements

- Windows with Node.js 20 or newer.
- Ollama recommended at `OLLAMA_URL` with the configured model pulled. The
  engine falls back to a deterministic plan if the model call fails, but live
  planning is better.
- ComfyUI reachable at `COMFYUI_URL` for real generation.
- `scripts/lib/pack.mjs`, the pack engine. The server starts without it and
  reports `engineReady: false`; the UI shows "Engine not ready" until the file
  exists and the next request reloads it.
- A git checkout with push access to `origin main` for publishing. Publishing
  uses the local git credential or `gh` login through `publishPack`; the
  console never asks for a personal access token.

## Start

```powershell
cd D:\repos\MeesaAssetLibrary
Copy-Item admin\.env.local.example admin\.env.local
# Edit admin\.env.local and set ADMIN_TOKEN to a private value.
npm run admin
```

Equivalent direct command:

```powershell
node admin/server.mjs
```

Open <http://127.0.0.1:4310/>.

Use a different port for a second instance or a smoke test:

```powershell
node admin/server.mjs --port 4311
```

`admin/.env.local` and `admin/jobs.json` are gitignored. Do not commit the real
file.

## Configuration

`admin/.env.local` is parsed without dependencies. An existing process
environment variable wins over the file.

| Key | Default | Purpose |
| --- | --- | --- |
| `ADMIN_TOKEN` | empty | When set, every `/api/*` request needs `Authorization: Bearer <token>`. The UI asks for it and keeps it in `sessionStorage` only. |
| `MEESA_ROOT` | repository root | Checkout that contains `scripts/lib/pack.mjs`, `catalog/`, and `assets/`. |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama base URL used for planning and health. |
| `OLLAMA_MODEL` | `qwen3.5:4b` | Model passed to the engine and shown in the health badge. |
| `COMFYUI_URL` | `http://127.0.0.1:8188` | ComfyUI base URL used for generation and health. |
| `ADMIN_PORT` | `4310` | Listen port. `0` picks a free port, which is useful in tests. |
| `MEESA_MOCK` | unset | `1` swaps in a deterministic mock engine. No network, no writes, no generation. For tests only. |

Generate a token value with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))"
```

## Workflow

1. Pick a request in the left column. Statuses are `open`, `planned`,
   `generating`, `fulfilled`, and `rejected`, plus `failed` when a generation
   ended without usable assets; asset counts and requester counts come from the
   queue and the request status file.
2. Press **Plan with Ollama**. This calls `planPack` and returns a plan. No
   assets are generated.
3. Edit the four group cards. Each group has a count from 0 to 5, one or more
   prompt textareas, title, summary, negative prompt, tags, and keywords. The
   plan JSON preview updates immediately; **Copy plan** copies it.
4. Press **Generate pack** and confirm. The server starts `generatePack` in the
   background and returns a job id. The page polls the job and shows timestamped
   progress lines and stage badges. Keep the tab open while it runs.
5. When the request is `fulfilled` and the checkout has uncommitted changes,
   **Publish** calls `publishPack`, which commits and pushes with your local git
   credentials. The commit hash is shown in the UI.
6. **Reject request** asks for a reason and writes a rejected status through
   `rejectRequest`. Nothing is generated.

The console writes progress in memory only (last 200 lines per job). A server
restart loses job history, but the engine's request status file still records
the outcome.

## API

All API routes are on `127.0.0.1` and require the bearer token when
`ADMIN_TOKEN` is set.

| Method and path | Response |
| --- | --- |
| `GET /api/state` | `{requests, health:{ollama:{ok,model},comfy:{ok}}, engineReady, tokenRequired, repo:{dirty,commit}}`. `engineError` is added when the engine cannot be read. |
| `GET /api/health` | `{ollama:{ok,model}, comfy:{ok}, engineReady}` |
| `POST /api/plan` | Body `{query}`. Returns the plan directly. |
| `POST /api/generate` | Body `{query, plan}`. Returns `{jobId}` and runs in the background. |
| `GET /api/jobs/:id` | `{state, progress:[{at,stage,message}], error, assets}` plus job metadata. |
| `POST /api/publish` | Body `{query}`. Returns `{ok,commit}` only for a fulfilled request with uncommitted changes. |
| `POST /api/reject` | Body `{query, reason}`. Returns `{ok:true}`. |
| `GET /session-info` | `{tokenRequired, mock}`, unauthenticated, so the page can show the token field without sending a failing API request. |

`GET /` serves `admin/index.html`. The `/queue/` and `/gallery/` header links are
repository-relative; use the library's static server (`npm run serve`) or the
deployed site to browse those pages.

## Security

- Binds only to `127.0.0.1`; there is no `0.0.0.0` mode.
- With `ADMIN_TOKEN` set, every `/api/*` call requires an exact bearer token
  compared in constant time. Tokens are never logged and never placed in a URL.
- The UI holds the token in `sessionStorage` for the current tab only. It is not
  stored in `localStorage` or a cookie.
- The server never requests or stores a GitHub token. `publishPack` commits and
  pushes using the local git credential/`gh` login.
- Responses use `no-store`, `nosniff`, `no-referrer`, a restrictive CSP, and
  `frame-ancestors 'none'`.
- All request and plan data is rendered with `textContent`, never `innerHTML`.

## Tests

The test harness lives outside the repository so it cannot affect a real pack.
Playwright is loaded from the global npm install at
`%APPDATA%\npm\node_modules\playwright`.

```powershell
cd C:\Users\meesa\AppData\Local\Temp\opencode\mesa-admin-console
node --test unit.test.mjs
node --test playwright.test.mjs
```

The unit test starts servers on random ports with `ADMIN_TOKEN=test` and a
temporary root that has no engine, then checks the token gate, env-file parsing,
state shape, health shape, and the clear 503 from `/api/plan`.

The Playwright test starts two mock servers (`MEESA_MOCK=1`) and exercises the
request list, plan editing, progress, publish, reject, and the token gate. It
takes `console.png`, `plan.png`, and `progress.png` in the test directory and
asserts zero browser console errors. It never generates real assets or
publishes. If the real `scripts/lib/pack.mjs` exists, one additional read-only
check calls `GET /api/state` and `POST /api/plan` for `treant`; it never calls
generate or publish.

## Troubleshooting

- **Engine not ready**: confirm `scripts/lib/pack.mjs` exists under `MEESA_ROOT`
  and exports `planPack`, `generatePack`, `publishPack`, `rejectRequest`, and
  `readRequests`. The server retries after 1.5 seconds on the next request.
- **Ollama offline**: start Ollama and confirm `OLLAMA_MODEL` is pulled. The
  engine can fall back to a deterministic plan if the model call fails, but the
  badge still reports the connection state.
- **ComfyUI offline**: real generation will fail. The UI shows the job error and
  leaves the request in `planned`.
- **Publish disabled**: publishing needs a `fulfilled` request and a dirty git
  working tree. A clean tree means there is nothing to commit.
- **401 in the UI**: clear the token field, check `ADMIN_TOKEN` in
  `admin/.env.local`, and unlock again. The server never prints the token.
- **Port in use**: stop the other process or run
  `node admin/server.mjs --port 4311`.
