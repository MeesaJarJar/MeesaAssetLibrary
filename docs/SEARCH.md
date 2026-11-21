# Semantic Search

The gallery can answer queries such as `dog`, `mossy stone`, or `ambient loop`
without downloading a model in the browser. Everything expensive happens at
build time in `scripts/embed.py`; the browser only reads static JSON and two
binary files.

## Concept-anchor approach

Query-time open-vocabulary CLIP would require shipping or downloading a text
encoder. Instead this repository uses a fixed lexicon as the bridge:

1. A query is matched against `catalog/concepts.json` by id, label or synonym
   (case-insensitive, with simple stemming). For example `puppy` resolves to
   the concept `dog`, and `textures` resolves to `texture`.
2. Each concept already has a CLIP text vector and a CLAP text vector computed
   at build time from `"label, synonym, synonym, ..."`.
3. The concept vector is compared with the asset vectors:

   | Query intent | Concept vector | Asset vector | Notes |
   | --- | --- | --- | --- |
   | visual | `clip` | `clipImage` | preview or poster frame |
   | audio | `clap` | `clapAudio` | decoded at 48 kHz mono |

   Assets with no media vector are keyword-only. Text vectors are never scored.

All vectors are L2-normalized, so a dot product is a cosine in `[-1, 1]`.

This keeps the bins small, makes offline search possible, and gives stable
results because asset embeddings never depend on query wording.

### Limitation: the vocabulary is closed

The lexicon is the entire semantic vocabulary. A query that does not resolve to
a concept falls back to keyword search. Compositional queries such as
`sad robot playing violin` are not understood as a combination; at best one
concept wins. Rare subjects, brand names, and new asset categories need a new
concept entry and a rebuild. Open-vocabulary search (encoding arbitrary queries)
is a later feature and would reintroduce a model download at query time.

### Text vectors are banned from scoring

CLIP text embeddings are anisotropic: unrelated text vectors share a large
common direction. Measured on the current ten assets, the `dog` concept scores
**0.586** against the ambience asset's `clipText`, while the `sword` concept
scores only **0.497** against the sword asset's own `clipText`. The unrelated
pair beats the correct pair, so text-to-text cosine cannot be used for scoring.

The rule is therefore:

- visual assets rank by `clipImage`;
- audio assets rank by `clapAudio`;
- `clipText` and `clapText` are retained in the bins and manifest for
  completeness and inspection, but **text-vector scoring is banned at every
  weight**. An asset without a media vector is keyword-only.

The gallery and MCP server must follow this rule: media vectors only, no text
fallback. Do not rescale, floor, or blend `clipText`/`clapText` into a semantic
score.

A concept vector is also the average direction of its label and synonyms.
Adding many loosely related synonyms makes the anchor broader and less precise.

## Files

| File | Written by | Purpose |
| --- | --- | --- |
| `scripts/concepts.json` | human | canonical concept lexicon, 448 entries |
| `catalog/concepts.json` | `scripts/embed.py` | published `{version, concepts}` document |
| `catalog/embeddings.json` | `scripts/embed.py` | manifest: models, dim, vector indices |
| `catalog/embeddings-clip.bin` | `scripts/embed.py` | CLIP vectors, raw Float32 little-endian |
| `catalog/embeddings-clap.bin` | `scripts/embed.py` | CLAP vectors, raw Float32 little-endian |
| `catalog/search-index.json` | `scripts/build-search-index.mjs` | flattened assets, token index, families, concepts |

Current sizes (4 assets, 448 concepts):

| File | Size |
| --- | --- |
| `catalog/embeddings-clip.bin` | 931,840 bytes (455 vectors) |
| `catalog/embeddings-clap.bin` | 921,600 bytes (450 vectors) |
| `catalog/embeddings.json` | 27,427 bytes |
| `catalog/concepts.json` | 79,176 bytes |
| `catalog/search-index.json` | 97,021 bytes |

The two bins total about 1.77 MiB. A concept costs two vectors, or 4,096 bytes.

## Concept format

`scripts/concepts.json` is a JSON array. `catalog/concepts.json` is the
published form used by the gallery and MCP server:

```json
{
  "version": 1,
  "concepts": [
    {
      "id": "dog",
      "label": "dog",
      "synonyms": ["puppy", "canine", "hound", "pup"],
      "kind": "creature",
      "modality": "both"
    }
  ]
}
```

`scripts/build-search-index.mjs` accepts either the published object or a bare
array, so the two files can be inspected independently.

- `id` is lowercase ASCII with hyphens, unique across the lexicon.
- `label` is the display form, usually equal to the id with spaces.
- `synonyms` are lowercase search terms. No synonym may repeat an id, label or
  another synonym, case-insensitively. Do not list the label again.
- `kind` groups concepts for UI filters. Current values: `creature`,
  `character`, `environment`, `weather`, `plant`, `terrain`, `structure`,
  `item`, `material`, `vfx`, `ui`, `audio-event`, `ambience`, `music`, `mood`,
  `style`, `animation`, `3d`, `vehicle`.
