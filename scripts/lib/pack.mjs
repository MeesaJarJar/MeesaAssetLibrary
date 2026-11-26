#!/usr/bin/env node
// Reusable pack engine for the Meesa Asset Library.
//
// A pack turns one queue request into up to four groups of assets: SDXL
// concept images, Stable Audio 3 sound effects, ffmpeg camera loops and a
// TripoSplat PLY derived from the first image. Planning is LLM driven;
// graph building, generation, ingest, status and publication are deterministic
// so the local console, the CLI and the tests all share the same behaviour.
//
// The module has no third-party dependencies. Graph builders and status
// helpers are exported so they can be unit-tested without touching ComfyUI.

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO = path.resolve(LIB_DIR, "..", "..");
const TEMPLATE_PATH = path.resolve(LIB_DIR, "..", "templates", "triposplat.json");

const GROUP_KINDS = ["image", "audio", "video", "model"];
export const DEFAULT_COUNTS = Object.freeze({ image: 1, audio: 1, video: 0, model: 0 });
const COUNT_ALIASES = Object.freeze({
  image: "image", images: "image",
  audio: "audio", audios: "audio", sounds: "audio",
  video: "video", videos: "video",
  model: "model", models: "model",
});
const STATUS_REL = path.join("catalog", "asset-requests-status.json");
const REQUESTS_REL = path.join("catalog", "asset-requests.jsonl");
const CONCEPTS_REL = path.join("scripts", "concepts.json");
const TAG_RE = /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9/_-]*$/;
const MAX_LOG_LINES = 4000;

const GROUP_DEFAULTS = Object.freeze({
  image: { format: "png", use: "concept-art", style: "stylized", subject: "request" },
  audio: { format: "mp3", use: "sfx", style: "realistic", subject: "request" },
  video: { format: "mp4", use: "reference", style: "stylized", subject: "request" },
  model: { format: "ply", use: "reference", style: "stylized", subject: "request" },
});

const DEFAULT_IMAGE_CHECKPOINT = "sd_xl_base_1.0.safetensors";
const DEFAULT_AUDIO_CHECKPOINT = "stable_audio_3_medium.safetensors";
const DEFAULT_AUDIO_TEXT_ENCODER = "t5gemma_b_b_ul2.safetensors";

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

const oneLine = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const clean = (value, max) => oneLine(value).slice(0, max);
const titleCase = (value) => {
  const text = oneLine(value);
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
};

export function slugify(value) {
  const slug = oneLine(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  if (!slug) throw new Error(`cannot make a slug from "${oneLine(value)}"`);
  return slug;
}

export function normalizeQuery(value) {
  const query = oneLine(value).toLowerCase();
  if (!query) throw new Error("query is empty");
  if (query.length > 80) throw new Error("query must be at most 80 characters");
  if (/[\u0000-\u001f]/.test(query)) throw new Error("query must be a single line");
  return query;
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) return [value];
  return [];
}

function unique(values) {
  return [...new Set(values)];
}

function keywordList(value, fallback) {
  const cleaned = toArray(value)
    .map((entry) => clean(entry, 40).replace(/,/g, " "))
    .map((entry) => oneLine(entry))
    .filter(Boolean);
  return unique(cleaned.length ? cleaned : fallback);
}

function normalizeFamily(value, query) {
  const text = oneLine(value || query);
  try {
    return slugify(text);
  } catch {
    return slugify(query);
  }
}

function normalizeTags(value, kind, query) {
  const preset = GROUP_DEFAULTS[kind];
  const rawTags = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  if (!rawTags.length) throw new Error(`${kind}.tags must be a non-empty array`);
  const cleaned = rawTags
    .map((tag) => oneLine(tag).toLowerCase())
    .filter((tag) => TAG_RE.test(tag));
  if (!cleaned.length) throw new Error(`${kind}.tags must contain at least one namespace:value tag`);

  const kept = cleaned.filter((tag) => !tag.startsWith("format:") && !tag.startsWith("engine:"));
  if (!kept.some((tag) => tag.startsWith("use:"))) kept.push(`use:${preset.use}`);
  if (!kept.some((tag) => tag.startsWith("subject:"))) {
    kept.unshift(`subject:${preset.subject}/${slugify(query)}`);
  }
  kept.push(`format:${preset.format}`, "engine:any");
  return unique(kept);
}

function fallbackGroup(kind, query, count) {
  const label = titleCase(query);
  const subject = `subject:request/${slugify(query)}`;
  const tags = [subject, `style:${GROUP_DEFAULTS[kind].style}`, `use:${GROUP_DEFAULTS[kind].use}`];
  const image = {
    count,
    prompts: [
      `game concept art of a ${query}, single subject, full body, centered, neutral dark studio background, detailed, clean silhouette, no text`,
    ],
    negative: "text, watermark, blurry, multiple subjects, frame, human",
    title: `${label} Concept`,
    summary: `A single game-ready ${query} concept on a neutral studio background, generated for the request queue. Use as a first-pass prop, creature or environment reference; the flat backdrop is not a cutout.`,
    tags,
    keywords: [query, "concept", "game asset"],
  };
  const audio = {
    count,
    prompts: [`a natural ${query} sound effect, close perspective, single event, dry, no music, no reverb`],
    title: `${label} Sound`,
    summary: `A four-second one-shot sound effect for a ${query}, dry and unprocessed. Use as a first-pass cue; trim and layer it for the final mix.`,
    tags,
    keywords: [query, "sfx", "sound"],
  };
  const video = {
    count,
    mode: "loop",
    prompts: [
      `slow camera move across a ${query}, single subject centered, neutral dark studio background, steady motion, no text`,
    ],
    title: `${label} Loop`,
    summary: `A six-second 1280x720 camera drift across the first ${query} concept. Use as a menu backdrop or ambient motion plate; it is a camera move over a still, not an animation.`,
    tags,
    keywords: [query, "loop", "motion"],
  };
  const model = {
    count,
    source: "first-image",
    title: `${label} Splat`,
    summary: `65,536-gaussian 3D reconstruction of the ${query}, exported as PLY. Use in the gallery splat viewer or as a stylized 3D reference; it is a Gaussian splat, not a rigged mesh.`,
    tags,
    keywords: [query, "3d", "splat"],
  };
  return { image, audio, video, model }[kind];
}

