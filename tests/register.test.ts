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

/** Stands in for Claude Code beneath the mod: the session's figures, the store and the clock. */
function kitchen(on: On, store: Record<string, unknown> = {}) {
  const figures = {
    usd: 0,
    rateLimits: [
      { kind: "five_hour", percentUsed: 12, resetsAt: new Date(START + 2 * HOUR + 10 * 60_000).toISOString() },
      { kind: "seven_day", percentUsed: 85, resetsAt: new Date(START + 47 * HOUR + 5 * 60_000).toISOString() },
    ],
  };

  const clock = mock.clock(on, { now: START });
  mock.store(on, store);
  on("session.start", ($, e) => ({ cwd: e.cwd }));
  on("session.root", () => ({ value: "/work/create-project-calavera" }));
  on("command.register", ($, e) => ({ value: { command: e.name } }));
  on("session.usage", () => ({
    value: {
      startedAt: START,
      context: { tokens: 36_000, window: 200_000, percent: 18 },
      rateLimits: figures.rateLimits,
      cost: { usd: figures.usd },
    },
  }));
  on("turn.complete", () => ({ text: "" }));

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
      expect(await ui.find({ type: "Text", text: /Opus 5\.5 · 912 written · \$0\.14 · 0:00 · context 18%/ })).toBeDefined();

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
    expect(await $.command.run({ command: "chef", args: "" } as any)).toMatchObject({ text: "Chef tray: usage" });
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
});
