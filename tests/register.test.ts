import { describe, expect, mock, test } from "claude-code/testing";
import type { On } from "claude-code";

// Tuesday, 6 October 2026, 14:00 local time.
const START = new Date(2026, 9, 6, 14, 0).getTime();
const HOUR = 3_600_000;

/** The sidebar, docked beside the transcript and 100 cells across. */
const PANE = {
  plugin: "chef-station",
  component: "Pane",
  requestId: "chef-station",
  props: { title: "Chef Station", isFocused: false, bodyColumns: 100, placement: "dock", scroll: { offset: 0, bodyRows: 40 }, view: {} },
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

/**
 * The colors of the context bar's segments, left to right: the Texts drawn with block or shade glyphs in
 * the row that has the most of them, as Usage's meters, open beside it, have only two.
 */
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
  return rows.reduce<string[]>((most, row) => (row.length > most.length ? row : most), []);
}

/** What the Node helper prints when it finds nothing. */
const EMPTY_SCAN = { days: {}, unpricedModels: [], files: 0, skippedFiles: 0, responses: 0 };

/** Stands in for Claude Code beneath the mod: the session's figures, the store, the clock and the helper. */
function kitchen(on: On, store: Record<string, unknown> = {}) {
  const figures = {
    usd: 0,
    /** Files by path: transcripts, for the cache lifetime and the Agents station, and session registry entries. */
    transcripts: {} as Record<string, string>,
    /** What `TZ=UTC ps -o pid=,lstart=` prints: the running pids and when each started. */
    ps: "",
    /** How many times the Agents station ran `ps`, so a test can tell when it refreshed. */
    psCalls: 0,
    /** Whether `ps` cannot run. */
    hasNoPs: false,
    model: "claude-opus-5-5[1m]",
    breakdown: breakdownOf(3_000, 9_000) as unknown,
    scan: EMPTY_SCAN as unknown,
    scanCalls: [] as { argv: readonly string[]; stdin?: string }[],
    /** Slash commands the mod ran, other than its own. */
    commandsRun: [] as string[],
    compactions: 0,
    /** Whether the Node helper is missing, so the mod reads the transcripts itself. */
    hasNoNode: false,
    /** The panes the mod has open, by id. */
    panes: {} as Record<string, { title?: string; isPlaced: boolean }>,
    /** Whether the terminal is too narrow to place a pane nobody asked for. */
    isNarrow: false,
    toasts: [] as string[],
    rateLimits: [
      { kind: "five_hour", percentUsed: 12, resetsAt: new Date(START + 2 * HOUR + 10 * 60_000).toISOString() },
      { kind: "seven_day", percentUsed: 85, resetsAt: new Date(START + 47 * HOUR + 5 * 60_000).toISOString() },
    ],
  };

  const clock = mock.clock(on, { now: START });
  // The store as a plain object the test holds, so a test can read what the mod kept for the next session.
  on("store.get", ($, e) => ({ value: store[e.key] }));
  on("store.set", ($, e) => {
    // A copy, as the engine keeps one: a value the real store would change cannot slip through.
    store[e.key] = JSON.parse(JSON.stringify(e.value));
    return { value: undefined };
  });
  on("store.delete", ($, e) => {
    delete store[e.key];
    return { value: undefined };
  });
  on("store.keys", () => ({ value: Object.keys(store) }));
  mock.env(on, { HOME: "/home/chef" });
  on("session.start", ($, e) => ({ cwd: e.cwd }));
  on("session.root", () => ({ value: "/work/create-project-calavera" }));
  on("session.id", () => ({ value: "this-session" }));
  on("session.model", () => ({ value: figures.model }));
  on("turn.start", ($, e) => ({ turnId: e.turnId }));
  on("process.run", ($, e) => {
    if (e.argv[0] === "ps") {
      figures.psCalls += 1;

      if (figures.hasNoPs) {
        // A deny is how a call on `$` rejects, as it does when the command cannot start.
        return { deny: "spawn ps ENOENT" };
      }

      return { value: { exitCode: 0, stdout: figures.ps, stderr: "", isStdoutTruncated: false, isStderrTruncated: false } };
    }

    if (e.argv[0] === "tail") {
      const text = figures.transcripts[e.argv[e.argv.length - 1]!];
      return { value: { exitCode: text === undefined ? 1 : 0, stdout: text ?? "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } };
    }

    if (figures.hasNoNode) {
      // A deny is how a call on `$` rejects, as it does when the command cannot start; a hook that throws is skipped instead.
      return { deny: "spawn node ENOENT" };
    }

    figures.scanCalls.push({ argv: e.argv, stdin: e.init?.stdin });
    return { value: { exitCode: 0, stdout: JSON.stringify(figures.scan), stderr: "", isStdoutTruncated: false, isStderrTruncated: false } };
  });
  on("command.register", ($, e) => ({ value: { command: e.name } }));
  on("ui.open", ($, e) => {
    figures.panes[e.id] = { title: e.title, isPlaced: !figures.isNarrow };
    return { value: figures.isNarrow ? { isPlaced: false, reason: "unasked panes need 144 columns; 100 now" } : { isPlaced: true } };
  });
  on("ui.toast", ($, e) => {
    figures.toasts.push(e.text);
    return { value: undefined };
  });
  on("ui.panes", () => ({
    value: Object.entries(figures.panes).map(([id, pane]) => ({
      id,
      title: pane.title ?? id,
      isShown: true,
      isFocused: false,
      isPlaced: pane.isPlaced,
    })),
  }));
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
  on("turn.step", async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: "", toolUses: [] } as any;
  });
  on("classic.Stop", () => ({}) as any);
  on("fs.stat", ($, e: any) => ({ value: { kind: "file", size: (figures.transcripts[e.path] ?? "").length, mtimeMs: 0, isLink: false } }) as any);
  on("fs.read", ($, e: any) => {
    const text = figures.transcripts[e.path];

    if (text === undefined) {
      throw new Error("ENOENT");
    }

    return { value: text } as any;
  });
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
      const ui = await $.ui.mount({ ...PANE, surface } as any);

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

    const ui = await $.ui.mount({ ...PANE, surface: "terminal" } as any);
    await ui.press({ key: "section-breakdown" });

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

    const ui = await $.ui.mount({ ...PANE, surface: "terminal" } as any);
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

    const ui = await $.ui.mount({ ...PANE, surface: "terminal" } as any);
    await ui.press({ key: "section-trend" });
    expect(await ui.find({ type: "Text", text: "Today · $4.25" })).toBeDefined();
    await ui.unmount();
  });

  test("/chef opens a station's section and refuses unknown ones", async ($, on) => {
    kitchen(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);

    expect(await $.command.run({ command: "chef", args: "activity" } as any)).toMatchObject({ text: "Chef Station: activity is open." });
    expect(await $.command.run({ command: "chef", args: "pantry" } as any)).toMatchObject({ text: expect.stringContaining("No station") });

    const ui = await $.ui.mount({ ...PANE, surface: "terminal" } as any);
    expect(await ui.find({ type: "Button", text: "▾ Activity" })).toBeDefined();
    expect(await ui.find({ type: "Button", text: "▾ Usage" })).toBeDefined();
    expect(await ui.find({ type: "Button", text: "▸ Trend" })).toBeDefined();
    await ui.unmount();
  });

  test("the sidebar stays closed as the session starts, and /chef opens it", async ($, on) => {
    const { figures } = kitchen(on);
    await $.session.start({ surface: "desktop", isInteractive: true, cwd: "/work" } as any);
    expect(figures.panes["chef-station"]).toBeUndefined();

    expect(await $.command.run({ command: "chef", args: "" } as any)).toMatchObject({ text: "Chef Station is open." });
    expect(figures.panes["chef-station"]).toEqual({ title: "Chef Station", isPlaced: true });
  });

  test("a section's header opens and closes it, and the open sections carry over to the next session", async ($, on) => {
    const store: Record<string, unknown> = {};
    kitchen(on, store);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    const ui = await $.ui.mount({ ...PANE, surface: "terminal" } as any);

    // Only Usage starts open; Breakdown's header still shows what it would show.
    expect(await ui.find({ type: "Button", text: "▾ Usage" })).toBeDefined();
    expect(await ui.find({ type: "Text", text: "Today" })).toBeDefined();
    expect(await ui.find({ type: "Button", text: "▸ Context" })).toBeDefined();
    expect(await ui.find({ type: "Text", text: "12% used" })).toBeDefined();

    await ui.press({ key: "section-usage" });
    await ui.press({ key: "section-context" });
    expect(await ui.find({ type: "Button", text: "▸ Usage" })).toBeDefined();
    expect(await ui.find({ type: "Text", text: "Today" })).toBeUndefined();
    expect(await ui.find({ type: "Button", text: "▾ Context" })).toBeDefined();
    expect(store.openSections).toEqual(["context"]);
    await ui.unmount();
  });

  test("the station 0.6.0 showed starts open beside Usage, and its key makes way for the new one", async ($, on) => {
    const store: Record<string, unknown> = { station: "activity" };
    kitchen(on, store);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    const ui = await $.ui.mount({ ...PANE, surface: "terminal" } as any);

    expect(await ui.find({ type: "Button", text: "▾ Usage" })).toBeDefined();
    expect(await ui.find({ type: "Button", text: "▾ Activity" })).toBeDefined();
    expect(await ui.find({ type: "Button", text: "▸ Trend" })).toBeDefined();
    expect(store).toMatchObject({ openSections: ["usage", "activity"] });
    expect("station" in store).toBe(false);
    await ui.unmount();
  });

  test("a session opens the sections the last one left open, all of them closed included", async ($, on) => {
    kitchen(on, { openSections: [] });
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    const ui = await $.ui.mount({ ...PANE, surface: "terminal" } as any);

    expect(await ui.findAll({ type: "Button", text: /^▾ / })).toEqual([]);
    expect(await ui.find({ type: "Button", text: "▸ Usage" })).toBeDefined();
    await ui.unmount();
  });

  test("stored sections that are no station, or a stored value that is no list, are left out", async ($, on) => {
    kitchen(on, { openSections: ["trend", "pantry"] });
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    const ui = await $.ui.mount({ ...PANE, surface: "terminal" } as any);

    expect((await ui.findAll({ type: "Button", text: /^▾ / })).map((found) => found.text)).toEqual(["▾ Trend"]);
    await ui.unmount();
  });

  test("before the session has started, the sidebar says it is getting ready", async ($, on) => {
    kitchen(on);
    const ui = await $.ui.mount({ ...PANE, surface: "terminal" } as any);
    expect(await ui.find({ type: "Text", text: "Getting the kitchen ready…" })).toBeDefined();
    await ui.unmount();
  });

  test("the Now row times the running turn, then shows how long it took", async ($, on) => {
    const { clock } = kitchen(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    const ui = await $.ui.mount({ ...PANE, surface: "terminal" } as any);

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
    const ui = await $.ui.mount({ ...PANE, surface: "terminal" } as any);
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

    const ui = await $.ui.mount({ ...PANE, surface: "terminal" } as any);
    expect(await ui.find({ type: "Text", text: /^\$6\.00$/ })).toBeDefined();
    await ui.press({ key: "section-breakdown" });
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
    // locked.jsonl has no entry here, so reading it fails.
    figures.transcripts[`${projects}/good.jsonl`] = response;

    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    const { text } = await $.command.run({ command: "chef", args: "backfill" } as any);

    expect(text).toBe(
      "Read 3 transcripts: $4.00 across 1 days. 1 over 4 MiB were skipped; install Node to include them. Incomplete: 1 could not be read, so their usage is missing.",
    );
  });

  test("the Now row names the session's model before any turn, and follows a /model switch", async ($, on) => {
    const { figures } = kitchen(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    const ui = await $.ui.mount({ ...PANE, surface: "terminal" } as any);

    expect(await ui.find({ type: "Text", text: /^ · Opus 5\.5 · / })).toBeDefined();

    figures.model = "claude-sonnet-5-5";
    await $.turn.start({ text: "cook", turnId: "t2" } as any);
    expect(await ui.find({ type: "Text", text: /^ · Sonnet 5\.5 · / })).toBeDefined();
    await ui.unmount();
  });

  test("the Now row counts the prompt cache down from the main conversation's last request", async ($, on) => {
    const { figures, clock } = kitchen(on);
    const transcript = "/home/chef/.claude/projects/-work/this-session.jsonl";
    figures.transcripts[transcript] = JSON.stringify({
      type: "assistant",
      isSidechain: false,
      message: {
        usage: {
          input_tokens: 2,
          output_tokens: 10,
          cache_read_input_tokens: 40_000,
          cache_creation_input_tokens: 900,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 900 },
        },
      },
    });
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    const ui = await $.ui.mount({ ...PANE, surface: "terminal" } as any);

    // Before any request there is no cache to speak of.
    expect(await ui.find({ type: "Text", text: /^cache (warm|expired)/ })).toBeUndefined();

    // Until a turn ends and the transcript says otherwise, the shorter five minutes is assumed.
    await drain($.turn.step({ turnId: "t1", index: 0, model: "claude-opus-5-5", messageCount: 1 } as any));
    await clock.advance(60_000);
    // On a line of its own, so it never squeezes the session's figures in a narrow sidebar.
    expect(await ui.find({ type: "Text", text: /^cache warm · ~4m left$/ })).toBeDefined();

    await $.classic.Stop({ transcript_path: transcript, stop_hook_active: false } as any);
    await clock.advance(17 * 60_000);
    expect(await ui.find({ type: "Text", text: /^cache warm · ~42m left$/ })).toBeDefined();

    // A subagent's request uses its own cache, so the main conversation's countdown keeps running.
    await drain($.turn.step({ turnId: "t2", index: 0, model: "claude-haiku-4-5", messageCount: 1, agentId: "sub" } as any));
    await clock.advance(43 * 60_000);
    expect(await ui.find({ type: "Text", text: "cache expired" })).toBeDefined();
    await ui.unmount();
  });

  test("a /clear starts the cache over, with nothing to count down", async ($, on) => {
    const { clock } = kitchen(on);
    on("session.end", ($, e) => ({ sessionId: e.sessionId }));
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    const ui = await $.ui.mount({ ...PANE, surface: "terminal" } as any);

    await drain($.turn.step({ turnId: "t1", index: 0, model: "claude-opus-5-5", messageCount: 1 } as any));
    await $.session.end({ reason: "clear", sessionId: "this-session", resume: {} } as any);
    await clock.advance(60_000);

    expect(await ui.find({ type: "Text", text: /^cache (warm|expired)/ })).toBeUndefined();
    await ui.unmount();
  });

  test("the context station breaks the window down by category, and follows each turn", async ($, on) => {
    const { figures } = kitchen(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    expect(await $.command.run({ command: "chef", args: "context" } as any)).toMatchObject({ text: "Chef Station: context is open." });

    for (const surface of ["terminal", "desktop"] as const) {
      const ui = await $.ui.mount({ ...PANE, surface } as any);

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

    const ui = await $.ui.mount({ ...PANE, surface: "terminal" } as any);
    expect(await ui.find({ type: "Text", text: "60k of 200k tokens (30%)" })).toBeDefined();
    await ui.unmount();
  });

  test("Compact compacts the conversation and says how much it saved", async ($, on) => {
    const { figures } = kitchen(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    await $.command.run({ command: "chef", args: "context" } as any);
    const ui = await $.ui.mount({ ...PANE, surface: "terminal" } as any);

    await ui.press({ key: "context-compact" });

    expect(figures.compactions).toBe(1);
    expect(await ui.find({ type: "Text", text: "Compacted from 120k to 18k tokens." })).toBeDefined();
    await ui.unmount();
  });

  test("Clear asks first, and only clears once confirmed", async ($, on) => {
    const { figures } = kitchen(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    await $.command.run({ command: "chef", args: "context" } as any);
    const ui = await $.ui.mount({ ...PANE, surface: "terminal" } as any);

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
    // A running turn is how the sidebar knows Claude is working.
    await $.turn.start({ text: "cook", turnId: "t1" } as any);
    const ui = await $.ui.mount({ ...PANE, surface: "terminal" } as any);

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

    const ui = await $.ui.mount({ ...PANE, surface: "terminal" } as any);
    expect(await ui.find({ type: "Text", text: /^\$5\.50$/ })).toBeDefined();
    await ui.unmount();
  });

  test("pressing Compact twice in quick succession compacts once", async ($, on) => {
    const { figures } = kitchen(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    await $.command.run({ command: "chef", args: "context" } as any);
    const ui = await $.ui.mount({ ...PANE, surface: "terminal" } as any);

    await Promise.all([ui.press({ key: "context-compact" }), ui.press({ key: "context-compact" })]);

    expect(figures.compactions).toBe(1);
    await ui.unmount();
  });

  test("after /clear, the first turn's cost counts in full even when it exceeds the old total", async ($, on) => {
    const { figures } = kitchen(on);
    on("session.end", ($, e) => ({ sessionId: e.sessionId }));
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);

    figures.usd = 0.3;
    await $.turn.complete(opusTurn as any);
    await $.session.end({ reason: "clear", sessionId: "this-session", resume: {} } as any);
    figures.usd = 0.5;
    await $.turn.complete(opusTurn as any);

    const ui = await $.ui.mount({ ...PANE, surface: "terminal" } as any);
    expect(await ui.find({ type: "Text", text: /^\$0\.80$/ })).toBeDefined();
    await ui.unmount();
  });

  test("after a typed /clear, the Context station stops showing the previous conversation", async ($, on) => {
    kitchen(on);
    on("session.end", ($, e) => ({ sessionId: e.sessionId }));
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    await $.command.run({ command: "chef", args: "context" } as any);
    const ui = await $.ui.mount({ ...PANE, surface: "terminal" } as any);
    expect(await ui.find({ type: "Text", text: "24k of 200k tokens (12%)" })).toBeDefined();

    await $.session.end({ reason: "clear", sessionId: "this-session", resume: {} } as any);

    expect(await ui.find({ type: "Text", text: "24k of 200k tokens (12%)" })).toBeUndefined();
    expect(await ui.find({ type: "Text", text: "Measuring the context window…" })).toBeDefined();
    await ui.unmount();
  });

  describe("the Agents station", () => {
    const SESSIONS = "/home/chef/.claude/sessions";
    const SHOP_TRANSCRIPT = "/home/chef/.claude/projects/-work-shop/shop-session.jsonl";

    /** Five registered sessions: a busy one in the desktop app, an idle terminal, one waiting on the person, one that ended and one whose pid was reused. */
    function registerSessions(on: On, figures: ReturnType<typeof kitchen>["figures"]) {
      const entries = [
        { pid: 4242, sessionId: "shop-session", cwd: "/work/shop", name: "Checkout fixes", entrypoint: "claude-desktop", status: "busy", procStart: "Tue Oct  6 11:00:00 2026" },
        { pid: 77, sessionId: "cli-session", cwd: "/work/cli", name: "cli", entrypoint: "cli", status: "idle", procStart: "Tue Oct  6 10:00:00 2026" },
        { pid: 88, sessionId: "ask-session", cwd: "/work/api", name: "API review", entrypoint: "cli", status: "waiting", procStart: "Tue Oct  6 12:00:00 2026" },
        { pid: 999, sessionId: "ended-session", cwd: "/work/old", name: "Ended", entrypoint: "cli", status: "idle", procStart: "Mon Oct  5 09:00:00 2026" },
        { pid: 555, sessionId: "reused-session", cwd: "/work/old", name: "Reused", entrypoint: "cli", status: "busy", procStart: "Mon Oct  5 08:00:00 2026" },
      ];

      for (const entry of entries) {
        figures.transcripts[`${SESSIONS}/${entry.pid}.json`] = JSON.stringify(entry);
      }

      // pid 999 is gone, and pid 555 now belongs to a process that started later.
      figures.ps = ["4242 Tue Oct  6 11:00:00 2026", "  77 Tue Oct  6 10:00:00 2026", "  88 Tue Oct  6 12:00:00 2026", " 555 Tue Oct  6 13:00:00 2026"].join("\n");
      figures.transcripts[SHOP_TRANSCRIPT] = [
        JSON.stringify({ type: "user", timestamp: new Date(START - 120_000).toISOString(), message: { content: "Fix the voucher bug" } }),
        JSON.stringify({
          type: "assistant",
          timestamp: new Date(START - 60_000).toISOString(),
          message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/work/shop/voucher.ts" } }] },
        }),
      ].join("\n");

      on("fs.list", ($, e) => ({
        value:
          e.path === SESSIONS
            ? [...entries.map((entry) => `${entry.pid}.json`), "4242.key"].map((name) => ({ name, kind: "file", size: 1, mtimeMs: 0, isLink: false }))
            : [],
      }) as any);
    }

    for (const surface of ["terminal", "desktop"] as const) {
      test(`shows active sessions in full, waiting first, folds idle ones, and leaves out ended ones, on ${surface}`, async ($, on) => {
        const { figures } = kitchen(on);
        registerSessions(on, figures);
        await $.session.start({ surface, isInteractive: true, cwd: "/work" } as any);
        expect(await $.command.run({ command: "chef", args: "agents" } as any)).toMatchObject({ text: "Chef Station: agents is open." });

        const ui = await $.ui.mount({ ...PANE, surface } as any);
        expect(await ui.find({ type: "Text", text: "1 waiting · 2 active of 3" })).toBeDefined();
        expect(await ui.find({ type: "Text", text: "Waiting · Terminal · api · pid 88" })).toBeDefined();
        expect(await ui.find({ type: "Text", text: "● Checkout fixes" })).toBeDefined();
        expect(await ui.find({ type: "Text", text: "Busy · Desktop app · shop · pid 4242" })).toBeDefined();
        expect(await ui.find({ type: "Text", text: "Now: Edit: voucher.ts · 1m ago" })).toBeDefined();
        expect(await ui.find({ type: "Text", text: "Last asked: “Fix the voucher bug”" })).toBeDefined();
        expect(await ui.find({ type: "Text", text: /Ended|Reused/ })).toBeUndefined();

        // The waiting session needs the person, so it comes first.
        const names = (await ui.findAll({ type: "Text", text: /^[●○] \S/ })).map((found) => found.text);
        expect(names).toEqual(["● API review", "● Checkout fixes"]);

        // The idle terminal session is folded under one row until it is opened.
        expect(await ui.find({ type: "Text", text: /cli · Terminal/ })).toBeUndefined();
        await ui.press({ key: "agents-idle" });
        expect(await ui.find({ type: "Text", text: "○ cli · Terminal · cli" })).toBeDefined();
        await ui.unmount();
      });
    }

    test("refreshes every five seconds while open, once a minute while closed, and not at all out of sight", async ($, on) => {
      const { figures, clock } = kitchen(on);
      registerSessions(on, figures);
      await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
      // The start's refresh runs without holding the start up; let it finish.
      await clock.advance(0);
      // Once as the session starts, so the closed section's header has its figure.
      expect(figures.psCalls).toBe(1);
      const ui = await $.ui.mount({ ...PANE, surface: "terminal" } as any);
      expect(await ui.find({ type: "Text", text: "1 waiting · 2 active of 3" })).toBeDefined();
      await ui.unmount();

      // The sidebar is not open yet, so nothing is in sight to refresh.
      await clock.advance(120_000);
      expect(figures.psCalls).toBe(1);

      // Shown with a figure more than a minute old, the closed section's header is refreshed at once.
      await $.command.run({ command: "chef", args: "" } as any);
      await clock.advance(5_000);
      expect(figures.psCalls).toBe(2);
      await clock.advance(55_000);
      expect(figures.psCalls).toBe(2);
      await clock.advance(5_000);
      expect(figures.psCalls).toBe(3);

      await $.command.run({ command: "chef", args: "agents" } as any);
      expect(figures.psCalls).toBe(4);
      await clock.advance(5_000);
      expect(figures.psCalls).toBe(5);

      // The person closes the sidebar: the list stops refreshing until it shows again.
      delete figures.panes["chef-station"];
      await clock.advance(120_000);
      expect(figures.psCalls).toBe(5);
    });

    test("with no sessions folder, the list is empty rather than an error", async ($, on) => {
      kitchen(on);
      // A deny is how a call on `$` rejects; a hook that throws is skipped instead.
      on("fs.list", () => ({ deny: "ENOENT" }));
      await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
      await $.command.run({ command: "chef", args: "agents" } as any);

      const ui = await $.ui.mount({ ...PANE, surface: "terminal" } as any);
      expect(await ui.find({ type: "Text", text: "0 active of 0" })).toBeDefined();
      expect(await ui.find({ type: "Text", text: "No session is busy or has been active in the last 15 minutes." })).toBeDefined();
      await ui.unmount();
    });

    test("when ps cannot run, it says the refresh failed", async ($, on) => {
      const { figures } = kitchen(on);
      registerSessions(on, figures);
      figures.hasNoPs = true;
      await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
      await $.command.run({ command: "chef", args: "agents" } as any);

      const ui = await $.ui.mount({ ...PANE, surface: "terminal" } as any);
      expect(await ui.find({ type: "Text", text: /^Could not refresh: / })).toBeDefined();
      await ui.unmount();
    });
  });
});

/** Reads a streaming event to its end, as the engine does with a model request. */
async function drain(stream: AsyncIterable<unknown>) {
  for await (const _ of stream) {
    // Nothing to read: the steps here stream no chunks.
  }
}
