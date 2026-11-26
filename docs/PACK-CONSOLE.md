# Pack console

The pack console is the local operator surface for turning one queue request
into a small published pack. It runs on your machine, against the checkout, and
is never deployed: Pages publishes `queue/`, `gallery/`, `catalog/` and the
asset trees, not `admin/`.

## Run it

From the repository root:

```sh
node admin/server.mjs
```

Open `http://127.0.0.1:4310/`. The server binds loopback only; change the port
with `--port <number>` or `ADMIN_PORT`, and point it at other services with
`COMFYUI_URL`, `OLLAMA_URL` and `OLLAMA_MODEL`. Settings can live in
`admin/.env.local`; environment variables win over the file. `MEESA_MOCK=1`
starts a deterministic mock engine that writes nothing, which is useful for UI
checks.

The console loads `scripts/lib/pack.mjs` on the first plan/generate/publish
action. If that engine is missing or throws, the API returns a clear error
instead of pretending the job ran.

Prerequisites:

- Node 20 or newer for the console, ingest, index, gallery and status writes.
- Python 3.12 with CPU Torch, `transformers`, `soundfile` and `pillow` for
  embeddings (`python scripts/embed.py`).
- A running ComfyUI with the image checkpoint and Stable Audio model the
  prototype graphs expect. `COMFYUI_URL` defaults to `http://127.0.0.1:8188`;
  `COMFYUI_ROOT` defaults to `D:\ComfyUIPortable\ComfyUI`.
- `ffmpeg` on `PATH` for previews (image WebP, audio waveform).
- Ollama is optional. Without it, the plan falls back to the deterministic
  template.

## P0 flow: queue to publish

P0 is one request to one image plus one four-second sound effect. Keep the loop
small; a pack that ships beats a larger pack that stalls.

1. **Queue.** Open the console's request list. It reads
   `catalog/asset-requests.jsonl` and `catalog/asset-requests-status.json` and
   shows the same demand counts as the public queue: total requests, unique
   requesters, first ask and last ask. Pick an `open` or `planned` topic. Do not
   re-pick a `fulfilled`, `rejected` or `failed` request without a human
   decision.
2. **Plan.** Read the proposed plan before generating: title, summary, image
   prompt, negative prompt, audio prompt, tags and family. The summary must say
   when to use the asset, not just what it is. Edit or re-plan if it describes
   the wrong subject. The plan is a draft; nothing is written yet.
3. **Counts.** Set how many assets to generate in each group: image, audio,
   video and model. Each group accepts 0-5 and the plan must total at least one
   asset. P0 is one image and one four-second audio; leave video and model at 0.
   A higher count is allowed but multiplies runtime and review work.
4. **Generate.** Run the jobs and inspect every result:
   - the image is a single subject on a neutral background, no text or
     watermark;
   - the audio is dry, unprocessed and one event, not a music bed;
   - tags use the `namespace:value` form and include `subject:request/<query>`,
     `format:` and `engine:any`.
   Regenerate with a new seed rather than publishing a bad first take.
   Generation ingests the accepted files as complete bundles under `assets/`,
   marks the request `fulfilled` in `catalog/asset-requests-status.json` with
   the new asset IDs, and rebuilds embeddings/search/gallery. Review `git diff`
   before the next step.
5. **Publish.** Publish only a `fulfilled` request whose changes are still
   uncommitted. The console commits and pushes the reviewed diff with the pack
   message; it refuses when the request is not fulfilled or the repository has
   nothing to publish. Public visitors see the new status and gallery link after
   the push deploys.

The queue page does not publish and does not write status. After a local
generate, start the static server (`npm run serve`) and refresh
`http://localhost:4173/queue/` to see the row change; the console server only
serves its own UI. The public queue shows it after publish.

### CLI fallback

The current headless implementation of the same flow is:

