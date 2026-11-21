# engine facet

Purpose: which runtime or toolchain an asset is packaged for. This is about
packaging compatibility, not art style and not a quality claim.

Counts are from the ten bundles currently in the catalog (2026-11-21).

## Values

| Value | Count | Meaning |
| --- | --- | --- |
| `engine:any` | 10 | plain source files with no engine-specific packaging |

## Choice notes

- `any` means the bytes are engine-neutral: PNG, OGG, MP4, PLY and similar. It
  does not mean the asset has been imported and tested in every engine.
- Add `engine:godot`, `engine:unity` or `engine:unreal` only when the bundle
  contains a ready-to-import package, preset or manifest for that engine.
- An engine-specific bundle belongs under `assets/project/<engine>/` and should
  also list the engine in `technical.engine`.
- A file that merely happens to be compatible is still `engine:any`; tagging it
  by engine would make the facet meaningless.

## Aliases

- `engine:universal` is a synonym for `any` and must not be introduced.
- `engine:godot4` style version suffixes are rejected; put the version in
  `technical.engine_version` instead.

## Rule

Append new values freely; never rename or delete an existing value. Engine
values are lowercase and match the directory name under `assets/project/`.