// ---------------------------------------------------------------------------
// Plan validation and normalization
// ---------------------------------------------------------------------------

function resolveCounts(overrides) {
  const result = { ...DEFAULT_COUNTS };
  if (overrides === undefined || overrides === null) return result;
  if (typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new Error("counts must be an object such as {image:2,audio:1,video:0,model:0}");
  }
  for (const [rawKey, rawValue] of Object.entries(overrides)) {
    const key = COUNT_ALIASES[String(rawKey).toLowerCase()];
    if (!key) throw new Error(`unknown count group "${rawKey}"`);
    const count = Number(rawValue);
    if (!Number.isInteger(count) || count < 0 || count > 5) {
      throw new Error(`${rawKey} count must be an integer from 0 to 5`);
    }
    result[key] = count;
  }
  return result;
}

function normalizeCount(value, fallback, label) {
  if (value === undefined || value === null) return fallback;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0 || count > 5) {
    throw new Error(`${label} must be an integer from 0 to 5`);
  }
  return count;
}

function normalizePlan(query, raw, options = {}) {
  const normalizedQuery = normalizeQuery(query);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("plan is not an object");
  }

  const forcedCounts = options.counts ? resolveCounts(options.counts) : null;
  const plan = {
    query: normalizedQuery,
    family: normalizeFamily(raw.family, normalizedQuery),
  };

  for (const kind of GROUP_KINDS) {
    const source = raw[kind];
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new Error(`${kind} group is missing`);
    }
    const defaults = fallbackGroup(kind, normalizedQuery, 0);
    const count = forcedCounts
      ? forcedCounts[kind]
      : normalizeCount(source.count, DEFAULT_COUNTS[kind], `${kind}.count`);

    const group = { count };
    if (kind !== "model") {
      const prompts = unique(
        toArray(source.prompts)
          .map((prompt) => clean(prompt, kind === "image" ? 900 : 700))
          .filter(Boolean),
      );
      if (count > 0 && !prompts.length) {
        throw new Error(`${kind}.prompts must contain at least one prompt when count is ${count}`);
      }
      group.prompts = prompts.length ? prompts : defaults.prompts;
    }
    if (kind === "image") {
      group.negative = clean(
        source.negative || "text, watermark, blurry, multiple subjects, frame, human",
        400,
      );
    }
    if (kind === "video") {
      group.mode = "loop";
    }
    if (kind === "model") {
      group.source = "first-image";
    }
    group.title = clean(source.title || defaults.title, 80);
    group.summary = clean(source.summary || defaults.summary, 1200);
    group.tags = normalizeTags(source.tags, kind, normalizedQuery);
    group.keywords = keywordList(source.keywords, defaults.keywords);
    if (!group.title) throw new Error(`${kind}.title is empty`);
    if (!group.summary) throw new Error(`${kind}.summary is empty`);
    plan[kind] = group;
  }

  return plan;
}

/** Normalize a raw plan document. Throws on missing groups, prompts or tags. */
export function validatePlan(query, raw) {
  return normalizePlan(query, raw);
}

/** Deterministic plan used when Ollama is unavailable or keeps failing. */
export function fallbackPlan(query, counts = DEFAULT_COUNTS) {
  const normalizedQuery = normalizeQuery(query);
  const resolved = resolveCounts(counts);
  const raw = {
    query: normalizedQuery,
    family: normalizedQuery,
    image: fallbackGroup("image", normalizedQuery, resolved.image),
    audio: fallbackGroup("audio", normalizedQuery, resolved.audio),
    video: fallbackGroup("video", normalizedQuery, resolved.video),
    model: fallbackGroup("model", normalizedQuery, resolved.model),
  };
  return normalizePlan(normalizedQuery, raw, { counts: resolved });
}

/** Cycle prompts and add a deterministic " variation N" suffix to repeats. */
export function expandPrompts(prompts, count) {
  const cleaned = toArray(prompts).map((prompt) => oneLine(prompt)).filter(Boolean);
  const total = Number(count);
  if (!Number.isInteger(total) || total < 0 || total > 5) {
    throw new Error("prompt count must be an integer from 0 to 5");
  }
  if (total > 0 && !cleaned.length) throw new Error("cannot expand an empty prompt list");
  return Array.from({ length: total }, (_, index) => {
    const prompt = cleaned[index % cleaned.length];
    const cycle = Math.floor(index / cleaned.length);
    return cycle === 0 ? prompt : `${prompt} variation ${cycle}`;
  });
}

function repeatedTitle(base, index) {
  if (index === 0) return base;
  const suffix = ` ${index + 1}`;
  return `${base.slice(0, Math.max(1, 80 - suffix.length)).trimEnd()}${suffix}`;
}

// ---------------------------------------------------------------------------
// Ollama planning
// ---------------------------------------------------------------------------

function parsePlanJson(content) {
  let text = String(content ?? "").trim();
  if (!text) throw new Error("Ollama returned an empty planning response");
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch (error) {
        throw new Error(`Ollama did not return valid JSON: ${error.message}`);
      }
    }
    throw new Error("Ollama did not return a JSON object");
  }
}