```sh
node scripts/pack-prototype.mjs --query treant --dry-run   # print the plan only
node scripts/pack-prototype.mjs --query treant             # generate, ingest, mark fulfilled
node scripts/pack-prototype.mjs --query treant --publish   # then commit and push
```

Use `--dry-run` when you only need to review the plan. The console and the CLI
write the same status shape; do not run both for one request at the same time.

## Statuses

`catalog/asset-requests-status.json` is written only by the console (or the CLI
fallback). The public queue displays it read-only.

| Status | Meaning | Queue display |
| --- | --- | --- |
| `open` | Demand recorded, nobody has picked it up. Also the default for a missing entry. | Muted **Open** badge |
| `planned` | A maintainer accepted it and a plan exists; generation has not started. | Blue **Planned** badge |
| `generating` | A job is running or waiting on ComfyUI. Transient. | Amber **Generating** badge with a pulsing dot |
| `fulfilled` | Generation produced assets and recorded their IDs. Publish still has to commit them. | Green **Fulfilled** link plus the asset count; opens `../gallery/#q=<query>` |
| `rejected` | Deliberately not doing it, usually because it duplicates an asset or is out of scope. Put the short reason in `reason`. | Grey **Rejected** badge, reason as tooltip |
| `failed` | Generation ended without usable assets and the request was not reset. Keep the row as history and retry only after fixing the cause. | Red **Failed** badge |

Rules:

- Set `generating` before a long job and always move it to `fulfilled`,
  `failed` or back to `planned`. A stuck `generating` is misleading.
- `fulfilled` requires the asset IDs that were actually ingested. If a pack is
  partial, list what exists in `assets`; the queue shows that count.
- `rejected` and `fulfilled` rows stay visible. They are history, not a delete
  list. Never delete request lines from `catalog/asset-requests.jsonl`.
- The overlay is not a catalog. Resolve IDs against `catalog/index.jsonl` and
  `catalog/community.jsonl`; never infer a bundle from the status file.
- Preserve `version: 1` and refresh `updated` on every write. Keep query keys
  lowercase to match the queue aggregation.

## Limits

- **P0 defaults to one image and one short audio clip.** The plan accepts 0-5
  per group, but do not grow a request into a multi-asset pack mid-run; open a
  follow-up request instead.
- **A "video loop" is a camera move over a still**, as in the existing gallery
  captures: slow push, gentle sway, 6 seconds, H.264. It is not generated
  motion and does not show a character acting. Do not label it as animation.
- **True text-to-video needs MiniMax (Hailuo) or a comparable external model.**
  That path requires API credentials, costs money and is not invoked by the
  console or by `.github/workflows/embed-refresh.yml`. If a request needs real
  motion, generate it out of band through MiniMax, review it, then ingest the
  result and mark the request fulfilled. Do not substitute a camera loop for a
  requested animated shot.
- Local generation quality is bounded by the installed checkpoints. If the model
  cannot represent the subject, reject or defer the request instead of
  publishing a misleading asset.
- The console is single-operator. Do not point two consoles at one checkout;
  ingest and status writes assume one writer.
- Publishing pushes to `main` and rebuilds Pages. The daily embedding refresh
  makes community uploads semantic within a day; local generation runs the embed
  step immediately, so no extra action is needed.

## Troubleshooting

- **ComfyUI connection refused:** start ComfyUI, check `COMFYUI_URL`, and make
  sure the checkpoint and audio model names in the graphs exist on that server.
- **Planning returns invalid JSON:** the console retries once, then uses the
  deterministic fallback. A fallback plan is still reviewable and publishable.
- **Embedding step fails:** confirm Python 3.12, CPU Torch and the Hugging Face
  cache. `scripts/embed.py` reads the cache only; the daily workflow warms it.
- **Status badge does not change:** reload `queue/` without cache, confirm the
  query key is lowercase and the JSON is valid, then check the browser console
  for a failed `catalog/asset-requests-status.json` fetch.
