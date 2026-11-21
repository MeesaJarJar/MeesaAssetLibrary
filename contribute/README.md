# Collaborator upload page

Static, dependency-free contribution form for invited collaborators.

- Page: `https://meesajarjar.github.io/MeesaAssetLibrary/contribute/`
- Source: `contribute/index.html`
- Publishes to: `MeesaJarJar/MeesaAssetLibrary`, branch `main`
- Output: `community/<kind>/<role>/<6digits>-<slug>/` plus one line in
  `catalog/community.jsonl`

The page is one self-contained HTML file with inline CSS and JavaScript. It
loads no scripts, fonts, styles or images from third parties.

## Token setup

1. Open <https://github.com/settings/personal-access-tokens/new>.
2. Set **Repository access** to **Only select repositories** and choose
   **MeesaAssetLibrary**.
3. Set **Permissions > Contents** to **Read and write**. No other permission is
   required.
4. Generate the token and paste it into the page.

The token is used for `GET /user`, the repository permission check, the catalog
reads and the write sequence. The repository must report
`permissions.push === true`; otherwise the form stays disabled and the page shows
"This account is not a collaborator on the repository".

Authentication errors are distinct:

- `401`: the token is invalid or expired.
- `403` or `404` on the repository check: the account cannot see or write the
  repository.
- Valid token but `permissions.push !== true`: the exact collaborator message.

## Form rules

Required: kind, role, title, summary, tags, SPDX license, ownership confirmation,
and at least one source file. Titles are capped at 80 characters to match the
repository schema; the slug derived from a title is capped at 40 characters.

Kinds are `image`, `model`, `audio`, `video`, `font`, `material`, `doc`, `project`
and `other`. Each kind offers the repository's role names, plus a free-text
"New role..." option:

| Kind | Roles offered |
| --- | --- |
| image | tile, sprite, texture, icon, ui, concept, sheet, reference |
| model | prop, character, environment, rig, anim |
| audio | sfx, music, ambience, voice |
| video | capture, reference, trailer |
| font | display, text, mono |
| material | surface, vfx |
| doc | design, notes, palette, spec, table |
| project | godot, unity, other |
| other | general (fallback; the tree has no existing role) |

A custom role is lowercased and reduced to letters, numbers and hyphens before it
becomes a directory name.

Licenses: `CC0-1.0`, `CC-BY-4.0`, `CC-BY-SA-4.0`, `MIT`,
`LicenseRef-All-Rights-Reserved`, `LicenseRef-Permission-Granted`.

Tags must match `namespace:value` (lowercase, `/` allowed in the value).
`format:<extension>` and `engine:any` are added when those namespaces are
missing. At least one user-supplied tag is required.

## File support

Allowed:

`png`, `jpg`, `jpeg`, `webp`, `gif`, `bmp`, `tga`, `wav`, `ogg`, `mp3`, `flac`,
`m4a`, `mp4`, `webm`, `mov`, `glb`, `gltf`, `ply`, `obj`, `fbx`, `ttf`, `otf`,
`woff`, `woff2`, `md`, `txt`, `pdf`, `csv`, `json`.

Rejected as unsafe or unsupported: SVG, HTML, JavaScript, executables, archives,
and any extension outside the allowlist. Empty files are rejected.

There is no page-level file-size or file-count limit. Files over 100 MB produce a
warning because GitHub rejects blobs above that hard per-file cap; the page does
not block them.

## Processing

For every selected file the page computes SHA-256 with WebCrypto, the byte size,
a sanitised lowercase filename (only `[a-z0-9._-]`, no `..`, at most 80
characters), and a MIME type from the extension.

It also records:

- image dimensions (including a small TGA decoder, since browsers do not decode
  TGA natively);
- audio duration, channel count, and WAV sample rate from the RIFF header;
- video duration and dimensions from the media element, with a seek to one second
  for the frame preview;
- PLY vertex count from the ASCII header (`element vertex N`), for binary and
  ASCII PLY files.

Every file gets a WebP preview for the form:

- image: canvas render, longest edge capped at 512 px;
- video: frame at roughly one second, longest edge capped at 512 px;
- audio: 640 x 200 waveform canvas;
- PLY, other models, documents, fonts, materials, projects and other assets: a
  labelled placeholder canvas.

All previews use WebP quality 0.82. Only the first file's preview is published as
the bundle `preview.webp`; previews for additional files are shown in the form but
are not uploaded.

## Duplicate detection

`catalog/community.jsonl` is read during sign-in, again at review, and once more
during the atomic publish attempt. A file whose SHA-256 already appears in that
catalog is rejected before any write. The catalog read uses the contents API,
treats `404` as an empty catalog, and falls back to the git blob API when GitHub
does not inline files larger than 1 MB.

## Publish sequence

Nothing is written until the final confirmation. The confirmation panel says
"This publishes immediately to the live site."

The page builds the complete bundle and catalog text in memory before uploading:

1. `GET /repos/{owner}/{repo}/git/ref/heads/main` for the head commit.
2. `GET /git/commits/{head}` for the base tree.
3. `GET /contents/catalog/community.jsonl?ref=main` for the current text and blob
   SHA (404 means empty).
4. Allocate the next global community ID from existing `COM-<ABBR>-<NNNNNN>`
   values. The abbreviations are IMG, MDL, SND, VID, FNT, MAT, DOC, PRJ and MSC.
