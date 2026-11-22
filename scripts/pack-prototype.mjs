#!/usr/bin/env node
// Prototype: turn one queued request into a 1-image + 1-audio pack.
// Usage: node scripts/pack-prototype.mjs --query treant [--dry-run] [--publish]

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMFY = process.env.COMFYUI_URL || "http://127.0.0.1:8188";
const OLLAMA = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const MODEL = process.env.OLLAMA_MODEL || "qwen3.5:4b";
const COMFY_ROOT = process.env.COMFYUI_ROOT || "D:\\ComfyUIPortable\\ComfyUI";
const PYTHON = process.env.PYTHON || "D:\\ComfyUIPortable\\python_embeded\\python.exe";
const CHECKPOINT = process.env.IMAGE_CHECKPOINT || "sd_xl_base_1.0.safetensors";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const query = String(arg("--query", "treant")).toLowerCase().replace(/[^a-z]/g, "");
const dryRun = args.includes("--dry-run");
const publish = args.includes("--publish");
const seed = Number(arg("--seed", String(94000 + Math.floor(Math.random() * 900))));

if (!query || query.length < 3) {
  console.error("ERROR: --query must be a single word of 3+ letters.");
  process.exit(1);
}

const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const clean = (s, max) => String(s || "").replace(/\s+/g, " ").trim().slice(0, max);
const tagList = (value, fallback) => {
  const tags = Array.isArray(value) ? value : [];
  const cleaned = tags
    .map((t) => String(t).trim())
    .filter((t) => /^[a-z0-9-]+:[a-z0-9/_-]+$/.test(t));
  return cleaned.length ? [...new Set(cleaned)] : fallback;
};
const keywordList = (value, fallback) => {
  const words = Array.isArray(value) ? value : [];
  const cleaned = words.map((w) => clean(w, 40)).filter(Boolean);
  return [...new Set(cleaned.length ? cleaned : fallback)];
};

function fallbackPlan() {
  const label = titleCase(query);
  return {
    query,
    family: query,
    image: {
      title: `${label} Concept`,
      summary: `A single game-ready ${query} concept on a neutral studio background, generated for the request queue. Use as a first-pass prop, creature or environment reference; the flat backdrop is not a cutout.`,
      prompt: `game concept art of a ${query}, single subject, full body, centered, neutral dark studio background, detailed, clean silhouette, no text`,
      negative: "text, watermark, blurry, multiple subjects, frame, human",
      tags: [`subject:request/${query}`, "style:stylized", "use:concept-art", "format:png", "engine:any"],
      keywords: [query, "concept", "game asset"],
    },
    audio: {
      title: `${label} Sound`,
      summary: `A four-second one-shot sound effect for a ${query}, dry and unprocessed. Use as a first-pass cue; trim and layer it for the final mix.`,
      prompt: `a natural ${query} sound effect, close perspective, single event, dry, no music, no reverb`,
      tags: [`subject:request/${query}`, "style:realistic", "use:sfx", "format:mp3", "engine:any"],
      keywords: [query, "sfx", "sound"],
    },
  };
}

function finalizeTags(tags, format, use) {
  const kept = tags.filter((tag) => !tag.startsWith("format:") && !tag.startsWith("engine:"));
  if (!kept.some((tag) => tag.startsWith("use:"))) kept.push("use:" + use);
  kept.push("format:" + format, "engine:any");
  return [...new Set(kept)];
}

function validatePlan(raw) {
  if (!raw || typeof raw !== "object") throw new Error("plan is not an object");
  const image = raw.image || {};
  const audio = raw.audio || {};
  const imagePrompt = clean(image.prompt, 900);
  const audioPrompt = clean(audio.prompt, 700);
  if (!imagePrompt) throw new Error("image.prompt is empty");
  if (!audioPrompt) throw new Error("audio.prompt is empty");
  return {
    query,
    family: query,
    image: {
      title: clean(image.title || `${titleCase(query)} Concept`, 80),
      summary: clean(image.summary || `Game concept art of a ${query}.`, 1200),
      prompt: imagePrompt,
      negative: clean(image.negative || "text, watermark, blurry, multiple subjects", 400),
      tags: finalizeTags(
        tagList(image.tags, [`subject:request/${query}`, "style:stylized", "use:concept-art"]),
        "png",
        "concept-art",
      ),
      keywords: keywordList(image.keywords, [query, "concept"]),
    },
    audio: {
      title: clean(audio.title || `${titleCase(query)} Sound`, 80),
      summary: clean(audio.summary || `One-shot sound effect for a ${query}.`, 1200),
      prompt: audioPrompt,
      tags: finalizeTags(
        tagList(audio.tags, [`subject:request/${query}`, "style:realistic", "use:sfx"]),
        "mp3",
        "sfx",
      ),
      keywords: keywordList(audio.keywords, [query, "sfx"]),
    },
  };
}

