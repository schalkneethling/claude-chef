#!/usr/bin/env node
// Tallies Claude Code's session transcripts into the chef-station ledger's
// shape and prints it as JSON. The mod runs this through Node because a mod
// can only read files up to 4 MiB, and long sessions write larger transcripts.
//
// Usage:
//   node scripts/backfill.mjs --projects ~/.claude/projects --since <epoch ms>
// Session ids to leave out (ones the tray already counted live) are read from
// standard input as a JSON array; pass nothing to count every session.

import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { createTally, readLine } from "../hooks/transcript.mjs";

const DAY_MS = 86_400_000;

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

async function readStdin() {
  if (process.stdin.isTTY) {
    return "";
  }

  let text = "";

  for await (const chunk of process.stdin) {
    text += chunk;
  }

  return text;
}

/** Every .jsonl file under `directory`, subagent transcripts included. */
async function* transcripts(directory) {
  let entries;

  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      yield* transcripts(path);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      yield path;
    }
  }
}

const projects = option("projects", join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects"));
const since = Number(option("since", String(Date.now() - 91 * DAY_MS)));
const stdin = (await readStdin()).trim();
const excludeSessions = stdin === "" ? [] : JSON.parse(stdin);

const tally = createTally({ since, excludeSessions });
let files = 0;

for await (const path of transcripts(projects)) {
  files += 1;
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });

  for await (const line of lines) {
    tally.add(readLine(line));
  }
}

process.stdout.write(JSON.stringify({ ...tally.result(), files, skippedFiles: 0 }));
