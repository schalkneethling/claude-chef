import { describe, expect, mock, test } from "claude-code/testing";
import type { On } from "claude-code";

// Tuesday, 6 October 2026, 14:00 local time.
const START = new Date(2026, 9, 6, 14, 0).getTime();
const HOUR = 3_600_000;

const BAND = {
  plugin: "chef-station",
  component: "AbovePrompt",
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100 },
} as const;

/** The context window as /context breaks it down, with the given system prompt and messages. */
function breakdownOf(systemPrompt: number, messages: number) {
  const used = systemPrompt + 12_000 + messages;

  return {
    categories: [
      { name: "System prompt", tokens: systemPrompt, kind: "used", color: "promptBorder", isDeferred: false },
      { name: "System tools", tokens: 12_000, kind: "used", color: "inactive", isDeferred: false },
      { name: "MCP tools", tokens: 40_000, kind: "deferred", color: "inactive", isDeferred: true },
      { name: "Messages", tokens: messages, kind: "used", color: "permission", isDeferred: false },
      { name: "Free space", tokens: 200_000 - used - 33_000, kind: "free", color: "inactive", isDeferred: false },
      { name: "Autocompact buffer", tokens: 33_000, kind: "buffer", color: "inactive", isDeferred: false },
    ],
    totalTokens: used,
    maxTokens: 200_000,
    rawMaxTokens: 200_000,
    percentage: Math.round((used / 200_000) * 100),
  };
}

/** The colors of the context bar's segments, left to right: the Texts drawn with block or shade glyphs in the first row that has several. */
async function barColors(ui: { drawn: () => Promise<unknown> }): Promise<string[]> {
  const rows: string[][] = [];
  const walk = (node: any) => {
    if (!node || typeof node !== "object") {
      return;
    }

    const children: any[] = node.children ?? [];
    const segments = children.filter((child) => child?.type === "Text" && /^ ?[█░▒]+$/.test((child.children ?? []).join("")));

    if (node.type === "Box" && segments.length > 1) {
      rows.push(segments.map((child) => child.props?.color));
    }

    children.forEach(walk);
  };

  walk(await ui.drawn());
  return rows[0] ?? [];
}

/** What the Node helper prints when it finds nothing. */
const EMPTY_SCAN = { days: {}, unpricedModels: [], files: 0, skippedFiles: 0, responses: 0 };

/** Stands in for Claude Code beneath the mod: the session's figures, the store, the clock and the helper. */
function kitchen(on: On, store: Record<string, unknown> = {}) {
  const figures = {
    usd: 0,
    model: "claude-opus-5-5[1m]",
    breakdown: breakdownOf(3_000, 9_000) as unknown,
    scan: EMPTY_SCAN as unknown,
    scanCalls: [] as { argv: readonly string[]; stdin?: string }[],
    /** Slash commands the mod ran, other than its own. */
    commandsRun: [] as string[],
    compactions: 0,
    /** Whether the Node helper is missing, so the mod reads the transcripts itself. */
    hasNoNode: false,
    rateLimits: [
      { kind: "five_hour", percentUsed: 12, resetsAt: new Date(START + 2 * HOUR + 10 * 60_000).toISOString() },
      { kind: "seven_day", percentUsed: 85, resetsAt: new Date(START + 47 * HOUR + 5 * 60_000).toISOString() },
    ],
  };

  const clock = mock.clock(on, { now: START });
  mock.store(on, store);
  mock.env(on, { HOME: "/home/chef" });
  on("session.start", ($, e) => ({ cwd: e.cwd }));
  on("session.root", () => ({ value: "/work/create-project-calavera" }));
  on("session.id", () => ({ value: "this-session" }));
  on("session.model", () => ({ value: figures.model }));
  on("turn.start", ($, e) => ({ turnId: e.turnId }));
  on("process.run", ($, e) => {
    if (figures.hasNoNode) {
      throw new Error("spawn node ENOENT");
    }

    figures.scanCalls.push({ argv: e.argv, stdin: e.init?.stdin });
    return { value: { exitCode: 0, stdout: JSON.stringify(figures.scan), stderr: "", isStdoutTruncated: false, isStderrTruncated: false } };
  });
  on("command.register", ($, e) => ({ value: { command: e.name } }));
  on("session.usage", ($, e) => ({
    value: {
      startedAt: START,
      context: {
        tokens: 36_000,
        window: 200_000,
        percent: 18,
        ...(e?.breakdown ? { breakdown: figures.breakdown as any } : {}),
      },
      rateLimits: figures.rateLimits,
      cost: { usd: figures.usd },
    },
  }));
  on("turn.complete", () => ({ text: "" }));
  on("command.run", { command: "clear" }, ($, e) => {
    figures.commandsRun.push(e.command);
    return { text: "" };
  });
  on("session.compact", () => {
    figures.compactions += 1;
    return { messages: [{ role: "user", text: "Summary of the conversation so far.", toolUses: [] }], tokensBefore: 120_000, tokensAfter: 18_000 } as any;
  });

  return { figures, clock };
}

