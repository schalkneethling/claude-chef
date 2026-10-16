// Pure parsing for the Agents station: no file system or processes, so tests call it directly.
// register.tsx reads the files and runs `ps` and `tail`, because a function handed `$` must be
// declared in the hooks module itself.

import type { ChefStationAgent, ChefStationAgentAction, ChefStationAgentStatus, ChefStationAgentSurface } from "../types";

/** One `~/.claude/sessions/<pid>.json` file: what every running Claude Code process writes about itself. */
export type RegistryEntry = {
  pid: number;
  sessionId: string;
  cwd: string;
  name: string;
  kind: string;
  entrypoint: string;
  status: ChefStationAgentStatus;
  startedAt?: number;
  /** The process start time in UTC, as `TZ=UTC ps -o lstart=` prints it, so a reused pid is not mistaken for the session. */
  procStart?: string;
};

export type TranscriptSummary = {
  /** A title the person set (`custom-title`) wins over the one Claude generated (`ai-title`). */
  customTitle?: string;
  aiTitle?: string;
  lastPrompt?: string;
  lastAction?: ChefStationAgentAction;
  lastActivityAt?: number;
};

type JsonObject = Record<string, unknown>;

/** The marker Claude Code writes as a user line when the person presses Esc mid-turn. */
const INTERRUPTION_MARKER = /^\[Request interrupted by user/;

const STATUS_ORDER: Record<ChefStationAgentStatus, number> = { busy: 0, unknown: 1, idle: 2 };

export const SURFACE_LABELS: Record<ChefStationAgentSurface, string> = {
  desktop: "Desktop app",
  terminal: "Terminal",
  background: "Background",
};

/** The folder name Claude Code stores a working directory's transcripts under. */
export function projectFolderOf(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export function parseRegistryEntry(text: string): RegistryEntry | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }

  if (!isObject(parsed)) {
    return undefined;
  }

  const { pid, sessionId, cwd, startedAt } = parsed;

  if (typeof pid !== "number" || typeof sessionId !== "string" || typeof cwd !== "string") {
    return undefined;
  }

  return {
    pid,
    sessionId,
    cwd,
    name: stringOf(parsed.name) ?? lastSegmentOf(cwd),
    kind: stringOf(parsed.kind) ?? "interactive",
    entrypoint: stringOf(parsed.entrypoint) ?? "cli",
    status: parsed.status === "busy" || parsed.status === "idle" ? parsed.status : "unknown",
    startedAt: typeof startedAt === "number" ? startedAt : undefined,
    procStart: stringOf(parsed.procStart),
  };
}

export function surfaceOf(entry: RegistryEntry): ChefStationAgentSurface {
  if (entry.kind === "bg") {
    return "background";
  }

  return entry.entrypoint === "claude-desktop" ? "desktop" : "terminal";
}

/** Reads `ps -o pid=,lstart= -p <pids>` output into pid → start time. */
export function parsePsOutput(stdout: string): Map<number, string> {
  const started = new Map<number, string>();

  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);

    if (match?.[1] && match[2]) {
      started.set(Number(match[1]), collapseWhitespace(match[2]));
    }
  }

  return started;
}

/** True when the entry's pid is running and is still the process that wrote the entry. */
export function isSameProcess(entry: RegistryEntry, started: Map<number, string>): boolean {
  const startedAt = started.get(entry.pid);

  if (startedAt === undefined) {
    return false;
  }

  return entry.procStart === undefined || collapseWhitespace(entry.procStart) === startedAt;
}

/** A short, human description of one tool call, such as "Edit: AGENTS.md" or "Bash: Run the unit tests". */
export function describeToolUse(name: string, input: unknown): string {
  const args = isObject(input) ? input : {};
  const tool = name.startsWith("mcp__") ? (name.split("__").pop() ?? name) : name;
  const detail =
    stringOf(args.description) ??
    fileNameOf(args, "file_path") ??
    fileNameOf(args, "notebook_path") ??
    stringOf(args.pattern) ??
    stringOf(args.url) ??
    stringOf(args.query) ??
    stringOf(args.skill) ??
    stringOf(args.command);

  return detail === undefined ? tool : truncate(`${tool}: ${detail}`, 140);
}

/**
 * Summarises the end of a session transcript (JSON lines). The text may start
 * mid-line, because only the file's tail is read, so a line that does not
 * parse is skipped.
 */
