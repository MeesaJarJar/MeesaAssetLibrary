# _inbox

Temporary landing zone for raw dumps: screenshots, downloads, recordings,
exports and anything that has not been described yet.

## Rules

1. Nothing in `_inbox/` is authoritative. Agents must not cite, index or link to
   files here, and must not treat a file name as a title.
2. A file becomes part of the library only when it is promoted into a bundle
   with `asset.json`, `asset.md`, `preview.svg` and hashed `src/` files.
3. Promotion means copy, not move-and-forget: copy the bytes into `src/`,
   compute size and SHA-256, then delete the inbox copy.
4. Keep the original file name only if it is informative. Rename on promotion to
   a lowercase hyphenated slug.
5. Do not clean `_inbox/` while another agent is working; stale files older than
   a week may be removed by a human.
6. Never place secrets, credentials or licensed material with unclear
   provenance here.

## Naming

If several drops arrive for one asset, prefix them with the intended slug:
`ruined-tower-01.png`, `ruined-tower-02.png`. This is a hint, not metadata.

## Why the rule exists

The catalog and the index are the only search surfaces. Files that bypass bundle
metadata are invisible to every tool, so citing them would create references
that no later reader can resolve.