const opusTurn = {
  reason: "answer",
  answer: "ok",
  durationMs: 1,
  isAborted: false,
  turnId: "t1",
  usage: {
    model: "claude-opus-5-5",
    input_tokens: 100,
    output_tokens: 912,
    cache_read_input_tokens: 98_000,
    cache_creation_input_tokens: 1_900,
  },
};

describe("chef-station", () => {
  test("the usage station shows plan limits, today and now", { options: { plan: "Max 5×" } }, async ($, on) => {
    const { figures } = kitchen(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);

    figures.usd = 0.14;
    await $.turn.complete(opusTurn as any);

    for (const surface of ["terminal", "desktop"] as const) {
      const ui = await $.ui.mount({ ...BAND, surface } as any);

      expect(await ui.find({ type: "Text", text: /Max 5×/ })).toBeDefined();
      expect(await ui.find({ type: "Text", text: /^Week$/ })).toBeDefined();
      expect(await ui.find({ type: "Text", text: /85%/ })).toBeDefined();
      expect(await ui.find({ type: "Text", text: /↻ 1d 23h/ })).toBeDefined();
      expect(await ui.find({ type: "Text", text: /↻ 2h 10m/ })).toBeDefined();
      expect(await ui.find({ type: "Text", text: /^\$0\.14$/ })).toBeDefined();
      expect(await ui.find({ type: "Text", text: /100\.9k tokens · 98% from cache/ })).toBeDefined();
      expect(await ui.find({ type: "Text", text: /create-project-calavera/ })).toBeDefined();
      expect(await ui.find({ type: "Text", text: /Opus 5\.5 · 912 written · \$0\.14 · context 18%/ })).toBeDefined();

      await ui.unmount();
    }
  });

  test("each turn adds only its own share of the session cost", async ($, on) => {
    const { figures } = kitchen(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);

    figures.usd = 1.5;
    await $.turn.complete(opusTurn as any);
    figures.usd = 2;
    await $.turn.complete({ ...opusTurn, agentId: "sub", usage: { ...opusTurn.usage, model: "claude-haiku-4-5-20251001" } } as any);

    const ui = await $.ui.mount({ ...BAND, surface: "terminal" } as any);
    await ui.press({ key: "station-breakdown" });

    expect(await ui.find({ type: "Text", text: "Opus 5.5" })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /\$1\.50/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: "Haiku 4.5" })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /\$0\.50/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /\$2\.00/ })).toBeDefined(); // the project's total
    await ui.unmount();
  });

  test("the ledger carries over from an earlier session", async ($, on) => {
    const yesterday = "2026-10-05";
    kitchen(on, {
      ledger: {
        version: 1,
        days: {
          [yesterday]: {
            usd: 9,
            tokens: 494_000_000,
            cacheReadTokens: 0,
            inputTokens: 0,
            hours: new Array(24).fill(0),
            models: {},
            projects: {},
          },
        },
      },
      station: "activity",
    });
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);

    const ui = await $.ui.mount({ ...BAND, surface: "terminal" } as any);
    expect(await ui.find({ type: "Text", text: "494M tokens" })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /Oct 05 · 494M|05 Oct · 494M/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: "1 day" })).toBeDefined();
    await ui.unmount();
  });

  test("the trend station totals today's spend by hour", async ($, on) => {
    const { figures, clock } = kitchen(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);

    figures.usd = 3;
    await $.turn.complete(opusTurn as any);
    await clock.advance(2 * HOUR);
    figures.usd = 4.25;
    await $.turn.complete(opusTurn as any);

    const ui = await $.ui.mount({ ...BAND, surface: "terminal" } as any);
    await ui.press({ key: "station-trend" });
    expect(await ui.find({ type: "Text", text: "Today · $4.25" })).toBeDefined();
    await ui.unmount();
  });

  test("/chef switches stations and refuses unknown ones", async ($, on) => {
    kitchen(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);

    expect(await $.command.run({ command: "chef", args: "activity" } as any)).toMatchObject({ text: "Chef tray: activity" });
    expect(await $.command.run({ command: "chef", args: "" } as any)).toMatchObject({ text: "Chef tray: context" });
    expect(await $.command.run({ command: "chef", args: "pantry" } as any)).toMatchObject({ text: expect.stringContaining("No station") });
  });

  test("the tray gives way to a survey", async ($, on) => {
    kitchen(on);
    on("ui.render", () => ({ type: "Box", props: {}, children: [] }) as any);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);

    const ui = await $.ui.mount({ ...BAND, surface: "terminal", props: { ...BAND.props, hasSurvey: true } } as any);
    expect(await ui.find({ type: "Text", text: /Claude/ })).toBeUndefined();
    await ui.unmount();
  });

  test("the Now row times the running turn, then shows how long it took", async ($, on) => {
    const { clock } = kitchen(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    const ui = await $.ui.mount({ ...BAND, surface: "terminal", props: { ...BAND.props, isWorking: true } } as any);

    await $.turn.start({ text: "cook", turnId: "t1" } as any);
    await clock.advance(33_000);
    expect(await ui.find({ type: "Text", text: /0:33/ })).toBeDefined();

    await $.turn.complete({ ...opusTurn, durationMs: 72_000 } as any);
    expect(await ui.find({ type: "Text", text: /last turn 1:12/ })).toBeDefined();
    await ui.unmount();
  });

  test("/chef backfill adds the transcripts' history, leaving out sessions already counted", async ($, on) => {
    const { figures } = kitchen(on, {
      "turns:earlier-session": {
        version: 1,
        days: {
          "2026-10-06": { usd: 1, tokens: 10, cacheReadTokens: 0, inputTokens: 0, hours: new Array(24).fill(0), models: {}, projects: {} },
        },
        liveSessions: { "earlier-session": "2026-10-06" },
      },
    });
    figures.scan = {
      ...EMPTY_SCAN,
      files: 12,
      days: {
        "2026-10-05": {
          usd: 9,
          tokens: 494_000_000,
          cacheReadTokens: 0,
          inputTokens: 0,
          hours: new Array(24).fill(0),
          models: { "claude-opus-5-5": 9 },
          projects: { cli: 9 },
        },
      },
    };
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);

    const { text } = await $.command.run({ command: "chef", args: "backfill" } as any);
    expect(text).toBe("Read 12 transcripts with Node: $9.00 across 1 days.");

    const call = figures.scanCalls[figures.scanCalls.length - 1]!;
    expect(call.argv).toContain("/home/chef/.claude/projects");
    expect(JSON.parse(call.stdin ?? "[]")).toEqual(["earlier-session", "this-session"]);

    await $.command.run({ command: "chef", args: "activity" } as any);
    const ui = await $.ui.mount({ ...BAND, surface: "terminal" } as any);
    expect(await ui.find({ type: "Text", text: "494M tokens" })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /History from 12 transcripts/ })).toBeDefined();
    await ui.unmount();
  });

  test("another session's turns are kept and added, never overwritten", async ($, on) => {
    const other = {
      version: 1,
      days: {
        "2026-10-06": {
          usd: 5,
          tokens: 1_000,
          cacheReadTokens: 0,
          inputTokens: 0,
          hours: new Array(24).fill(0),
          models: { "Sonnet 5.5": 5 },
          projects: { cli: 5 },
        },
      },
      liveSessions: { "other-session": "2026-10-06" },
    };
    const store: Record<string, unknown> = { "turns:other-session": other };
    const { figures } = kitchen(on, store);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);

    figures.usd = 1;
    await $.turn.complete(opusTurn as any);

    const ui = await $.ui.mount({ ...BAND, surface: "terminal" } as any);
    expect(await ui.find({ type: "Text", text: /^\$6\.00$/ })).toBeDefined();
    await ui.press({ key: "station-breakdown" });
    expect(await ui.find({ type: "Text", text: "Sonnet 5.5" })).toBeDefined();
    expect(await ui.find({ type: "Text", text: "Opus 5.5" })).toBeDefined();
    await ui.unmount();
  });

  test("without Node, a transcript that cannot be read marks the backfill incomplete and keeps the rest", async ($, on) => {
    const { figures } = kitchen(on);
    figures.hasNoNode = true;
    const projects = "/home/chef/.claude/projects";
    const response = JSON.stringify({
      type: "assistant",
      requestId: "req_1",
      sessionId: "older-session",
      cwd: "/work/cli",
      timestamp: new Date(START - HOUR).toISOString(),
      message: {
        id: "msg_1",
        model: "claude-opus-5-5",
        usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });

    on("fs.list", ($, e) => ({
      value:
        e.path === projects
          ? [
              { name: "good.jsonl", kind: "file", size: 100, mtimeMs: 0, isLink: false },
              { name: "locked.jsonl", kind: "file", size: 100, mtimeMs: 0, isLink: false },
              { name: "huge.jsonl", kind: "file", size: 5 * 1024 * 1024, mtimeMs: 0, isLink: false },
            ]
          : [],
    }) as any);
    on("fs.read", ($, e: any) => {
      if (e.path.endsWith("locked.jsonl")) {
        throw new Error("EACCES");
      }

      return { value: response } as any;
    });

    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    const { text } = await $.command.run({ command: "chef", args: "backfill" } as any);

    expect(text).toBe(
      "Read 3 transcripts: $4.00 across 1 days. 1 over 4 MiB were skipped; install Node to include them. Incomplete: 1 could not be read, so their usage is missing.",
    );
  });

  test("the Now row names the session's model before any turn, and follows a /model switch", async ($, on) => {
    const { figures } = kitchen(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    const ui = await $.ui.mount({ ...BAND, surface: "terminal" } as any);

    expect(await ui.find({ type: "Text", text: /^ · Opus 5\.5 · / })).toBeDefined();

    figures.model = "claude-sonnet-5-5";
    await $.turn.start({ text: "cook", turnId: "t2" } as any);
    expect(await ui.find({ type: "Text", text: /^ · Sonnet 5\.5 · / })).toBeDefined();
    await ui.unmount();
  });

  test("the context station breaks the window down by category, and follows each turn", async ($, on) => {
    const { figures } = kitchen(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    expect(await $.command.run({ command: "chef", args: "context" } as any)).toMatchObject({ text: "Chef tray: context" });

    for (const surface of ["terminal", "desktop"] as const) {
      const ui = await $.ui.mount({ ...BAND, surface } as any);

      expect(await ui.find({ type: "Text", text: "24k of 200k tokens (12%)" })).toBeDefined();
      expect(await ui.find({ type: "Text", text: "System prompt" })).toBeDefined();
      expect(await ui.find({ type: "Text", text: "Messages" })).toBeDefined();
      expect(await ui.find({ type: "Text", text: "Autocompact buffer" })).toBeDefined();
      // Schemas loaded on demand sit outside the window.
      expect(await ui.find({ type: "Text", text: "MCP tools" })).toBeUndefined();
      // The bar hands out colors in its own order, then draws free space and the buffer as textures.
      expect(await barColors(ui)).toEqual(["#3987e5", "#d95926", "#199e70", "subtle", "subtle"]);
      await ui.unmount();
    }

    figures.breakdown = breakdownOf(3_000, 45_000);
    await $.turn.complete(opusTurn as any);

    const ui = await $.ui.mount({ ...BAND, surface: "terminal" } as any);
    expect(await ui.find({ type: "Text", text: "60k of 200k tokens (30%)" })).toBeDefined();
    await ui.unmount();
  });

  test("Compact compacts the conversation and says how much it saved", async ($, on) => {
    const { figures } = kitchen(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    await $.command.run({ command: "chef", args: "context" } as any);
    const ui = await $.ui.mount({ ...BAND, surface: "terminal" } as any);

    await ui.press({ key: "context-compact" });

    expect(figures.compactions).toBe(1);
    expect(await ui.find({ type: "Text", text: "Compacted from 120k to 18k tokens." })).toBeDefined();
    await ui.unmount();
  });

  test("Clear asks first, and only clears once confirmed", async ($, on) => {
    const { figures } = kitchen(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    await $.command.run({ command: "chef", args: "context" } as any);
    const ui = await $.ui.mount({ ...BAND, surface: "terminal" } as any);

    await ui.press({ key: "context-clear" });
    expect(figures.commandsRun).toEqual([]);
    expect(await ui.find({ type: "Text", text: /^Clear the conversation\?/ })).toBeDefined();

    await ui.press({ key: "context-clear-cancel" });
    expect(await ui.find({ type: "Text", text: /^Clear the conversation\?/ })).toBeUndefined();
    expect(figures.commandsRun).toEqual([]);

    await ui.press({ key: "context-clear" });
    await ui.press({ key: "context-clear-confirm" });
    expect(figures.commandsRun).toEqual(["clear"]);
    expect(await ui.find({ type: "Text", text: /^Clear the conversation\?/ })).toBeUndefined();
    await ui.unmount();
  });

  test("while Claude is working, the buttons give way to a note", async ($, on) => {
    kitchen(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    await $.command.run({ command: "chef", args: "context" } as any);
    const ui = await $.ui.mount({ ...BAND, surface: "terminal", props: { ...BAND.props, isWorking: true } } as any);

    expect(await ui.find({ key: "context-compact" })).toBeUndefined();
    expect(await ui.find({ key: "context-clear" })).toBeUndefined();
    expect(await ui.find({ type: "Text", text: "Clear and Compact are available once Claude finishes." })).toBeDefined();
    await ui.unmount();
  });

  test("a session cost that starts over, as after /clear, is still recorded", async ($, on) => {
    const { figures } = kitchen(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);

    figures.usd = 5;
    await $.turn.complete(opusTurn as any);
    figures.usd = 0.5;
    await $.turn.complete(opusTurn as any);

    const ui = await $.ui.mount({ ...BAND, surface: "terminal" } as any);
    expect(await ui.find({ type: "Text", text: /^\$5\.50$/ })).toBeDefined();
    await ui.unmount();
  });
});