- `modality` is `visual`, `audio` or `both`. It tells the gallery which vector
  space to prefer. `scripts/embed.py` computes both CLIP and CLAP text vectors
  for every concept regardless, because the extra cost is small.

Broad category anchors (`weapon`, `animal`, `material`, `terrain`, `npc`, and
similar) coexist with the specific entries (`sword`, `dog`, `stone`, `cliff`,
`knight`). Keep both levels: a broad query anchors to the broad vector, while a
specific query anchors to the specific vector instead of averaging the two.
For example `weapon` resolves to the new broad `weapon` concept, and `blade`
resolves to `sword` through its synonym list.

## Embedded vector format

`catalog/embeddings.json`:

```json
{
  "version": 1,
  "dim": 512,
  "clip": { "file": "embeddings-clip.bin", "model": "openai/clip-vit-base-patch32" },
  "clap": { "file": "embeddings-clap.bin", "model": "laion/clap-htsat-unfused" },
  "assets": {
    "IMG-TEXTURE-000009": {
      "clipImage": 0, "clipText": 1, "clapAudio": null, "clapText": null
    }
  },
  "concepts": {
    "dog": { "clip": 300, "clap": 300 }
  }
}
```

- Offsets are vector indices, not byte offsets. Byte offset is
  `index * 512 * 4`.
- Asset ids are sorted, and within one asset fields are appended in this fixed
  order: `clipImage`, `clipText`, `clapAudio`, `clapText`. A missing vector is
  `null` and consumes no space.
- Concept ids are sorted, and within one concept the order is `clip`, `clap`.
- Every stored vector is 512 Float32 values, little-endian, unit length.
- Bin size must equal `vectorCount * 512 * 4`.

Current manifest order:

| Asset | clipImage | clipText | clapAudio | clapText |
| --- | --- | --- | --- | --- |
| `IMG-TEXTURE-000009` | 0 | 1 | null | null |
| `MDL-PROP-000012` | 2 | 3 | null | null |
| `SND-AMBIENCE-000010` | null | 4 | 0 | 1 |
| `VID-CAPTURE-000011` | 5 | 6 | null | null |

Concept vectors start at CLIP index 7 and CLAP index 2.

## Search index format

`catalog/search-index.json` is written by `scripts/build-search-index.mjs` and
read by the gallery. It has no dependencies and no model code.

```json
{
  "version": 1,
  "generated": "2026-11-21T19:16:48.669Z",
  "assets": [
    {
      "id": "IMG-TEXTURE-000009",
      "kind": "image",
      "role": "texture",
      "title": "Mossy Cobblestone Texture",
      "summary": "Seamless 768x768 ...",
      "tags": ["subject:environment/stone", "style:realistic"],
      "keywords": [],
      "prompt": null,
      "family": null,
      "scope": "curated",
      "contributor": null,
      "license": null,
      "preview": "preview.webp",
      "file": "assets/image/texture/.../src/Albedo_00001_.png",
      "mime": "image/png",
      "bytes": 1051668,
      "sha256": null,
      "dir": "assets/image/texture/000009-mossy-cobblestone-texture",
      "added": "2026-11-21",
      "text": "Mossy Cobblestone Texture. Seamless ... subject:environment/stone, ...",
      "tokens": ["mossy", "cobblestone", "texture", "stone"],
      "embeddings": {
        "clipImage": 0, "clipText": 1, "clapAudio": null, "clapText": null
      }
    }
  ],
  "tokens": {
    "stone": ["IMG-TEXTURE-000009", "VID-CAPTURE-000011"]
  },
  "families": {
    "prompt-0e1ab746": ["IMG-A-000001", "IMG-B-000002"]
  },
  "concepts": [],
  "stats": { "assets": 4, "families": 0, "concepts": 448 }
}
```

Details:

- `text` is title, summary, tags, keywords and prompt joined with `. `.
- `tokens` are lowercase, split on non-alphanumerics, at least two characters,
  simple plural-stemmed (`dogs` to `dog`, `textures` to `texture`), deduplicated.
  The top-level `tokens` map is a reverse index from token to asset ids.
- `scope` is `curated` for `catalog/index.jsonl` rows and `community` for
  `catalog/community.jsonl` rows.
- `sha256` is present for community assets and `null` for curated rows, which do
  not carry that key in `catalog/index.jsonl`.
- `generated` is the build time and changes on every run.
- Assets are sorted by id. Token and family keys are sorted for stable diffs.

### Families

If an asset has a non-empty `family`, that string is its family key. Otherwise,
assets that share the exact same non-empty `prompt` are grouped under
`prompt-<8 hex>` where the hash is the first eight hex characters of SHA-256 of
the prompt. A prompt family needs at least two members. An asset with its own
`family` is never pulled into a prompt family.

## Adding a concept

1. Edit `scripts/concepts.json`. Keep the key order `id`, `label`, `synonyms`,
   `kind`, `modality`.
2. Check uniqueness case-insensitively across every id, label and synonym.
   Prefer merging near-duplicates over adding a second anchor for the same idea.
3. Rebuild embeddings and the index:

```powershell
& "D:\ComfyUIPortable\python_embeded\python.exe" scripts/embed.py
node scripts/build-search-index.mjs
```