5. Build `community/<kind>/<role>/<6digits>-<slug>/` with `asset.json`,
   `asset.md`, `preview.webp`, and `src/<filename>` for every file, plus the new
   `catalog/community.jsonl` text.
6. Create blobs, then a tree with `base_tree` and every new path, then a commit
   whose parent is the head SHA, then `PATCH /git/refs/heads/main` with
   `force: false`.
7. Commit message: `Community: add <ID> "<title>" by @<login>`.

The catalog line key order is fixed:

```text
id, kind, role, title, summary, tags, preview, file, mime, dir, bytes, sha256,
added, contributor, license
```

`asset.json` uses schema `1`, lists every uploaded file, and carries
`source: {origin: "community", tool: "contribute page", captured: "<date>"}`,
`relations`, `notes`, a top-level `contributor: {login, url}` and `license`. In
the catalog line, `contributor` is the GitHub login string; the structured object
lives in `asset.json`.

If GitHub answers the ref update with `409` or `422`, the page re-reads the ref,
head commit and catalog, allocates again, and retries the whole sequence. It makes
at most five retries after the first attempt. Each attempt creates a new tree and
commit object, but only a successful ref update puts a commit on `main`; a failed
attempt never rewrites or deletes existing files.

The success screen shows the assigned ID, links to
`https://meesajarjar.github.io/MeesaAssetLibrary/gallery/#asset=<ID>`, and notes
that GitHub Pages usually rebuilds in about a minute.

## Security and privacy

- The token lives in `sessionStorage` only. It is not placed in the URL, written to
  `localStorage`, logged to the console, or included in error text. Signing out
  removes it.
- The page never uses `innerHTML` for dynamic content. API metadata, titles, tags,
  filenames, errors and contributor data are inserted with `textContent`.
- All API requests go to `https://api.github.com`.
- The strict CSP is exactly:

  ```text
  default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' https://api.github.com; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'
  ```

- The signed-in indicator uses initials, not a remote avatar image. The supplied
  CSP does not allow `avatars.githubusercontent.com`, and the page does not widen
  it.
- File previews are local blob URLs; no media or metadata is sent anywhere except
  the final publish requests.

## Local testing

The page can be inspected with the repository's static server:

```sh
node scripts/serve.mjs --port 4173
```

Then open `http://localhost:4173/contribute/`.

The required Playwright suite is outside the repository at:

```text
C:\Users\meesa\AppData\Local\Temp\opencode\mesa-contribute-test\test.cjs
```

Run it with:

```sh
node C:\Users\meesa\AppData\Local\Temp\opencode\mesa-contribute-test\test.cjs
```

The suite starts its own static server rooted at the repository and mocks
`https://api.github.com/**`. It covers: non-collaborator blocking, collaborator
unlock, license and ownership validation, SVG rejection and PNG acceptance, the
exact tree paths and catalog key order for a valid publish, the duplicate-SHA
rejection, the 422 ref-conflict retry, WAV waveform and PLY vertex metadata, token
storage checks, and zero unexpected console or page errors. Screenshots are
written to `form.png` and `success.png` in the same directory.

Chromium emits an automatic console error for every 404/422 network response. The
protocol requires a 404 probe when the community catalog is absent and a 422 when
the ref-conflict test fires, so those specific browser network notices are
filtered by the test; any application console output or page error still fails.

A second check validates the exact bundle the page emits against the repository
tooling without modifying the repository:

```sh
node C:\Users\meesa\AppData\Local\Temp\opencode\mesa-contribute-test\integration-check.cjs
```

It copies the repository to a temporary root, overlays the published tree from
the Playwright run, then runs `check-library.mjs` and `build-gallery.mjs`. The
generated gallery must contain the new ID, title, bundle path, preview path,
community scope and contributor. The last run reported
`Checked 5 entries (4 curated, 1 community): 0 errors, 0 warnings` and
`Built gallery: 5 assets (4 curated, 1 community)`.

## Known limitations

- **The gallery is generated, not read live.** `scripts/build-gallery.mjs` now
  understands `catalog/community.jsonl` and labels community entries, but
  `gallery/index.html` is a build artifact. This page commits only the community
  bundle and catalog line; it does not run the gallery builder. The success link
  is issued as specified, but a new entry becomes visible after the gallery is
  rebuilt and committed (for example with `npm run gallery`), or after whatever
  automation the repository uses to rebuild Pages deploys the regenerated file.
  The "about a minute" note assumes such a rebuild/deploy exists; a plain Pages
  redeploy of an unchanged `gallery/index.html` will not add the entry.
- Audio and video previews depend on the browser's codecs. If a browser cannot
  decode a file, the page still accepts it, uploads a labelled placeholder
  preview, and records unknown technical values as `null`. WAV sample rates are
  read from the header; compressed audio sample rates are left `null` because
  `decodeAudioData` resamples to the browser's AudioContext rate.
- The 100 MB warning is informational. GitHub's hard limit still applies, and a
  very large file may fail at the blob upload step. The page reports that step and
  does not update the ref.
- A failed ref update can leave unreferenced blob, tree and commit objects in
  GitHub's object database. They are not on `main`; the API offers no cleanup
  operation for them.
- Community IDs use the separate `COM-<ABBR>-<NNNNNN>` namespace. They do not
  collide with the repository's `IMG-TILE-000001` style IDs.
- Browsers that cannot encode WebP previews are blocked with a clear message
  rather than uploading a mislabeled PNG named `preview.webp`.