function planPrompt(query, counts) {
  const shape = [
    "{",
    '"query":string,"family":string,',
    '"image":{"count":number,"prompts":string[],"negative":string,"title":string,"summary":string,"tags":string[],"keywords":string[]},',
    '"audio":{"count":number,"prompts":string[],"title":string,"summary":string,"tags":string[],"keywords":string[]},',
    '"video":{"count":number,"mode":"loop","prompts":string[],"title":string,"summary":string,"tags":string[],"keywords":string[]},',
    '"model":{"count":number,"source":"first-image","title":string,"summary":string,"tags":string[],"keywords":string[]}',
    "}",
  ].join("");
  return [
    "You plan a tiny game-development asset pack for one request word.",
    `Return ONLY one JSON object with this exact shape: ${shape}`,
    `The counts must be exactly image=${counts.image}, audio=${counts.audio}, video=${counts.video}, model=${counts.model}.`,
    "Give at least one prompt for image, audio and video even when the count is 0; the model group has no prompts.",
    `query must be "${query}" and family must be its lowercase hyphenated slug.`,
    "Every group needs a title (max 80 chars), a one-paragraph summary (max 1200 chars), 3 to 6 tags and 3 to 6 keywords.",
    "Every field must stay on the requested subject; never substitute a different object, creature or stock sound.",
    "Tags use namespace:value, for example subject:creature/wolf, style:stylized, use:concept-art. Include the format and engine:any tags.",
    "The image prompt must be self-contained game concept art with a square, single-subject composition on a neutral studio background, no text, no watermark and no pixel dimensions in the prompt text.",
    "The audio prompt must describe a four-second dry one-shot sound the subject could make or a close interaction with it, no music unless the topic is musical.",
    "The video prompt describes the implemented move: a six-second slow push-in with a gentle sway over the first image. It is not generated motion, not an orbit and not a new scene.",
    "The model is a 65,536-gaussian TripoSplat reconstruction of the first image.",
    "Do not include markdown, commentary or extra keys.",
  ].join(" ");
}

/**
 * Ask Ollama for a four-group plan. Counts default to 1 image, 1 audio,
 * 0 video, 0 model and can be overridden with opts.counts.
 */