The rebuild is deterministic in ordering: assets by id, concepts by id. Adding
one concept shifts later concept offsets, so never edit the bins or manifest by
hand; regenerate both. Keep the lexicon between 300 and 450 entries unless the
extra anchors measurably improve retrieval.

## Rebuilding after new assets

Run from the repository root after the catalog rows and bundles exist:

```powershell
& "D:\ComfyUIPortable\python_embeded\python.exe" scripts/embed.py
node scripts/build-search-index.mjs
```

`scripts/embed.py`:

- reads `catalog/index.jsonl` and `catalog/community.jsonl` if present;
- builds asset text as title + summary + tags + keywords + prompt, tolerating
  absent optional fields;
- embeds `preview` or `poster` images for `image`, `video` and `model` assets;
- embeds every asset text with CLIP;
- embeds `src/` audio with CLAP, resampling to 48 kHz mono, using ffmpeg for
  formats soundfile cannot decode;
- embeds every concept with CLIP and CLAP;
- sorts assets and concepts by id and writes both bins plus the manifest.

It uses CUDA when `torch.cuda.is_available()` and otherwise CPU. Model loading
tries the local HuggingFace cache first and falls back to a one-time download
on a cold checkout; query time never loads a model. No model weights are
committed, only the derived bins.

`scripts/build-search-index.mjs` accepts an alternate repository root:

```powershell
node scripts/build-search-index.mjs --root D:\path\to\repo
```

It prints:

```text
Indexed 4 assets, 135 tokens, 0 families -> catalog/search-index.json
```

## Community assets

`build-search-index.mjs` always reads both catalogs, so a newly contributed
community bundle is keyword-searchable immediately: its title, summary, tags
and tokens are in `search-index.json`. Its `embeddings` object is all `null`
until `scripts/embed.py` runs again, because embeddings are computed only for
assets present at build time.

The gallery should therefore treat community assets with null embeddings as
keyword-only results. Rerun `scripts/embed.py` and
`scripts/build-search-index.mjs` after a contribution to make them semantically
searchable. Community assets are never merged into the curated catalog, and
their `contributor` and `license` values are copied through unchanged.

## Self-test

```powershell
& "D:\ComfyUIPortable\python_embeded\python.exe" scripts/embed.py --selftest
```

The self-test loads the existing manifest and bins only, so it does not need
torch. It checks every offset is in range, every vector is finite and unit
length, no vector is orphaned, and each bin is exactly `count * 512 * 4` bytes.
It also verifies retrieval against the real assets:

| Check | Expected result |
| --- | --- |
| CLIP `sword` | max `clipImage` >= `0.22`; `MDL-PROP-000012` above texture and video |
| CLIP `stone` | max `clipImage` >= `0.22`; texture above the splat |
| CLAP `ambience` | `clapAudio` >= `0.10`; CLAP only |
| CLIP `dog` | max `clipImage` >= `0.22`; all six dog visuals above the floor and above every non-dog asset |
| CLAP `bark` | `clapAudio` >= `0.10` for `SND-SFX-000016` |

Current measured values:

```text
clip sword: max 0.2737 (MDL-PROP-000012) >= 0.22; MDL-PROP-000012 0.2737 > IMG-TEXTURE-000009 0.2125, VID-CAPTURE-000011 0.1791
clip stone: max 0.2968 (VID-CAPTURE-000011) >= 0.22; IMG-TEXTURE-000009 0.2928 > MDL-PROP-000012 0.2124
clap ambience: SND-AMBIENCE-000010 0.1678 >= 0.10 (CLAP only; norm 1.0000)
clip dog: max 0.2572 (IMG-CONCEPT-000013) >= 0.22; six dog assets, non-dog max 0.214
clap bark: SND-SFX-000016 0.4481 >= 0.10
```

These are absolute modality floors, not relative scores. A z-score gate was
evaluated and rejected: with the original three visual assets, `dog` scored
z `1.37` and `sword` z `1.33`, which cannot separate a true miss from a hit.
Visual assets score only with `clipImage`, audio assets only with `clapAudio`,
and `clipText`/`clapText` never enter the score. Keyword matches are preserved
regardless, which is how the bark audio still appears for `dog`.

## Reference query flow

The gallery should keep concept resolution separate from ranking:

1. Normalize the query: lowercase, trim, collapse whitespace.
2. Try an exact match against concept id, label and synonyms.
3. If there is no exact match, tokenize and stem the query and choose the
   concept with the most vocabulary-token overlap. Prefer no concept over a weak
   match; a wrong anchor is worse than keyword results.
4. Use `modality` to pick `clip` or `clap`. For `both`, prefer the query context
   (visual tab versus audio tab).
5. Score candidates with `clipImage` (visual) or `clapAudio` (audio) only.
   Assets without a media vector are keyword-only. Never use `clipText` or
   `clapText` in a score, at any weight.
6. Fall back to `tokens` for unknown terms and to concept-free browsing.

Do not substring-match concept vocabulary: `cat` must not match `catalog`, and
`bar` must not match `barrel`. Match whole stemmed tokens.