async function planPack() {
  const system = [
    "You plan a tiny game-development asset pack.",
    "Return ONLY JSON with this exact shape:",
    '{"query":string,"family":string,"image":{"title":string,"summary":string,"prompt":string,"negative":string,"tags":string[],"keywords":string[]},"audio":{"title":string,"summary":string,"prompt":string,"tags":string[],"keywords":string[]}}',
    "Exactly one image and one audio. Family is the lowercase query.",
    "The image prompt must be self-contained, game-ready, 768x768, single subject, neutral studio background, no text or watermark.",
    "The audio prompt must describe a four-second one-shot sound effect, dry and unprocessed, no music unless the topic is musical.",
    "Tags use namespace:value, e.g. subject:creature/wolf, style:stylized, use:concept-art, format:png, engine:any.",
    "Do not include markdown or commentary.",
  ].join(" ");

  const messages = [
    { role: "system", content: system },
    { role: "user", content: query },
  ];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(`${OLLAMA}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, stream: false, format: "json", options: { temperature: 0.4 }, messages }),
        signal: AbortSignal.timeout(180000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Ollama ${res.status}: ${text.slice(0, 300)}`);
      const body = JSON.parse(text);
      const content = String(body.message?.content || "").replace(/^```json\s*/i, "").replace(/```$/, "").trim();
      return validatePlan(JSON.parse(content));
    } catch (error) {
      if (attempt === 0) {
        console.log("Plan was not valid JSON, retrying with the error attached...");
        messages.push({ role: "user", content: `Your previous answer failed validation: ${error.message}. Return the exact JSON shape only.` });
      } else {
        console.log("Ollama planning failed; using the deterministic fallback plan.");
        console.log(`Reason: ${error.message}`);
      }
    }
  }
  return fallbackPlan();
}

function graphImage(plan) {
  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: CHECKPOINT } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: plan.image.prompt, clip: ["1", 1] } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: plan.image.negative, clip: ["1", 1] } },
    "4": { class_type: "EmptyLatentImage", inputs: { width: 768, height: 768, batch_size: 1 } },
    "5": { class_type: "KSampler", inputs: { seed, steps: 28, cfg: 7, sampler_name: "dpmpp_2m", scheduler: "karras", denoise: 1, model: ["1", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0] } },
    "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    "7": { class_type: "SaveImage", inputs: { filename_prefix: `queue/${query}-image`, images: ["6", 0] } },
  };
}

function graphAudio(plan) {
  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "stable_audio_3_medium.safetensors" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: "t5gemma_b_b_ul2.safetensors", type: "stable_audio", device: "default" } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: plan.audio.prompt, clip: ["2", 0] } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["2", 0] } },
    "5": { class_type: "EmptyLatentAudio", inputs: { seconds: 4, batch_size: 1 } },
    "6": { class_type: "KSampler", inputs: { seed: seed + 1, steps: 8, cfg: 1, sampler_name: "lcm", scheduler: "simple", denoise: 1, model: ["1", 0], positive: ["3", 0], negative: ["4", 0], latent_image: ["5", 0] } },
    "7": { class_type: "VAEDecodeAudio", inputs: { samples: ["6", 0], vae: ["1", 2] } },
    "8": { class_type: "SaveAudioAdvanced", inputs: { filename_prefix: `queue/${query}-audio`, format: "mp3", "format.quality": "V0", audio: ["7", 0] } },
  };
}

async function enqueue(graph, label) {
  const res = await fetch(`${COMFY}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: graph, client_id: `pack-${label}-${Date.now()}` }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${label} rejected by ComfyUI: ${res.status} ${text.slice(0, 700)}`);
  const body = JSON.parse(text);
  console.log(`${label}: queued ${body.prompt_id}`);
  return body.prompt_id;
}

