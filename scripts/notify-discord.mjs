#!/usr/bin/env node
// Post new asset requests to Discord from the Pages workflow.
// The webhook URL comes from the MEESA_DISCORD_WEBHOOK secret and is never
// written to the repository or served to browsers.

import { execFileSync } from "node:child_process";

const WEBHOOK = process.env.MEESA_DISCORD_WEBHOOK || "";
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const lineFlag = args.indexOf("--line");
const explicit = lineFlag >= 0 ? args[lineFlag + 1] : null;

function changedLines() {
  if (explicit) return [explicit];
  try {
    const diff = execFileSync(
      "git",
      ["diff", "HEAD^", "HEAD", "--", "catalog/asset-requests.jsonl"],
      { encoding: "utf8" },
    );
    return diff
      .split(/\r?\n/)
      .filter((line) => line.startsWith("+{"))
      .map((line) => line.slice(1));
  } catch {
    return [];
  }
}

const lines = changedLines();
if (!lines.length) {
  console.log("No new asset requests.");
  process.exit(0);
}
if (!WEBHOOK && !dryRun) {
  console.log("MEESA_DISCORD_WEBHOOK is not set; skipping Discord notification.");
  process.exit(0);
}

function message(entry) {
  const note = String(entry.note || "").slice(0, 280);
  const who = entry.requested_by ? "@" + entry.requested_by : "unknown";
  const when = entry.requested_at || "";
  return {
    username: "Meesa Asset Queue",
    allowed_mentions: { parse: [] },
    content: [
      "**New asset request**",
      "> " + entry.query,
      "Requested by " + who + (when ? " · " + when : ""),
      note ? "Note: " + note : "",
      "<https://meesajarjar.github.io/MeesaAssetLibrary/queue/>",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

let sent = 0;
for (const line of lines.slice(0, 10)) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    console.log("Skipping malformed request line.");
    continue;
  }
  if (!entry.query) continue;

  const body = message(entry);
  if (dryRun) {
    console.log(JSON.stringify(body));
    sent += 1;
    continue;
  }

  const res = await fetch(WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  console.log(`Discord: ${res.status} for ${entry.query}`);
  sent += 1;

  if (res.status === 429) {
    const retry = Math.min(Number(res.headers.get("retry-after") || 2), 10);
    await new Promise((resolve) => setTimeout(resolve, retry * 1000));
    const again = await fetch(WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    console.log(`Discord retry: ${again.status} for ${entry.query}`);
    if (!again.ok) process.exitCode = 1;
  } else if (!res.ok) {
    process.exitCode = 1;
  }
}

if (lines.length > 10) {
  const extra = lines.length - 10;
  if (dryRun) {
    console.log(`(${extra} more requests not previewed)`);
  } else {
    await fetch(WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "Meesa Asset Queue",
        allowed_mentions: { parse: [] },
        content: `…and ${extra} more new asset request(s) in the queue.`,
      }),
    });
  }
}

console.log(`Notified ${sent} request(s).`);
