import { describe, expect, test } from "claude-code/testing";

import {
  describeToolUse,
  isSameProcess,
  parsePsOutput,
  parseRegistryEntry,
  projectFolderOf,
  sortAgents,
  summariseTranscriptTail,
  toAgent,
} from "../hooks/agents";
import { ago } from "../hooks/format";

function registryJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    pid: 5743,
    sessionId: "abc",
    cwd: "/Users/me/dev/vtex-shop",
    startedAt: 1000,
    procStart: "Thu Oct  8 19:01:21 2026",
    kind: "interactive",
    entrypoint: "cli",
    name: "vtex-shop-7e",
    status: "busy",
    ...overrides,
  });
}

function fixtureEntry() {
  const entry = parseRegistryEntry(registryJson());

  if (!entry) {
    throw new Error("fixture did not parse");
  }

  return entry;
}

/** The end of a transcript, its first line cut mid-way as a tail read leaves it. */
const TAIL = [
  '{"partial line cut by the tail read',
  JSON.stringify({ type: "user", timestamp: "2026-10-16T12:00:00Z", message: { content: "Fix the flaky test" } }),
  JSON.stringify({ type: "ai-title", aiTitle: "Flaky test fix" }),
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-10-16T12:00:05Z",
    message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/repo/a.test.ts" } }] },
  }),
  JSON.stringify({
    type: "user",
    timestamp: "2026-10-16T12:00:06Z",
    message: { content: [{ type: "tool_result", content: "file text" }] },
  }),
].join("\n");

describe("agents", () => {
  test("a registry entry reads as a session, and anything else does not", async () => {
    const entry = fixtureEntry();
    expect(entry.name).toBe("vtex-shop-7e");
    expect(entry.status).toBe("busy");
    expect(parseRegistryEntry("not json")).toBeUndefined();
    expect(parseRegistryEntry(JSON.stringify({ pid: "x" }))).toBeUndefined();
    expect(parseRegistryEntry(registryJson({ status: "paused" }))?.status).toBe("unknown");
  });

  test("a session counts only while its pid runs and started when the entry says, so a reused pid is not counted", async () => {
    const entry = fixtureEntry();
    expect(isSameProcess(entry, parsePsOutput(" 5743 Thu Oct  8 19:01:21 2026\n  99 Fri Oct 16 08:00:00 2026\n"))).toBe(true);
    expect(isSameProcess(entry, parsePsOutput(" 5743 Fri Oct 16 09:00:00 2026\n"))).toBe(false);
    expect(isSameProcess(entry, parsePsOutput(""))).toBe(false);
  });

  test("a working directory maps to its transcripts folder", async () => {
    expect(projectFolderOf("/Users/me/Library/Application Support/x.y")).toBe("-Users-me-Library-Application-Support-x-y");
  });

  test("a tool call is described by its description, then its file", async () => {
    expect(describeToolUse("Bash", { command: "pnpm test", description: "Run the tests" })).toBe("Bash: Run the tests");
    expect(describeToolUse("Edit", { file_path: "/repo/AGENTS.md" })).toBe("Edit: AGENTS.md");
    expect(describeToolUse("mcp__linear__get_issue", {})).toBe("get_issue");
  });

  test("a transcript's end gives the title, the typed prompt and the latest step", async () => {
    const summary = summariseTranscriptTail(TAIL);
    expect(summary.aiTitle).toBe("Flaky test fix");
    expect(summary.lastPrompt).toBe("Fix the flaky test");
    expect(summary.lastAction).toEqual({ kind: "tool", text: "Read: a.test.ts" });
    expect(summary.lastActivityAt).toBe(Date.parse("2026-10-16T12:00:06Z"));
  });

  test("the recorded last prompt wins over injected messages", async () => {
    const withRecord = `${TAIL}\n${JSON.stringify({ type: "last-prompt", lastPrompt: "Make a dashboard" })}`;
    expect(summariseTranscriptTail(withRecord).lastPrompt).toBe("Make a dashboard");
  });

  test("an interruption marker or a compaction summary is never the last prompt", async () => {
    const userLine = (extra: Record<string, unknown>, content: string) =>
      JSON.stringify({ type: "user", timestamp: "2026-10-16T12:01:00Z", message: { content }, ...extra });
    const tail = [
      TAIL,
      userLine({ isCompactSummary: true }, "This session is being continued from a previous conversation"),
      userLine({}, "[Request interrupted by user for tool use]"),
    ].join("\n");

    expect(summariseTranscriptTail(tail).lastPrompt).toBe("Fix the flaky test");
  });

  test("a reply reads as a reply, without Markdown bold or code markers", async () => {
    const reply = JSON.stringify({
      type: "assistant",
      timestamp: "2026-10-16T12:02:00Z",
      message: { content: [{ type: "text", text: "All **tests** pass in `agents.ts` now." }] },
    });

    expect(summariseTranscriptTail(`${TAIL}\n${reply}`).lastAction).toEqual({ kind: "reply", text: "All tests pass in agents.ts now." });
  });

  test("a title the person set wins over the generated one, and one equal to the name is left out", async () => {
    const entry = fixtureEntry();
    expect(toAgent(entry, { customTitle: "Mine", aiTitle: "Generated" }).title).toBe("Mine");
    expect(toAgent(entry, { aiTitle: "vtex-shop-7e" }).title).toBeUndefined();
  });

  test("busy sessions come first, then the most recently active", async () => {
    const entry = fixtureEntry();
    const idleRecent = toAgent({ ...entry, sessionId: "a", status: "idle" }, { lastActivityAt: 900 });
    const idleOld = toAgent({ ...entry, sessionId: "b", status: "idle" }, { lastActivityAt: 100 });
    const busy = toAgent({ ...entry, sessionId: "c", status: "busy" }, { lastActivityAt: 50 });

    expect(sortAgents([idleOld, busy, idleRecent]).map((agent) => agent.sessionId)).toEqual(["c", "a", "b"]);
  });

  test("an age reads as a short relative time", async () => {
    expect(ago(5_000)).toBe("just now");
    expect(ago(42_000)).toBe("42s ago");
    expect(ago(90_000)).toBe("1m ago");
    expect(ago(3 * 3_600_000)).toBe("3h ago");
    expect(ago(3 * 86_400_000)).toBe("3d ago");
  });
});