export async function planPack(query, opts = {}) {
  const normalizedQuery = normalizeQuery(query);
  const counts = resolveCounts(opts.counts);
  const model = opts.model || process.env.OLLAMA_MODEL || "qwen3.5:4b";
  const ollamaUrl = String(opts.ollamaUrl || process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
  const log = (message) => {
    if (typeof opts.onLog !== "function") return;
    try {
      opts.onLog(message);
    } catch { /* A console callback must not break planning. */ }
  };
  const timeout = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 180000;
  const messages = [
    { role: "system", content: planPrompt(normalizedQuery, counts) },
    { role: "user", content: normalizedQuery },
  ];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      log(`Ollama plan with ${model} at ${ollamaUrl} (attempt ${attempt + 1})`);
      const response = await fetch(`${ollamaUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          format: "json",
          // Planning is a small JSON job. Thinking and the model's default
          // 262k context make a 4B model unusably slow on a shared GPU.
          think: false,
          options: { temperature: 0.4, num_ctx: 8192, num_predict: 2000 },
          messages,
        }),
        signal: AbortSignal.timeout(timeout),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`Ollama ${response.status}: ${text.slice(0, 300)}`);
      const body = JSON.parse(text);
      const raw = parsePlanJson(body.message?.content);
      return normalizePlan(normalizedQuery, raw, { counts });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === 0) {
        log(`Plan rejected: ${message}; retrying with the validation error.`);
        messages.push({
          role: "user",
          content: `Your previous answer failed validation: ${message}. Return the exact JSON shape only.`,
        });
      } else {
        log(`Ollama planning failed: ${message}; using the deterministic fallback plan.`);
        return fallbackPlan(normalizedQuery, counts);
      }
    }
  }

  return fallbackPlan(normalizedQuery, counts);
}

// ---------------------------------------------------------------------------
// ComfyUI graph builders (exported for tests and the console)
// ---------------------------------------------------------------------------

export function buildImageGraph(options = {}) {
  const prompt = clean(options.prompt, 900);
  if (!prompt) throw new Error("image prompt is empty");
  const negative = clean(options.negative || "text, watermark, blurry, multiple subjects", 400);
  const seed = Number(options.seed ?? 0);
  const width = Number(options.width ?? 768);
  const height = Number(options.height ?? 768);
  const steps = Number(options.steps ?? 28);
  const cfg = Number(options.cfg ?? 7);
  const prefix = clean(options.prefix || "pack/image", 200);
  const checkpoint = options.checkpoint || process.env.IMAGE_CHECKPOINT || DEFAULT_IMAGE_CHECKPOINT;
  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: checkpoint } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["1", 1] } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: negative, clip: ["1", 1] } },
    "4": { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
    "5": {
      class_type: "KSampler",
      inputs: {
        seed, steps, cfg,
        sampler_name: "dpmpp_2m",
        scheduler: "karras",
        denoise: 1,
        model: ["1", 0],
        positive: ["2", 0],
        negative: ["3", 0],
        latent_image: ["4", 0],
      },
    },
    "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    "7": { class_type: "SaveImage", inputs: { filename_prefix: prefix, images: ["6", 0] } },
  };
}

export function buildAudioGraph(options = {}) {
  const prompt = clean(options.prompt, 700);
  if (!prompt) throw new Error("audio prompt is empty");
  const seed = Number(options.seed ?? 0);
  const seconds = Number(options.seconds ?? 4);
  const steps = Number(options.steps ?? 8);
  const prefix = clean(options.prefix || "pack/audio", 200);
  const checkpoint = options.checkpoint || process.env.AUDIO_CHECKPOINT || DEFAULT_AUDIO_CHECKPOINT;
  const textEncoder = options.textEncoder || process.env.AUDIO_TEXT_ENCODER || DEFAULT_AUDIO_TEXT_ENCODER;
  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: checkpoint } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: textEncoder, type: "stable_audio", device: "default" } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["2", 0] } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["2", 0] } },
    "5": { class_type: "EmptyLatentAudio", inputs: { seconds, batch_size: 1 } },
    "6": {
      class_type: "KSampler",
      inputs: {
        seed, steps, cfg: 1,
        sampler_name: "lcm",
        scheduler: "simple",
        denoise: 1,
        model: ["1", 0],
        positive: ["3", 0],
        negative: ["4", 0],
        latent_image: ["5", 0],
      },
    },
    "7": { class_type: "VAEDecodeAudio", inputs: { samples: ["6", 0], vae: ["1", 2] } },
    "8": {
      class_type: "SaveAudioAdvanced",
      inputs: { filename_prefix: prefix, format: "mp3", "format.quality": "V0", audio: ["7", 0] },
    },
  };
}

export function loadTripoSplatTemplate(templatePath = TEMPLATE_PATH) {
  return JSON.parse(fs.readFileSync(templatePath, "utf8"));
}

/**
 * Patch the exported TripoSplat API graph: node 99 gets the uploaded image,
 * node 105 the KSampler seed and node 111 the gaussian count.
 */
export function buildTripoSplatGraph(options = {}) {
  const image = oneLine(options.image);
  if (!image) throw new Error("TripoSplat image filename is empty");
  const seed = Number(options.seed ?? 46);
  const gaussians = Number(options.gaussians ?? 65536);
  if (!Number.isInteger(gaussians) || gaussians < 1) {
    throw new Error("TripoSplat gaussian count must be a positive integer");
  }
  const template = options.template || loadTripoSplatTemplate(options.templatePath);
  const graph = JSON.parse(JSON.stringify(template));
  if (graph["99"]?.class_type !== "LoadImage") throw new Error("TripoSplat template node 99 is not LoadImage");
  if (graph["105"]?.class_type !== "KSampler") throw new Error("TripoSplat template node 105 is not KSampler");
  if (graph["111"]?.class_type !== "VAEDecodeTripoSplat") {
    throw new Error("TripoSplat template node 111 is not VAEDecodeTripoSplat");
  }
  graph["99"].inputs.image = image;
  graph["105"].inputs.seed = seed;
  graph["111"].inputs.num_gaussians = gaussians;
  return graph;
}

/** ffmpeg arguments for a six-second 1280x720 H.264 camera loop. */
export function buildVideoArgs(options = {}) {
  const image = options.image;
  const output = options.output;
  if (!image) throw new Error("video source image is empty");
  if (!output) throw new Error("video output path is empty");
  const duration = Number(options.duration ?? 6);
  const width = Number(options.width ?? 1280);
  const height = Number(options.height ?? 720);
  const fps = Number(options.fps ?? 24);
  const variant = Math.max(0, Number(options.variant ?? 0));
  const frames = Math.round(duration * fps);
  const zoomRate = (0.00045 + (variant % 3) * 0.00008).toFixed(5);
  const sway = 6 + (variant % 4) * 2;
  const filter = [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    `zoompan=z='min(zoom+${zoomRate},1.16)':x='iw/2-(iw/zoom/2)+sin(on/${fps}*2)*${sway}':y='ih/2-(ih/zoom/2)+cos(on/${fps}*1.5)*${Math.round(sway / 2)}':d=${frames}:s=${width}x${height}:fps=${fps}`,
    "format=yuv420p",
  ].join(",");
  return [
    "-y", "-loglevel", "error",
    "-i", String(image),
    "-vf", filter,
    "-frames:v", String(frames),
    "-r", String(fps),
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-an",
    String(output),
  ];
}

// ---------------------------------------------------------------------------
// Status and request helpers
// ---------------------------------------------------------------------------

const statusPath = (repo) => path.join(path.resolve(repo || DEFAULT_REPO), STATUS_REL);

/** Read the request-status document, returning an empty document when absent. */
export function readStatus(repo = DEFAULT_REPO) {
  const file = statusPath(repo);
  try {
    const document = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    document.version = document.version || 1;
    document.requests = document.requests && typeof document.requests === "object" ? document.requests : {};
    return document;
  } catch (error) {
    if (error.code === "ENOENT") {
      return { version: 1, updated: new Date(0).toISOString(), requests: {} };
    }
    throw new Error(`cannot read ${file}: ${error.message}`);
  }
}

/** Write the request-status document with the repository's 2-space style. */
export function writeStatus(repo = DEFAULT_REPO, document) {
  if (!document || typeof document !== "object") throw new Error("status document is not an object");
  const file = statusPath(repo);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(document, null, 2) + "\n", "utf8");
  return document;
}

/** Read the append-only request queue. Malformed lines are skipped. */
export function readRequests(repo = DEFAULT_REPO) {
  const file = path.join(path.resolve(repo || DEFAULT_REPO), REQUESTS_REL);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw new Error(`cannot read ${file}: ${error.message}`);
  }
  const requests = [];
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      const query = normalizeQuery(record.query);
      requests.push({ ...record, query });
    } catch {
      // A malformed request is the queue page's problem, not the pack engine's.
    }
  }
  return requests;
}

/**
 * Merge asset IDs into one query entry. Existing IDs are always kept and
 * deduplicated, and `prototype` stays true.
 */
export function mergeStatusEntry(document, query, assetIds = [], options = {}) {
  if (!document || typeof document !== "object") throw new Error("status document is not an object");
  const normalizedQuery = normalizeQuery(query);
  if (!document.requests || typeof document.requests !== "object") document.requests = {};
  const previous = document.requests[normalizedQuery];
  const existing = Array.isArray(previous?.assets) ? previous.assets : [];
  const incoming = (Array.isArray(assetIds) ? assetIds : [assetIds])
    .map((asset) => (typeof asset === "string" ? asset : asset?.id))
    .map((id) => oneLine(id))
    .filter(Boolean);
  const assets = unique([...existing, ...incoming]);
  const at = options.at || new Date().toISOString();
  const entry = {
    ...(previous && typeof previous === "object" ? previous : {}),
    ...(options.extra && typeof options.extra === "object" ? options.extra : {}),
    status: options.status || previous?.status || "fulfilled",
    assets,
    at,
    prototype: true,
  };
  document.version = document.version || 1;
  document.requests[normalizedQuery] = entry;
  document.updated = at;
  return entry;
}

/** Mark a request rejected while keeping every asset already attached to it. */
export function rejectRequest(query, reason, repo = DEFAULT_REPO) {
  const normalizedQuery = normalizeQuery(query);
  const document = readStatus(repo);
  const previous = document.requests[normalizedQuery] || {};
  const at = new Date().toISOString();
  const entry = {
    ...previous,
    status: "rejected",
    assets: Array.isArray(previous.assets) ? [...previous.assets] : [],
    at,
    prototype: previous.prototype ?? true,
    reason: clean(reason, 600),
  };
  delete entry.stage;
  delete entry.error;
  document.requests[normalizedQuery] = entry;
  document.updated = at;
  writeStatus(repo, document);
  return entry;
}

/** Add the query to scripts/concepts.json when it is absent. */
export function addQueryConcept(repo = DEFAULT_REPO, query) {
  const root = path.resolve(repo || DEFAULT_REPO);
  const file = path.join(root, CONCEPTS_REL);
  const normalizedQuery = normalizeQuery(query);
  const id = slugify(normalizedQuery);
  let document = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    document = parsed;
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`cannot read ${file}: ${error.message}`);
  }
  const list = Array.isArray(document)
    ? document
    : Array.isArray(document?.concepts)
      ? document.concepts
      : null;
  if (!list) throw new Error(`${file} has no concept array`);
  const existing = list.find((concept) => concept && concept.id === id);
  if (existing) return { added: false, concept: existing };

  const concept = { id, label: normalizedQuery, synonyms: [], kind: "request", modality: "both" };
  list.push(concept);
  list.sort((a, b) => String(a?.id || "").localeCompare(String(b?.id || "")));
  const output = Array.isArray(document) ? list : { ...document, concepts: list };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(output, null, 2) + "\n", "utf8");
  return { added: true, concept };
}

// ---------------------------------------------------------------------------
// Process and ComfyUI helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let lineBuffer = "";
    const flush = () => {
      if (!lineBuffer) return;
      const line = lineBuffer;
      lineBuffer = "";
      try {
        options.onLine?.(line, "stdout");
      } catch { /* Progress callbacks must not break generation. */ }
    };
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      lineBuffer += text;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() || "";
      for (const line of lines) {
        try {
          options.onLine?.(line, "stdout");
        } catch { /* ignore callback errors */ }
      }
    });
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        try {
          options.onLine?.(line, "stderr");
        } catch { /* ignore callback errors */ }
      }
    });
    child.on("error", (error) => {
      reject(new Error(`could not run ${command}: ${error.message}`));
    });
    child.on("close", (code) => {
      flush();
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = oneLine(stderr || stdout).slice(-1200);
      const error = new Error(`${command} exited with code ${code}${detail ? `: ${detail}` : ""}`);
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

function comfyBase(url) {
  return String(url || process.env.COMFYUI_URL || "http://127.0.0.1:8188").replace(/\/+$/, "");
}

async function comfyJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options.timeoutMs || 30000),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch { /* The status code carries the real error. */ }
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${url} failed with ${response.status}: ${text.slice(0, 700)}`);
  }
  return data;
}