export function summariseTranscriptTail(text: string): TranscriptSummary {
  const summary: TranscriptSummary = {};
  const lines = text.split("\n");

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();

    if (!line) {
      continue;
    }

    let entry: unknown;

    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (!isObject(entry)) {
      continue;
    }

    if (entry.type === "custom-title") {
      summary.customTitle ??= stringOf(entry.customTitle);
    }

    if (entry.type === "ai-title") {
      summary.aiTitle ??= stringOf(entry.aiTitle);
    }

    if (entry.type === "last-prompt") {
      summary.lastPrompt ??= stringOf(entry.lastPrompt);
    }

    if (entry.type === "user" || entry.type === "assistant") {
      const timestamp = Date.parse(stringOf(entry.timestamp) ?? "");

      if (summary.lastActivityAt === undefined && !Number.isNaN(timestamp)) {
        summary.lastActivityAt = timestamp;
      }
    }

    if (entry.type === "assistant") {
      summary.lastAction ??= describeAssistantStep(contentBlocksOf(entry.message));
    }

    if (entry.type === "user") {
      summary.lastPrompt ??= typedPromptOf(entry);
    }

    const isComplete =
      (summary.customTitle ?? summary.aiTitle) !== undefined &&
      summary.lastPrompt !== undefined &&
      summary.lastAction !== undefined &&
      summary.lastActivityAt !== undefined;

    if (isComplete) {
      break;
    }
  }

  if (summary.lastPrompt !== undefined) {
    summary.lastPrompt = truncate(summary.lastPrompt, 240);
  }

  return summary;
}

export function toAgent(entry: RegistryEntry, transcript: TranscriptSummary): ChefStationAgent {
  const title = transcript.customTitle ?? transcript.aiTitle;

  return {
    pid: entry.pid,
    sessionId: entry.sessionId,
    name: entry.name,
    title: title !== undefined && title !== entry.name ? title : undefined,
    surface: surfaceOf(entry),
    project: lastSegmentOf(entry.cwd),
    status: entry.status,
    lastPrompt: transcript.lastPrompt,
    lastAction: transcript.lastAction,
    lastActivityAt: transcript.lastActivityAt,
    startedAt: entry.startedAt,
  };
}

/** Busy sessions first, then the most recently active. */
export function sortAgents(agents: readonly ChefStationAgent[]): ChefStationAgent[] {
  return [...agents].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      (b.lastActivityAt ?? b.startedAt ?? 0) - (a.lastActivityAt ?? a.startedAt ?? 0),
  );
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  const flat = collapseWhitespace(text);
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function lastSegmentOf(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function fileNameOf(input: JsonObject, key: string): string | undefined {
  const path = stringOf(input[key]);
  return path === undefined ? undefined : lastSegmentOf(path);
}

function contentBlocksOf(message: unknown): JsonObject[] {
  if (!isObject(message)) {
    return [];
  }

  const { content } = message;

  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  return Array.isArray(content) ? content.filter(isObject) : [];
}

function describeAssistantStep(blocks: JsonObject[]): ChefStationAgentAction | undefined {
  const toolUse = blocks.filter((block) => block.type === "tool_use").pop();

  if (toolUse) {
    return { kind: "tool", text: describeToolUse(stringOf(toolUse.name) ?? "tool", toolUse.input) };
  }

  const text = blocks
    .map((block) => (block.type === "text" ? stringOf(block.text) : undefined))
    .filter((part): part is string => part !== undefined)
    .join(" ");
  // Bold and code markers read as noise on a one-line card; the words stay.
  const plain = text.replace(/\*\*|`/g, "");

  return plain.length > 0 ? { kind: "reply", text: truncate(plain, 160) } : undefined;
}

/** A prompt the person typed, rather than a tool result or a message the harness injected. */
function typedPromptOf(entry: JsonObject): string | undefined {
  // A compaction summary is written as a user line, but the person never typed it.
  if (entry.isMeta === true || entry.isCompactSummary === true) {
    return undefined;
  }

  const texts = contentBlocksOf(entry.message)
    .map((block) => (block.type === "text" ? stringOf(block.text)?.trimStart() : undefined))
    .filter((text): text is string => text !== undefined && !text.startsWith("<") && !INTERRUPTION_MARKER.test(text));

  return texts.length > 0 ? texts.join(" ") : undefined;
}
