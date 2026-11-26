#!/usr/bin/env node
// Turn one queued request into a pack: images, audio, video and/or a model.
// Usage: node scripts/pack-prototype.mjs --query treant [--dry-run] [--publish]
//
// Counts default to 1 image, 1 audio, 0 video, 0 model. Override with
// --images N --audio N --video N --models N (each 0-5). The actual planning,
// generation, ingest and status handling lives in scripts/lib/pack.mjs.

import path from "node:path";
import {
  DEFAULT_REPO,
  expandPrompts,
  generatePack,
  planPack,
  publishPack,
} from "./lib/pack.mjs";

const args = process.argv.slice(2);

function parseArgs(argv) {
  const valued = {
    query: "query",
    seed: "seed",
    images: "images",
    audio: "audio",
    video: "video",
    models: "models",
    "ollama-url": "ollamaUrl",
    model: "model",
    "comfy-url": "comfyUrl",
    "comfy-root": "comfyRoot",
    python: "python",
    ffmpeg: "ffmpeg",
  };
  const flags = {
    "dry-run": "dryRun",
    publish: "publish",
    help: "help",
  };
  const options = {
    query: "treant",
    seed: undefined,
    images: undefined,
    audio: undefined,
    video: undefined,
    models: undefined,
    dryRun: false,
    publish: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument "${arg}"; use --help for usage`);
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);
    if (flags[name]) {
      if (inline !== undefined) throw new Error(`--${name} does not take a value`);
      options[flags[name]] = true;
    } else if (valued[name]) {
      if (inline === undefined && index + 1 >= argv.length) throw new Error(`--${name} requires a value`);
      options[valued[name]] = inline !== undefined ? inline : argv[++index];
    } else {
      throw new Error(`unknown option "--${name}"; use --help for usage`);
    }
  }
  return options;
}

function countValue(value, flag) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0 || count > 5) {
    throw new Error(`${flag} must be an integer from 0 to 5`);
  }
  return count;
}

function printUsage() {
  console.log("Usage: node scripts/pack-prototype.mjs --query <word> [options]");
  console.log("Options:");
  console.log("  --dry-run            plan only; print expanded prompts and generate nothing");
  console.log("  --publish            commit and push the finished pack");
  console.log("  --images N           image count, 0-5 (default 1)");
  console.log("  --audio N            audio count, 0-5 (default 1)");
  console.log("  --video N            video count, 0-5 (default 0)");
  console.log("  --models N           model count, 0-5 (default 0)");
  console.log("  --seed N             base ComfyUI seed");
  console.log("  --ollama-url URL     Ollama base URL");
  console.log("  --model NAME         Ollama planning model");
  console.log("  --comfy-url URL      ComfyUI base URL");
  console.log("  --comfy-root DIR     ComfyUI install root (output and input folders)");
  console.log("  --python PATH        Python used for scripts/embed.py");
  console.log("  --ffmpeg PATH        ffmpeg executable");
}

function printDryRun(plan) {
  console.log(`\nCounts: image=${plan.image.count} audio=${plan.audio.count} video=${plan.video.count} model=${plan.model.count}`);
  for (const kind of ["image", "audio", "video"]) {
    const jobs = expandPrompts(plan[kind].prompts, plan[kind].count);
    if (!jobs.length) {
      console.log(`${kind} 0/0: (none)`);
      continue;
    }
    jobs.forEach((prompt, index) => {
      console.log(`${kind} ${index + 1}/${plan[kind].count}: ${prompt}`);
    });
  }
  if (plan.model.count > 0) {
    for (let index = 0; index < plan.model.count; index += 1) {
      console.log(`model ${index + 1}/${plan.model.count}: ${plan.model.source} -> ${plan.model.title}`);
    }
  } else {
    console.log("model 0/0: (none)");
  }
  console.log("\nDry run only. No files were generated.");
}

async function main() {
  const options = parseArgs(args);
  if (options.help) {
    printUsage();
    return;
  }

  const repo = path.resolve(DEFAULT_REPO);
  const counts = {};
  if (options.images !== undefined) counts.image = countValue(options.images, "--images");
  if (options.audio !== undefined) counts.audio = countValue(options.audio, "--audio");
  if (options.video !== undefined) counts.video = countValue(options.video, "--video");
  if (options.models !== undefined) counts.model = countValue(options.models, "--models");

  const seed = options.seed === undefined ? undefined : Number(options.seed);
  if (seed !== undefined && (!Number.isInteger(seed) || seed < 0)) {
    throw new Error("--seed must be a non-negative integer");
  }

  console.log(`Pack for "${options.query}"`);
  const plan = await planPack(options.query, {
    counts,
    ollamaUrl: options.ollamaUrl,
    model: options.model,
    onLog: (message) => console.log(`plan: ${message}`),
  });
  console.log("\nPLAN");
  console.log(JSON.stringify(plan, null, 2));

  if (options.dryRun) {
    printDryRun(plan);
    if (options.publish) console.log("Publish was ignored because --dry-run was set.");
    return;
  }

  const result = await generatePack(plan, {
    repo,
    comfyUrl: options.comfyUrl,
    comfyRoot: options.comfyRoot,
    python: options.python,
    ffmpeg: options.ffmpeg,
    seed,
    onProgress: (event) => {
      if (event.message === "start") return;
      console.log(`[${event.stage}] ${event.message}`);
    },
  });

  console.log(`\nGenerated ${result.assets.length} asset(s):`);
  for (const asset of result.assets) console.log(`  ${asset.id}  ${asset.path}`);
  console.log(`Status: ${result.status.status}`);

  if (options.publish) {
    const published = await publishPack(plan.query, { repo });
    if (published.commit) {
      console.log(`Published ${published.commit.slice(0, 12)} to ${published.remote}/${published.branch}.`);
    } else {
      console.log(`Nothing to publish (${published.reason}).`);
    }
  } else {
    console.log("Review with git diff, then run with --publish or commit manually.");
  }
}

main().catch((error) => {
  const stage = error && error.stage ? ` [${error.stage}]` : "";
  console.error(`\nERROR${stage}: ${error && error.message ? error.message : error}`);
  if (error && error.stack && !error.stage) console.error(error.stack);
  process.exitCode = 1;
});