async function enqueueComfy(comfyUrl, graph, label) {
  const body = await comfyJson(`${comfyBase(comfyUrl)}/prompt`, {
    method: "POST",
    body: { prompt: graph, client_id: `mesa-pack-${label}-${Date.now()}` },
    timeoutMs: 30000,
  });
  if (!body?.prompt_id) throw new Error(`${label}: ComfyUI did not return a prompt_id`);
  return body.prompt_id;
}

async function waitForComfy(comfyUrl, promptId, label, options = {}) {
  const pollMs = Math.max(250, Number(options.pollMs ?? 2000));
  const timeoutMs = Math.max(1000, Number(options.timeoutMs ?? 1800000));
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const body = await comfyJson(`${comfyBase(comfyUrl)}/history/${encodeURIComponent(promptId)}`, {
        timeoutMs: 15000,
      });
      const entry = body?.[promptId];
      if (entry) {
        if (entry.status?.status_str === "error") {
          const error = new Error(`${label} failed: ${JSON.stringify(entry.status.messages).slice(0, 1200)}`);
          error.comfyJobFailed = true;
          throw error;
        }
        if (entry.status?.completed || entry.status?.status_str === "success") {
          return entry.outputs || {};
        }
      }
    } catch (error) {
      if (error.comfyJobFailed) throw error;
      lastError = error;
    }
    await sleep(pollMs);
  }
  throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)} s${lastError ? ` (${lastError.message})` : ""}`);
}

function resolveComfyOutput(comfyRoot, outputs, nodeId, field) {
  const list = outputs?.[nodeId]?.[field];
  if (!Array.isArray(list) || !list.length) throw new Error(`no ${field} output in ComfyUI node ${nodeId}`);
  const item = list[0];
  const outputRoot = path.resolve(comfyRoot, "output");
  const file = path.resolve(outputRoot, item.subfolder || "", item.filename);
  if (file !== outputRoot && !file.startsWith(outputRoot + path.sep)) {
    throw new Error(`ComfyUI output escapes the output folder: ${item.filename}`);
  }
  if (!fs.existsSync(file)) throw new Error(`ComfyUI reported ${item.filename} but the file is missing`);
  return file;
}

async function walkFiles(directory) {
  const files = [];
  let items;
  try {
    items = await fsp.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return files;
    throw error;
  }
  for (const item of items) {
    const full = path.join(directory, item.name);
    if (item.isDirectory()) files.push(...(await walkFiles(full)));
    else if (item.isFile()) {
      try {
        const info = await fsp.stat(full);
        files.push({ path: full, mtimeMs: info.mtimeMs, size: info.size });
      } catch { /* A file can disappear mid-walk. */ }
    }
  }
  return files;
}

async function listPlyFiles(comfyRoot) {
  const files = await walkFiles(path.join(comfyRoot, "output", "3d"));
  return files.filter((file) => file.path.toLowerCase().endsWith(".ply"));
}

async function waitForNewPly(comfyRoot, before, startedAt, options = {}) {
  const pollMs = Math.max(250, Number(options.pollMs ?? 2000));
  const timeoutMs = Math.max(1000, Number(options.timeoutMs ?? 120000));
  const known = new Set(before.map((file) => file.path.toLowerCase()));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = await listPlyFiles(comfyRoot);
    const fresh = files
      .filter((file) => !known.has(file.path.toLowerCase()) || file.mtimeMs >= startedAt - 1000)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const complete = fresh.find((file) => file.size > 0);
    if (complete) return complete.path;
    await sleep(pollMs);
  }
  throw new Error(`no new PLY appeared in ${path.join(comfyRoot, "output", "3d")} within ${Math.round(timeoutMs / 1000)} s`);
}

async function uploadInputImage(comfyUrl, comfyRoot, file, name) {
  const bytes = await fsp.readFile(file);
  try {
    const form = new FormData();
    form.append("image", new Blob([bytes], { type: "image/png" }), name);
    form.append("overwrite", "true");
    form.append("type", "input");
    const response = await fetch(`${comfyBase(comfyUrl)}/upload/image`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(30000),
    });
    const text = await response.text();
    if (response.ok) {
      const data = JSON.parse(text);
      if (data?.name) return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
    }
  } catch { /* Fall back to a local copy below. */ }
  if (!comfyRoot) throw new Error("image upload failed and no ComfyUI root is configured for a local copy");
  const inputDir = path.join(comfyRoot, "input");
  await fsp.mkdir(inputDir, { recursive: true });
  const target = path.join(inputDir, path.basename(name));
  await fsp.copyFile(file, target);
  return path.basename(name);
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * Generate, ingest and publish one pack into the library.
 *
 * opts: { repo, comfyUrl, comfyRoot, python, onProgress, seed, ffmpeg,
 *         workDir, templatePath, pollMs, imageTimeoutMs, modelTimeoutMs }
 *
 * Returns {assets: [{id, kind, path}], status: <status entry>, log: string[]}.
 * On failure the status entry is written as "failed" with the failing stage,
 * and the thrown error carries `.stage` and `.assets`.
 */
export async function generatePack(planInput, opts = {}) {
  const repo = path.resolve(opts.repo || DEFAULT_REPO);
  const plan = validatePlan(planInput?.query, planInput);
  const query = plan.query;
  const slug = slugify(query);
  const comfyUrl = comfyBase(opts.comfyUrl);
  const comfyRoot = path.resolve(opts.comfyRoot || process.env.COMFYUI_ROOT || "D:\\ComfyUIPortable\\ComfyUI");
  const python = opts.python || process.env.PYTHON || "D:\\ComfyUIPortable\\python_embeded\\python.exe";
  const ffmpeg = opts.ffmpeg || process.env.FFMPEG || "ffmpeg";
  const pollMs = Number(opts.pollMs) > 0 ? Number(opts.pollMs) : 2000;
  const imageTimeoutMs = Number(opts.imageTimeoutMs) > 0 ? Number(opts.imageTimeoutMs) : 600000;
  const modelTimeoutMs = Number(opts.modelTimeoutMs) > 0 ? Number(opts.modelTimeoutMs) : 1800000;
  const counts = Object.fromEntries(GROUP_KINDS.map((kind) => [kind, plan[kind].count]));
  const total = GROUP_KINDS.reduce((sum, kind) => sum + counts[kind], 0);
  const seedBase = Number.isFinite(Number(opts.seed))
    ? Math.trunc(Number(opts.seed))
    : 94000 + Math.floor(Math.random() * 900);
  const workDir = path.resolve(
    opts.workDir || path.join(os.tmpdir(), "opencode", `mesa-pack-${slug}-${Date.now()}`),
  );

  if (total === 0) throw new Error("plan requests no assets; set at least one group count above 0");
  if ((counts.video > 0 || counts.model > 0) && counts.image === 0) {
    throw new Error("video and model generation need image.count >= 1 so the first image can be the source");
  }

  const log = [];
  const assets = [];
  const emit = (event) => {
    if (typeof opts.onProgress !== "function") return;
    try {
      opts.onProgress(event);
    } catch { /* A console callback must not break the run. */ }
  };
  const pushLog = (message, stage = "pack") => {
    log.push(`[${new Date().toISOString()}] ${stage}: ${oneLine(message)}`);
    if (log.length > MAX_LOG_LINES) log.splice(0, log.length - MAX_LOG_LINES);
  };

  let currentStage = "preflight";
  let firstImage = null;

  const writeLiveStatus = async (stageName, status, extra = {}) => {
    const document = readStatus(repo);
    const entry = mergeStatusEntry(document, query, assets.map((asset) => asset.id), {
      status,
      extra: { stage: stageName, ...extra },
    });
    if (status === "generating") delete entry.error;
    if (status === "fulfilled") {
      delete entry.stage;
      delete entry.error;
      delete entry.reason;
    }
    writeStatus(repo, document);
    return entry;
  };

  const recordAsset = async (asset) => {
    assets.push(asset);
    pushLog(`ingested ${asset.id} -> ${asset.path}`, currentStage);
    emit({ stage: currentStage, message: `ingested ${asset.id}`, asset });
    await writeLiveStatus(currentStage, "generating");
  };

  const stage = async (name, work) => {
    currentStage = name;
    pushLog("start", name);
    emit({ stage: name, message: "start" });
    try {
      return await work();
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error));
      wrapped.stage = wrapped.stage || name;
      throw wrapped;
    }
  };

  const runLogged = async (name, command, args, cwd = repo) => {
    pushLog(`> ${command} ${args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ")}`, name);
    return run(command, args, {
      cwd,
      onLine: (line, stream) => {
        if (stream === "stderr" && !line.trim()) return;
        pushLog(line, name);
      },
    });
  };

  const ingestAsset = async (kind, role, fields) => {
    const args = [
      path.join(repo, "scripts", "ingest.mjs"),
      "--root", repo,
      "--file", fields.file,
      "--preview", fields.preview,
      "--kind", kind,
      "--role", role,
      "--title", fields.title,
      "--summary", fields.summary,
      "--tags", fields.tags.join(","),
      "--keywords", fields.keywords.join(","),
      "--source-origin", "generated",
      "--source-tool", fields.sourceTool,
      "--notes", fields.notes,
    ];
    if (fields.prompt) args.push("--prompt", fields.prompt);
    if (fields.family) args.push("--family", fields.family);
    if (fields.technical) args.push("--technical", JSON.stringify(fields.technical));
    const result = await runLogged(currentStage, process.execPath, args);
    const idMatch = result.stdout.match(/Ingested\s+(\S+)/);
    const pathMatch = result.stdout.match(/^\s*bundle:\s+(.+)$/m);
    if (!idMatch) throw new Error(`ingest did not report an asset id for ${kind}/${role}`);
    return { id: idMatch[1], path: pathMatch ? pathMatch[1].trim() : "" };
  };

  const makeImagePreview = (source, target) =>
    runLogged("image", ffmpeg, [
      "-y", "-loglevel", "error", "-i", source,
      "-vf", "scale=384:384:flags=lanczos",
      "-c:v", "libwebp", "-quality", "82", target,
    ]);

  const makeAudioPreview = (source, target) =>
    runLogged("audio", ffmpeg, [
      "-y", "-loglevel", "error", "-i", source,
      "-filter_complex", "showwavespic=s=640x200:colors=#7fc7a4",
      "-frames:v", "1", target,
    ]);

  const makeVideoPreview = (source, target) =>
    runLogged("video", ffmpeg, [
      "-y", "-loglevel", "error", "-ss", "0.5", "-i", source,
      "-frames:v", "1", "-vf", "scale=640:-2",
      "-c:v", "libwebp", "-quality", "82", target,
    ]);

  try {
    await fsp.mkdir(workDir, { recursive: true });
    await writeLiveStatus("starting", "generating");
    pushLog(`work directory ${workDir}`, "preflight");
    emit({ stage: "preflight", message: `work directory ${workDir}`, counts });

    // --- Images ---------------------------------------------------------
    if (counts.image > 0) {
      await stage("image", async () => {
        const prompts = expandPrompts(plan.image.prompts, counts.image);
        for (let index = 0; index < counts.image; index += 1) {
          const number = index + 1;
          const prompt = prompts[index];
          const seed = seedBase + index;
          emit({ stage: "image", message: `image ${number}/${counts.image} seed ${seed}`, index, count: counts.image, seed });
          const graph = buildImageGraph({
            prompt,
            negative: plan.image.negative,
            seed,
            prefix: `queue/${slug}-image-${number}`,
          });
          const promptId = await enqueueComfy(comfyUrl, graph, `image-${number}`);
          pushLog(`queued image ${number}/${counts.image}: ${promptId}`, "image");
          const outputs = await waitForComfy(comfyUrl, promptId, `image ${number}/${counts.image}`, {
            pollMs,
            timeoutMs: imageTimeoutMs,
          });
          const source = resolveComfyOutput(comfyRoot, outputs, "7", "images");
          const file = path.join(workDir, `${slug}-image-${number}.png`);
          const preview = path.join(workDir, `${slug}-image-${number}-preview.webp`);
          await fsp.copyFile(source, file);
          await makeImagePreview(file, preview);
          const title = repeatedTitle(plan.image.title, index);
          const asset = await ingestAsset("image", "concept", {
            file,
            preview,
            title,
            summary: plan.image.summary,
            tags: plan.image.tags,
            keywords: plan.image.keywords,
            prompt,
            family: plan.family,
            notes: `Pack for the queue request "${query}". ComfyUI SDXL txt2img, 768x768, 28 steps, seed ${seed}.`,
            sourceTool: "ComfyUI SDXL txt2img",
          });
          const record = { ...asset, kind: "image" };
          if (index === 0) firstImage = { ...record, file, preview, prompt };
          await recordAsset(record);
        }
      });
    }

    // --- Audio ----------------------------------------------------------
    if (counts.audio > 0) {
      await stage("audio", async () => {
        const prompts = expandPrompts(plan.audio.prompts, counts.audio);
        for (let index = 0; index < counts.audio; index += 1) {
          const number = index + 1;
          const prompt = prompts[index];
          const seed = seedBase + 100 + index;
          emit({ stage: "audio", message: `audio ${number}/${counts.audio} seed ${seed}`, index, count: counts.audio, seed });
          const graph = buildAudioGraph({
            prompt,
            seed,
            prefix: `queue/${slug}-audio-${number}`,
          });
          const promptId = await enqueueComfy(comfyUrl, graph, `audio-${number}`);
          pushLog(`queued audio ${number}/${counts.audio}: ${promptId}`, "audio");
          const outputs = await waitForComfy(comfyUrl, promptId, `audio ${number}/${counts.audio}`, {
            pollMs,
            timeoutMs: imageTimeoutMs,
          });
          const source = resolveComfyOutput(comfyRoot, outputs, "8", "audio");
          const file = path.join(workDir, `${slug}-audio-${number}.mp3`);
          const preview = path.join(workDir, `${slug}-audio-${number}-wave.png`);
          await fsp.copyFile(source, file);
          await makeAudioPreview(file, preview);
          const asset = await ingestAsset("audio", "sfx", {
            file,
            preview,
            title: repeatedTitle(plan.audio.title, index),
            summary: plan.audio.summary,
            tags: plan.audio.tags,
            keywords: plan.audio.keywords,
            prompt,
            notes: `Pack for the queue request "${query}". ComfyUI Stable Audio 3, 4 s, seed ${seed}.`,
            sourceTool: "ComfyUI Stable Audio 3",
            technical: { duration_s: 4, sample_rate: 44100, channels: 2, loopable: false },
          });
          await recordAsset({ ...asset, kind: "audio" });
        }
      });
    }

    // --- Video ----------------------------------------------------------
    if (counts.video > 0) {
      await stage("video", async () => {
        const prompts = expandPrompts(plan.video.prompts, counts.video);
        for (let index = 0; index < counts.video; index += 1) {
          const number = index + 1;
          emit({ stage: "video", message: `video ${number}/${counts.video}`, index, count: counts.video });
          const file = path.join(workDir, `${slug}-loop-${number}.mp4`);
          const preview = path.join(workDir, `${slug}-loop-${number}-preview.webp`);
          await runLogged("video", ffmpeg, buildVideoArgs({
            image: firstImage.file,
            output: file,
            variant: index,
          }));
          await makeVideoPreview(file, preview);
          const asset = await ingestAsset("video", "capture", {
            file,
            preview,
            title: repeatedTitle(plan.video.title, index),
            summary: plan.video.summary,
            tags: plan.video.tags,
            keywords: plan.video.keywords,
            prompt: prompts[index],
            notes: `ffmpeg camera loop from ${path.basename(firstImage.file)}, 6 s, 1280x720, 24 fps, H.264, no audio track.`,
            sourceTool: "ffmpeg zoompan",
            technical: { duration_s: 6, resolution: "1280x720", fps: 24, codec: "h264" },
          });
          await recordAsset({ ...asset, kind: "video" });
        }
      });
    }

    // --- Model ----------------------------------------------------------
    if (counts.model > 0) {
      await stage("model", async () => {
        const inputName = await uploadInputImage(
          comfyUrl,
          comfyRoot,
          firstImage.file,
          `${slug}-pack-${seedBase}.png`,
        );
        pushLog(`staged ${inputName} in the ComfyUI input folder`, "model");
        for (let index = 0; index < counts.model; index += 1) {
          const number = index + 1;
          const seed = seedBase + 300 + index;
          emit({ stage: "model", message: `model ${number}/${counts.model} seed ${seed}`, index, count: counts.model, seed });
          const before = await listPlyFiles(comfyRoot);
          const startedAt = Date.now();
          const graph = buildTripoSplatGraph({
            image: inputName,
            seed,
            gaussians: 65536,
            templatePath: opts.templatePath,
          });
          const promptId = await enqueueComfy(comfyUrl, graph, `model-${number}`);
          pushLog(`queued model ${number}/${counts.model}: ${promptId}`, "model");
          const outputs = await waitForComfy(comfyUrl, promptId, `model ${number}/${counts.model}`, {
            pollMs,
            timeoutMs: modelTimeoutMs,
          });
          const ply = await waitForNewPly(comfyRoot, before, startedAt, { pollMs, timeoutMs: 120000 });
          const file = path.join(workDir, `${slug}-splat-${number}.ply`);
          await fsp.copyFile(ply, file);
          const asset = await ingestAsset("model", "prop", {
            file,
            preview: firstImage.preview,
            title: repeatedTitle(plan.model.title, index),
            summary: plan.model.summary,
            tags: plan.model.tags,
            keywords: plan.model.keywords,
            prompt: firstImage.prompt,
            notes: `ComfyUI TripoSplat from ${path.basename(firstImage.file)}, 65,536 gaussians. The preview is the source concept image; turn Flip Y on in the splat viewer.`,
            sourceTool: "ComfyUI TripoSplat",
            technical: { format: "ply", splats: 65536, flipY: true },
          });
          await recordAsset({ ...asset, kind: "model" });
        }
      });
    }

    // --- Search artifacts and status -----------------------------------
    await stage("concept", async () => {
      const result = addQueryConcept(repo, query);
      pushLog(result.added ? `added concept ${result.concept.id}` : `concept ${result.concept.id} already present`, "concept");
    });

    await stage("embed", async () => {
      await runLogged("embed", python, [path.join(repo, "scripts", "embed.py"), "--root", repo]);
    });

    await stage("index", async () => {
      await runLogged("index", process.execPath, [
        path.join(repo, "scripts", "build-search-index.mjs"), "--root", repo,
      ]);
    });

    await stage("gallery", async () => {
      await runLogged("gallery", process.execPath, [
        path.join(repo, "scripts", "build-gallery.mjs"), "--root", repo,
      ]);
    });

    await stage("check", async () => {
      await runLogged("check", process.execPath, [
        path.join(repo, "scripts", "check-library.mjs"), "--root", repo,
      ]);
    });

    const status = await writeLiveStatus("done", "fulfilled");
    pushLog(`fulfilled with ${assets.length} new asset(s)`, "status");
    emit({ stage: "done", message: `fulfilled with ${assets.length} new asset(s)`, assets });
    return { assets, status, log };
  } catch (error) {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    const failedStage = wrapped.stage || currentStage;
    try {
      const status = await writeLiveStatus(failedStage, "failed", { error: clean(wrapped.message, 600) });
      wrapped.status = status;
    } catch (statusError) {
      pushLog(`could not write failed status: ${statusError.message}`, failedStage);
    }
    wrapped.stage = failedStage;
    wrapped.assets = assets;
    pushLog(`failed: ${wrapped.message}`, failedStage);
    emit({ stage: failedStage, message: `failed: ${wrapped.message}`, error: wrapped.message });
    throw wrapped;
  }
}

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------

/**
 * Commit and push the current pack. Returns {commit, pushed}. When the working
 * tree is clean it returns {commit: null, pushed: false, reason: "no changes"}.
 * opts: {repo, remote, branch, git, message}; the default commit message is
 * `Pack: <query>`.
 */
export async function publishPack(query, opts = {}) {
  const repo = path.resolve(opts.repo || DEFAULT_REPO);
  const normalizedQuery = normalizeQuery(query);
  const remote = opts.remote || "origin";
  const branch = opts.branch || "main";
  const git = opts.git || "git";

  const status = await run(git, ["status", "--porcelain"], { cwd: repo });
  if (!status.stdout.trim()) {
    return { commit: null, pushed: false, reason: "no changes" };
  }

  const message = oneLine(opts.message) || `Pack: ${normalizedQuery}`;
  await run(git, ["add", "-A"], { cwd: repo });
  await run(git, ["commit", "-m", message], { cwd: repo });
  const head = await run(git, ["rev-parse", "HEAD"], { cwd: repo });
  const commit = head.stdout.trim();
  try {
    await run(git, ["push", remote, branch], { cwd: repo });
  } catch (error) {
    error.commit = commit;
    throw error;
  }
  return { commit, pushed: true, remote, branch };
}