async function waitFor(id, label) {
  for (let i = 0; i < 300; i += 1) {
    const res = await fetch(`${COMFY}/history/${id}`, { signal: AbortSignal.timeout(15000) });
    const body = await res.json();
    const entry = body[id];
    if (entry) {
      if (entry.status?.status_str === "error") {
        throw new Error(`${label} failed: ${JSON.stringify(entry.status.messages).slice(0, 1200)}`);
      }
      if (entry.status?.completed || entry.status?.status_str === "success") {
        return entry.outputs;
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`${label} timed out`);
}

function outputFile(outputs, key, field) {
  const list = outputs[key]?.[field];
  if (!Array.isArray(list) || !list.length) throw new Error(`no ${field} output in ${key}`);
  const item = list[0];
  return path.join(COMFY_ROOT, "output", item.subfolder || "", item.filename);
}

function run(cmd, cmdArgs, options = {}) {
  console.log(`> ${cmd} ${cmdArgs.join(" ")}`);
  return execFileSync(cmd, cmdArgs, { cwd: REPO, encoding: options.inherit ? undefined : "utf8", stdio: options.inherit ? "inherit" : undefined });
}

function ingest(ingestArgs) {
  const out = run(process.execPath, [path.join(REPO, "scripts", "ingest.mjs"), ...ingestArgs]);
  process.stdout.write(out);
  const match = out.match(/Ingested\s+(\S+)/);
  if (!match) throw new Error("could not read the new asset id from ingest output");
  return match[1];
}

function writeStatus(queryName, ids) {
  const statusPath = path.join(REPO, "catalog", "asset-requests-status.json");
  let status = { version: 1, updated: new Date().toISOString(), requests: {} };
  if (fs.existsSync(statusPath)) {
    try {
      status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
      status.requests = status.requests || {};
    } catch {
      status = { version: 1, updated: new Date().toISOString(), requests: {} };
    }
  }
  status.updated = new Date().toISOString();
  status.requests[queryName] = {
    status: "fulfilled",
    assets: ids,
    at: new Date().toISOString(),
    prototype: true,
  };
  fs.writeFileSync(statusPath, JSON.stringify(status, null, 2) + "\n");
  console.log(`Marked ${queryName} fulfilled in catalog/asset-requests-status.json`);
}

async function main() {
  console.log(`Prototype pack for "${query}" (1 image, 1 audio), seed ${seed}`);
  const plan = await planPack();
  console.log("\nPLAN");
  console.log(JSON.stringify(plan, null, 2));
  if (dryRun) {
    console.log("\nDry run only. No files were generated.");
    return;
  }

  const outDir = path.join(os.tmpdir(), "opencode", `pack-${query}-${Date.now()}`);
  fs.mkdirSync(outDir, { recursive: true });

  console.log("\nGenerating image and audio on ComfyUI...");
  const imageId = await enqueue(graphImage(plan), "image");
  const audioId = await enqueue(graphAudio(plan), "audio");
  const imageOutputs = await waitFor(imageId, "image");
  const audioOutputs = await waitFor(audioId, "audio");

  const imageSrc = outputFile(imageOutputs, "7", "images");
  const audioSrc = outputFile(audioOutputs, "8", "audio");
  const imageFile = path.join(outDir, `${query}-image.png`);
  const audioFile = path.join(outDir, `${query}-audio.mp3`);
  fs.copyFileSync(imageSrc, imageFile);
  fs.copyFileSync(audioSrc, audioFile);
  console.log(`Image: ${imageFile}`);
  console.log(`Audio: ${audioFile}`);

  const imagePreview = path.join(outDir, `${query}-preview.webp`);
  const audioPreview = path.join(outDir, `${query}-wave.png`);
  run("ffmpeg", ["-y", "-loglevel", "error", "-i", imageFile, "-vf", "scale=384:384:flags=lanczos", "-c:v", "libwebp", "-quality", "82", imagePreview]);
  run("ffmpeg", ["-y", "-loglevel", "error", "-i", audioFile, "-filter_complex", "showwavespic=s=640x200:colors=#7fc7a4", "-frames:v", "1", audioPreview]);

  console.log("\nIngesting...");
  const imageAssetId = ingest([
    "--file", imageFile,
    "--preview", imagePreview,
    "--kind", "image", "--role", "concept",
    "--title", plan.image.title,
    "--summary", plan.image.summary,
    "--tags", plan.image.tags.join(","),
    "--keywords", plan.image.keywords.join(","),
    "--prompt", plan.image.prompt,
    "--family", plan.family,
    "--notes", `Prototype pack for the queue request "${query}". ComfyUI SDXL, seed ${seed}.`,
    "--source-tool", "ComfyUI SDXL txt2img",
  ]);

  const audioAssetId = ingest([
    "--file", audioFile,
    "--preview", audioPreview,
    "--kind", "audio", "--role", "sfx",
    "--title", plan.audio.title,
    "--summary", plan.audio.summary,
    "--tags", plan.audio.tags.join(","),
    "--keywords", plan.audio.keywords.join(","),
    "--prompt", plan.audio.prompt,
    "--notes", `Prototype pack for the queue request "${query}". Stable Audio 3, 4 s.`,
    "--source-tool", "ComfyUI Stable Audio 3",
    "--technical", JSON.stringify({ duration_s: 4, sample_rate: 44100, channels: 2, loopable: false }),
  ]);

  writeStatus(query, [imageAssetId, audioAssetId]);

  console.log("\nRebuilding embeddings and the gallery...");
  run(PYTHON, [path.join(REPO, "scripts", "embed.py")], { inherit: true });
  run(process.execPath, [path.join(REPO, "scripts", "build-search-index.mjs")], { inherit: true });
  run(process.execPath, [path.join(REPO, "scripts", "build-gallery.mjs")], { inherit: true });
  run(process.execPath, [path.join(REPO, "scripts", "check-library.mjs")], { inherit: true });

  console.log(`\nDone. ${imageAssetId} + ${audioAssetId}`);
  if (publish) {
    run("git", ["add", "-A"], { inherit: true });
    run("git", ["commit", "-m", `Prototype pack: ${query} (1 image, 1 audio)`], { inherit: true });
    run("git", ["push", "origin", "main"], { inherit: true });
    console.log("Published.");
  } else {
    console.log("Review with git diff, then run with --publish or commit manually.");
  }
}

main().catch((error) => {
  console.error("\nERROR: " + (error && error.stack ? error.stack : error));
  process.exitCode = 1;
});
