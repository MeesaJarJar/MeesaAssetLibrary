#!/usr/bin/env python
"""Precompute CLIP and CLAP embeddings for the asset library.

Builds these artifacts under catalog/:

  embeddings-clip.bin   Float32 little-endian CLIP vectors, 512 per vector
  embeddings-clap.bin   Float32 little-endian CLAP vectors, 512 per vector
  embeddings.json       manifest: dim, models, and vector indices per asset
  concepts.json         published {version, concepts} lexicon document

Assets are sorted by id, concepts are sorted by id. Within an asset the field
order is fixed: clipImage, clipText, clapAudio, clapText. Concept order is
clip, then clap.

Usage:
  python scripts/embed.py                 # rebuild everything, then self-test
  python scripts/embed.py --selftest      # verify existing artifacts only

Model loading prefers the local HuggingFace cache and may download once on a
cold checkout. Nothing is downloaded at query time; this script is the only
step that needs the cache.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[1]
CLIP_MODEL_ID = "openai/clip-vit-base-patch32"
CLAP_MODEL_ID = "laion/clap-htsat-unfused"
DIM = 512
CLAP_SAMPLE_RATE = 48000
VISUAL_KINDS = {"image", "video", "model"}


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows = []
    with path.open("r", encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise SystemExit(f"{path}:{line_no}: invalid JSON: {exc}") from exc
    return rows


def as_list(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value.strip()] if value.strip() else []
    if isinstance(value, (list, tuple)):
        return [str(item).strip() for item in value if str(item).strip()]
    return [str(value).strip()]


def asset_text(asset: dict) -> str:
    """Title + summary + tags + keywords + prompt, in that order."""
    parts: list[str] = []
    for key in ("title", "summary"):
        value = asset.get(key)
        if value:
            parts.append(str(value).strip())
    for key in ("tags", "keywords"):
        values = as_list(asset.get(key))
        if values:
            parts.append(", ".join(values))
    prompt = asset.get("prompt")
    if isinstance(prompt, str) and prompt.strip():
        parts.append(prompt.strip())
    elif isinstance(prompt, (list, tuple)):
        values = as_list(prompt)
        if values:
            parts.append(", ".join(values))
    return ". ".join(part.rstrip(". ") for part in parts if part.strip())


def concept_text(concept: dict) -> str:
    values = [str(concept.get("label") or concept["id"]).strip()]
    values.extend(as_list(concept.get("synonyms")))
    return ", ".join(value for value in values if value)


def resolve_path(root: Path, asset: dict, name: str | None) -> Path | None:
    if not name:
        return None
    directory = asset.get("dir")
    if not directory:
        primary = asset.get("file")
        if not primary:
            return None
        directory = str(Path(primary).parent).replace("\\", "/")
    path = (root / directory / name).resolve()
    return path if path.is_file() else None


def primary_file(root: Path, asset: dict) -> Path | None:
    name = asset.get("file")
    if not name:
        return None
    path = (root / name).resolve()
    return path if path.is_file() else None


def image_path(root: Path, asset: dict) -> Path | None:
    if asset.get("kind") not in VISUAL_KINDS:
        return None
    for key in ("preview", "poster", "thumbnail"):
        path = resolve_path(root, asset, asset.get(key))
        if path is not None and path.suffix.lower() != ".svg":
            return path
    if str(asset.get("mime", "")).startswith("image/"):
        return primary_file(root, asset)
    return None


def audio_path(root: Path, asset: dict) -> Path | None:
    if asset.get("kind") != "audio":
        return None
    path = primary_file(root, asset)
    if path is not None:
        return path
    directory = root / str(asset.get("dir", ""))
    if directory.is_dir():
        for suffix in ("wav", "ogg", "mp3", "flac", "m4a"):
            matches = sorted(directory.glob(f"src/*.{suffix}"))
            if matches:
                return matches[0]
    return None


def ffmpeg_to_wav(path: Path) -> tuple[Path, Path]:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError(
            f"cannot decode {path.name} with soundfile and ffmpeg is not on PATH"
        )
    temp_dir = Path(tempfile.mkdtemp(prefix="asset-embed-"))
    out = temp_dir / "decoded.wav"
    try:
        subprocess.run(
            [
                ffmpeg,
                "-v",
                "error",
                "-y",
                "-i",
                str(path),
                "-ac",
                "1",
                "-ar",
                str(CLAP_SAMPLE_RATE),
                str(out),
            ],
            check=True,
            capture_output=True,
        )
    except subprocess.CalledProcessError as exc:
        shutil.rmtree(temp_dir, ignore_errors=True)
        detail = exc.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(f"ffmpeg failed to decode {path}: {detail}") from exc
    return out, temp_dir


def load_audio(path: Path) -> np.ndarray:
    """Mono float32 at 48 kHz, using soundfile then an ffmpeg fallback."""
    import soundfile as sf

    temp_dir = None
    try:
        try:
            samples, sample_rate = sf.read(
                str(path), always_2d=True, dtype="float32"
            )
        except Exception:
            wav_path, temp_dir = ffmpeg_to_wav(path)
            samples, sample_rate = sf.read(
                str(wav_path), always_2d=True, dtype="float32"
            )
        if samples.size == 0:
            raise RuntimeError(f"audio file is empty: {path}")
        mono = samples.mean(axis=1).astype(np.float32, copy=False)
        if sample_rate != CLAP_SAMPLE_RATE:
            import torch

            tensor = torch.from_numpy(np.ascontiguousarray(mono))[None, None, :]
            target = max(1, int(round(len(mono) * CLAP_SAMPLE_RATE / sample_rate)))
            tensor = torch.nn.functional.interpolate(
                tensor, size=target, mode="linear", align_corners=False
            )
            mono = tensor[0, 0].numpy().astype(np.float32, copy=False)
        if not np.isfinite(mono).all():
            raise RuntimeError(f"audio contains non-finite samples: {path}")
        return np.ascontiguousarray(mono, dtype=np.float32)
    finally:
        if temp_dir is not None:
            shutil.rmtree(temp_dir, ignore_errors=True)


def normalize(vectors: np.ndarray) -> np.ndarray:
    vectors = np.asarray(vectors, dtype=np.float32)
    if vectors.size == 0:
        return np.zeros((0, DIM), dtype=np.float32)
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    return np.ascontiguousarray(vectors / np.maximum(norms, 1e-12), dtype=np.float32)


class Embedders:
    def __init__(self, device: str = "auto") -> None:
        import torch

        from transformers import (
            CLIPModel,
            CLIPProcessor,
            ClapModel,
            ClapProcessor,
        )

        self.torch = torch
        if device == "auto":
            device = "cuda" if torch.cuda.is_available() else "cpu"
        if device == "cuda" and not torch.cuda.is_available():
            raise SystemExit("--device cuda requested but CUDA is not available")
        self.device = torch.device(device)

        def load(factory, model_id, **kwargs):
            try:
                return factory.from_pretrained(
                    model_id, local_files_only=True, **kwargs
                )
            except Exception:
                # A cold checkout may not have the cache yet. Query time never
                # loads a model; this build step is allowed to fetch once.
                print(f"model not cached locally, downloading: {model_id}")
                return factory.from_pretrained(model_id, **kwargs)

        try:
            self.clip_model = load(CLIPModel, CLIP_MODEL_ID).to(self.device).eval()
            self.clip_processor = load(CLIPProcessor, CLIP_MODEL_ID)
            self.clap_model = load(ClapModel, CLAP_MODEL_ID).to(self.device).eval()
            self.clap_processor = load(ClapProcessor, CLAP_MODEL_ID)
        except Exception as exc:  # pragma: no cover - environment dependent
            raise SystemExit(
                f"could not load the CLIP/CLAP models ({CLIP_MODEL_ID}, "
                f"{CLAP_MODEL_ID}): {exc}"
            ) from exc

    def _to_device(self, inputs: dict) -> dict:
        return {key: value.to(self.device) for key, value in inputs.items()}

    def clip_text(self, texts: list[str], batch_size: int = 64) -> np.ndarray:
        if not texts:
            return np.zeros((0, DIM), dtype=np.float32)
        chunks = []
        with self.torch.inference_mode():
            for start in range(0, len(texts), batch_size):
                batch = texts[start : start + batch_size]
                inputs = self.clip_processor(
                    text=batch,
                    return_tensors="pt",
                    padding=True,
                    truncation=True,
                    max_length=77,
                )
                features = self.clip_model.get_text_features(
                    **self._to_device(inputs)
                )
                chunks.append(features.float().cpu().numpy())
        return normalize(np.concatenate(chunks, axis=0))

    def clip_image(self, paths: list[Path], batch_size: int = 16) -> np.ndarray:
        if not paths:
            return np.zeros((0, DIM), dtype=np.float32)
        from PIL import Image

        chunks = []
        with self.torch.inference_mode():
            for start in range(0, len(paths), batch_size):
                batch = paths[start : start + batch_size]
                images = []
                for path in batch:
                    with Image.open(path) as image:
                        images.append(image.convert("RGB"))
                inputs = self.clip_processor(images=images, return_tensors="pt")
                features = self.clip_model.get_image_features(
                    **self._to_device(inputs)
                )
                chunks.append(features.float().cpu().numpy())
        return normalize(np.concatenate(chunks, axis=0))

    def clap_text(self, texts: list[str], batch_size: int = 32) -> np.ndarray:
        if not texts:
            return np.zeros((0, DIM), dtype=np.float32)
        chunks = []
        with self.torch.inference_mode():
            for start in range(0, len(texts), batch_size):
                batch = texts[start : start + batch_size]
                inputs = self.clap_processor(
                    text=batch,
                    return_tensors="pt",
                    padding=True,
                    truncation=True,
                )
                features = self.clap_model.get_text_features(
                    **self._to_device(inputs)
                )
                chunks.append(features.float().cpu().numpy())
        return normalize(np.concatenate(chunks, axis=0))

    def clap_audio(self, audios: list[np.ndarray], batch_size: int = 2) -> np.ndarray:
        if not audios:
            return np.zeros((0, DIM), dtype=np.float32)
        chunks = []
        with self.torch.inference_mode():
            for start in range(0, len(audios), batch_size):
                batch = audios[start : start + batch_size]
                inputs = self.clap_processor(
                    audio=batch,
                    sampling_rate=CLAP_SAMPLE_RATE,
                    return_tensors="pt",
                    padding=True,
                )
                features = self.clap_model.get_audio_features(
                    **self._to_device(inputs)
                )
                chunks.append(features.float().cpu().numpy())
        return normalize(np.concatenate(chunks, axis=0))


def write_bin(path: Path, vectors: list[np.ndarray]) -> int:
    if vectors:
        array = np.stack(vectors, axis=0)
    else:
        array = np.zeros((0, DIM), dtype=np.float32)
    if array.shape[1:] != (DIM,):
        raise SystemExit(f"internal error: bad vector shape {array.shape}")
    if not np.isfinite(array).all():
        raise SystemExit("internal error: non-finite vector value")
    array = np.ascontiguousarray(array, dtype="<f4")
    path.write_bytes(array.tobytes(order="C"))
    return array.shape[0]


def load_artifacts(root: Path) -> tuple[dict, np.ndarray, np.ndarray]:
    catalog = root / "catalog"
    manifest_path = catalog / "embeddings.json"
    if not manifest_path.is_file():
        raise SystemExit(
            f"{manifest_path} is missing; run python scripts/embed.py first"
        )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    dim = int(manifest.get("dim", 0))
    if dim != DIM:
        raise SystemExit(f"manifest dim is {dim}, expected {DIM}")
    clip = np.fromfile(catalog / manifest["clip"]["file"], dtype="<f4")
    clap = np.fromfile(catalog / manifest["clap"]["file"], dtype="<f4")
    if clip.size % DIM or clap.size % DIM:
        raise SystemExit("embedding bin size is not a multiple of the vector dim")
    return manifest, clip.reshape(-1, DIM), clap.reshape(-1, DIM)


def dot(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b))


def selftest(root: Path) -> dict:
    manifest, clip, clap = load_artifacts(root)
    catalog = root / "catalog"
    assets = {row["id"]: row for row in read_jsonl(catalog / "index.jsonl")}
    assets.update({row["id"]: row for row in read_jsonl(catalog / "community.jsonl")})
    for asset_id in manifest["assets"]:
        assert asset_id in assets, f"stale manifest entry: {asset_id}"

    expected_clip = 0
    expected_clap = 0
    clip_seen: set[int] = set()
    clap_seen: set[int] = set()
    for asset_id, record in manifest["assets"].items():
        assert set(record) == {"clipImage", "clipText", "clapAudio", "clapText"}, asset_id
        for key in ("clipImage", "clipText"):
            if record.get(key) is not None:
                expected_clip += 1
                clip_seen.add(record[key])
        for key in ("clapAudio", "clapText"):
            if record.get(key) is not None:
                expected_clap += 1
                clap_seen.add(record[key])
    for concept_id, record in manifest["concepts"].items():
        assert set(record) == {"clip", "clap"}, concept_id
        assert record.get("clip") is not None, concept_id
        assert record.get("clap") is not None, concept_id
        expected_clip += 1
        expected_clap += 1
        clip_seen.add(record["clip"])
        clap_seen.add(record["clap"])

    assert len(clip) == expected_clip, (len(clip), expected_clip)
    assert len(clap) == expected_clap, (len(clap), expected_clap)
    assert len(clip_seen) == expected_clip, "duplicate clip offset in manifest"
    assert len(clap_seen) == expected_clap, "duplicate clap offset in manifest"
    assert clip_seen == set(range(len(clip))), "orphan clip vector"
    assert clap_seen == set(range(len(clap))), "orphan clap vector"
    for name, array in (("clip", clip), ("clap", clap)):
        assert np.isfinite(array).all(), f"{name} contains non-finite values"
        norms = np.linalg.norm(array, axis=1)
        assert np.all(norms > 0), f"{name} contains a zero vector"
        assert np.allclose(norms, 1.0, atol=1e-4), (
            f"{name} norms not unit: min={norms.min():.6f} max={norms.max():.6f}"
        )
        expected_bytes = array.shape[0] * DIM * 4
        path = catalog / manifest[name]["file"]
        assert path.stat().st_size == expected_bytes, (
            path.name,
            path.stat().st_size,
            expected_bytes,
        )

    def offset(name: str, owner: str, index) -> int:
        if index is None:
            raise AssertionError(f"{owner} has no {name} vector")
        array = clip if name.startswith("clip") else clap
        assert isinstance(index, int) and 0 <= index < len(array), (
            owner,
            name,
            index,
        )
        return index

    concepts = manifest["concepts"]
    published = json.loads(
        (catalog / "concepts.json").read_text(encoding="utf-8")
    )
    if isinstance(published, dict):
        published = published.get("concepts")
    assert isinstance(published, list), "catalog/concepts.json has no concept array"
    assert {concept["id"] for concept in published} == set(concepts), (
        "catalog/concepts.json does not match the embedding manifest"
    )
    for required in ("dog", "sword", "stone", "ambience"):
        assert required in concepts, f"missing concept: {required}"

    sword = clip[offset("clip", "sword", concepts["sword"]["clip"])]
    stone = clip[offset("clip", "stone", concepts["stone"]["clip"])]
    ambience = clap[offset("clap", "ambience", concepts["ambience"]["clap"])]
    dog = clip[offset("clip", "dog", concepts["dog"]["clip"])]

    def clip_image_scores(concept_vector: np.ndarray) -> dict[str, float]:
        scores = {}
        for asset_id, record in manifest["assets"].items():
            if record.get("clipImage") is not None:
                scores[asset_id] = dot(concept_vector, clip[record["clipImage"]])
        assert scores, "no visual assets with clipImage vectors"
        return scores

    def max_score(scores: dict[str, float]) -> tuple[str, float]:
        asset_id = max(scores, key=scores.get)
        return asset_id, scores[asset_id]

    sword_scores = clip_image_scores(sword)
    stone_scores = clip_image_scores(stone)
    dog_scores = clip_image_scores(dog)

    sword_max_key, sword_max = max_score(sword_scores)
    stone_max_key, stone_max = max_score(stone_scores)
    dog_max_key, dog_max = max_score(dog_scores)

    # Modality floors used by the gallery. Visual assets score only with
    # clipImage; audio assets score only with clapAudio. Text vectors are never
    # scored because CLIP text-to-text cosine is anisotropic.
    assert sword_max >= 0.22, (sword_max_key, sword_max)
    assert stone_max >= 0.22, (stone_max_key, stone_max)
    assert dog_max < 0.22, (dog_max_key, dog_max)

    assert sword_scores["MDL-PROP-000012"] > sword_scores["IMG-TEXTURE-000009"], (
        sword_scores
    )
    assert sword_scores["MDL-PROP-000012"] > sword_scores["VID-CAPTURE-000011"], (
        sword_scores
    )
    texture = stone_scores["IMG-TEXTURE-000009"]
    splat = stone_scores["MDL-PROP-000012"]
    assert texture > splat, (texture, splat)

    audio_score = dot(
        ambience,
        clap[
            offset(
                "clapAudio",
                "SND-AMBIENCE-000010",
                manifest["assets"]["SND-AMBIENCE-000010"]["clapAudio"],
            )
        ],
    )
    audio_norm = float(
        np.linalg.norm(
            clap[
                offset(
                    "clapAudio",
                    "SND-AMBIENCE-000010",
                    manifest["assets"]["SND-AMBIENCE-000010"]["clapAudio"],
                )
            ]
        )
    )
    assert audio_score >= 0.10, audio_score
    assert audio_norm > 0.5, audio_norm

    print("[self-test] integrity ok")
    print(
        f"[self-test] clip sword: max {sword_max:.4f} ({sword_max_key}) >= 0.22; "
        f"MDL-PROP-000012 {sword_scores['MDL-PROP-000012']:.4f} > "
        f"IMG-TEXTURE-000009 {sword_scores['IMG-TEXTURE-000009']:.4f}, "
        f"VID-CAPTURE-000011 {sword_scores['VID-CAPTURE-000011']:.4f}"
    )
    print(
        f"[self-test] clip stone: max {stone_max:.4f} ({stone_max_key}) >= 0.22; "
        f"IMG-TEXTURE-000009 {texture:.4f} > MDL-PROP-000012 {splat:.4f}"
    )
    print(
        f"[self-test] clap ambience: SND-AMBIENCE-000010 {audio_score:.4f} "
        f">= 0.10 (CLAP only; norm {audio_norm:.4f})"
    )
    print(
        f"[self-test] clip dog: max {dog_max:.4f} ({dog_max_key}) < 0.22"
    )
    print(
        f"[self-test] vectors: clip {len(clip)} x {DIM}, clap {len(clap)} x {DIM}"
    )
    return {
        "sword": {
            "max": sword_max,
            "key": sword_max_key,
            "scores": sword_scores,
        },
        "stone": {
            "max": stone_max,
            "key": stone_max_key,
            "texture": texture,
            "splat": splat,
            "scores": stone_scores,
        },
        "ambience": {"score": audio_score, "norm": audio_norm},
        "dog": {"max": dog_max, "key": dog_max_key, "scores": dog_scores},
    }


def build(root: Path, device: str) -> None:
    catalog = root / "catalog"
    catalog.mkdir(parents=True, exist_ok=True)
    concepts_source = root / "scripts" / "concepts.json"
    if not concepts_source.is_file():
        raise SystemExit(f"missing concept lexicon: {concepts_source}")
    concepts = json.loads(concepts_source.read_text(encoding="utf-8"))
    if isinstance(concepts, dict):
        concepts = concepts.get("concepts")
    if not isinstance(concepts, list) or not concepts:
        raise SystemExit(f"no concept array in {concepts_source}")

    assets_by_id: dict[str, dict] = {}
    for path in (catalog / "index.jsonl", catalog / "community.jsonl"):
        for row in read_jsonl(path):
            asset_id = row.get("id")
            if not asset_id:
                raise SystemExit(f"{path}: catalog row without id")
            if asset_id in assets_by_id:
                raise SystemExit(f"duplicate asset id across catalogs: {asset_id}")
            assets_by_id[asset_id] = row
    assets = [assets_by_id[key] for key in sorted(assets_by_id)]

    concept_ids = [concept.get("id") for concept in concepts]
    if len(set(concept_ids)) != len(concept_ids):
        raise SystemExit("duplicate concept id in scripts/concepts.json")
    concepts = sorted(concepts, key=lambda item: item["id"])

    print(
        f"loaded {len(assets)} assets "
        f"({len(read_jsonl(catalog / 'index.jsonl'))} curated, "
        f"{len(read_jsonl(catalog / 'community.jsonl'))} community) "
        f"and {len(concepts)} concepts"
    )

    embedders = Embedders(device=device)
    print(f"device: {embedders.device}")

    image_targets = []
    text_targets = []
    audio_targets = []
    for asset in assets:
        path = image_path(root, asset)
        if path is not None:
            image_targets.append((asset["id"], path))
        text = asset_text(asset)
        if text:
            text_targets.append((asset["id"], text))
        path = audio_path(root, asset)
        if path is not None:
            audio_targets.append((asset["id"], path))

    image_vectors: dict[str, np.ndarray] = {}
    if image_targets:
        vectors = embedders.clip_image([path for _, path in image_targets])
        image_vectors = {
            asset_id: vectors[index]
            for index, (asset_id, _) in enumerate(image_targets)
        }
    text_vectors: dict[str, np.ndarray] = {}
    if text_targets:
        vectors = embedders.clip_text([text for _, text in text_targets])
        text_vectors = {
            asset_id: vectors[index]
            for index, (asset_id, _) in enumerate(text_targets)
        }
    audio_vectors: dict[str, np.ndarray] = {}
    if audio_targets:
        audios = []
        for asset_id, path in audio_targets:
            try:
                audios.append(load_audio(path))
            except Exception as exc:
                raise SystemExit(f"cannot decode audio for {asset_id}: {exc}") from exc
        vectors = embedders.clap_audio(audios)
        audio_vectors = {
            asset_id: vectors[index]
            for index, (asset_id, _) in enumerate(audio_targets)
        }
    audio_text_targets = [
        (asset_id, text)
        for asset_id, text in text_targets
        if assets_by_id[asset_id].get("kind") == "audio"
    ]
    clap_text_vectors: dict[str, np.ndarray] = {}
    if audio_text_targets:
        vectors = embedders.clap_text([text for _, text in audio_text_targets])
        clap_text_vectors = {
            asset_id: vectors[index]
            for index, (asset_id, _) in enumerate(audio_text_targets)
        }

    clip_vectors: list[np.ndarray] = []
    clap_vectors: list[np.ndarray] = []
    asset_manifest: dict[str, dict] = {}
    for asset in assets:
        asset_id = asset["id"]
        record = {
            "clipImage": None,
            "clipText": None,
            "clapAudio": None,
            "clapText": None,
        }
        if asset_id in image_vectors:
            record["clipImage"] = len(clip_vectors)
            clip_vectors.append(image_vectors[asset_id])
        if asset_id in text_vectors:
            record["clipText"] = len(clip_vectors)
            clip_vectors.append(text_vectors[asset_id])
        if asset_id in audio_vectors:
            record["clapAudio"] = len(clap_vectors)
            clap_vectors.append(audio_vectors[asset_id])
        if asset_id in clap_text_vectors:
            record["clapText"] = len(clap_vectors)
            clap_vectors.append(clap_text_vectors[asset_id])
        asset_manifest[asset_id] = record

    concept_clip_texts = [concept_text(concept) for concept in concepts]
    concept_clap_texts = list(concept_clip_texts)
    clip_concept_vectors = embedders.clip_text(concept_clip_texts, batch_size=64)
    clap_concept_vectors = embedders.clap_text(concept_clap_texts, batch_size=32)

    concept_manifest: dict[str, dict] = {}
    for index, concept in enumerate(concepts):
        concept_manifest[concept["id"]] = {
            "clip": len(clip_vectors),
            "clap": len(clap_vectors),
        }
        clip_vectors.append(clip_concept_vectors[index])
        clap_vectors.append(clap_concept_vectors[index])

    clip_count = write_bin(catalog / "embeddings-clip.bin", clip_vectors)
    clap_count = write_bin(catalog / "embeddings-clap.bin", clap_vectors)

    manifest = {
        "version": 1,
        "dim": DIM,
        "clip": {"file": "embeddings-clip.bin", "model": CLIP_MODEL_ID},
        "clap": {"file": "embeddings-clap.bin", "model": CLAP_MODEL_ID},
        "assets": asset_manifest,
        "concepts": concept_manifest,
    }
    (catalog / "embeddings.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    (catalog / "concepts.json").write_text(
        json.dumps(
            {"version": 1, "concepts": concepts},
            indent=2,
            ensure_ascii=True,
        )
        + "\n",
        encoding="utf-8",
        newline="\n",
    )

    kinds: dict[str, int] = {}
    for asset in assets:
        kinds[asset.get("kind", "unknown")] = kinds.get(asset.get("kind", "unknown"), 0) + 1
    kind_summary = ", ".join(f"{key} {value}" for key, value in sorted(kinds.items()))
    clip_size = (catalog / "embeddings-clip.bin").stat().st_size
    clap_size = (catalog / "embeddings-clap.bin").stat().st_size

    print(f"assets: {len(assets)} ({kind_summary}); text assets: {len(text_targets)}")
    print(
        f"clip: {clip_count} vectors "
        f"({len(image_vectors)} image, {len(text_vectors)} asset text, "
        f"{len(concepts)} concept text)"
    )
    print(
        f"clap: {clap_count} vectors "
        f"({len(audio_vectors)} audio, {len(clap_text_vectors)} asset text, "
        f"{len(concepts)} concept text)"
    )
    print(
        f"bins: {catalog / 'embeddings-clip.bin'} {clip_size} bytes; "
        f"{catalog / 'embeddings-clap.bin'} {clap_size} bytes"
    )
    print(f"manifest: {catalog / 'embeddings.json'}")
    selftest(root)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--selftest",
        action="store_true",
        help="verify existing artifacts instead of rebuilding them",
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=REPO_ROOT,
        help="repository root (default: the parent of scripts/)",
    )
    parser.add_argument(
        "--device",
        choices=("auto", "cpu", "cuda"),
        default="auto",
        help="torch device (default: cuda when available)",
    )
    args = parser.parse_args()
    root = args.root.resolve()
    if args.selftest:
        selftest(root)
    else:
        build(root, args.device)


if __name__ == "__main__":
    main()
