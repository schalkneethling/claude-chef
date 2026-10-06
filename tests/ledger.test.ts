import { describe, expect, test } from "claude-code/testing";

import { activity, backfillSince, composeLedger, dayKey, emptyLedger, hourly, isStale, ranked, recordTurn, today, withBackfill } from "../hooks/ledger";

// Local-time constructors keep these tests independent of the machine's time zone.
const at = (month: number, day: number, hour = 12) => new Date(2026, month - 1, day, hour, 30).getTime();

const turn = (when: number, usd: number, extra: Partial<Parameters<typeof recordTurn>[1]> = {}) => ({
  at: when,
  usd,
  model: "Opus 5.5",
  project: "calavera",
  sessionId: "live-1",
  usage: { input: 10, output: 90, cacheRead: 900, cacheCreation: 0 },
  ...extra,
});

describe("ledger", () => {
  test("a day key is the local calendar date", async () => {
    expect(dayKey(at(10, 6, 0))).toBe("2026-10-06");
    expect(dayKey(at(1, 9, 23))).toBe("2026-01-09");
  });

  test("a turn adds its cost and tokens to its day, hour, model and project", async () => {
    let ledger = recordTurn(emptyLedger(), turn(at(10, 6, 14), 1.25));
    ledger = recordTurn(ledger, turn(at(10, 6, 14), 0.75, { model: "Haiku 4.5", project: "cli" }));

    const day = today(ledger, at(10, 6, 20));
    expect(day.usd).toBe(2);
    expect(day.tokens).toBe(2_000);
    expect(day.cacheReadTokens).toBe(1_800);
    expect(day.inputTokens).toBe(1_820);
    expect(hourly(ledger, at(10, 6, 20))[14]).toBe(2);
    expect(ranked(day.models)).toEqual([
      { name: "Opus 5.5", usd: 1.25 },
      { name: "Haiku 4.5", usd: 0.75 },
    ]);
    expect(ranked(day.projects).map((entry) => entry.name)).toEqual(["calavera", "cli"]);
  });

  test("recording leaves the earlier ledger untouched", async () => {
    const before = emptyLedger();
    recordTurn(before, turn(at(10, 6), 1));
    expect(before.days).toEqual({});
  });

  test("a turn with no usage still counts its cost", async () => {
    const ledger = recordTurn(emptyLedger(), turn(at(10, 6), 0.5, { usage: undefined }));
    expect(today(ledger, at(10, 6)).usd).toBe(0.5);
    expect(today(ledger, at(10, 6)).tokens).toBe(0);
  });

  test("a day without turns reads as empty", async () => {
    const day = today(emptyLedger(), at(10, 6));
    expect(day.usd).toBe(0);
    expect(day.hours).toHaveLength(24);
  });

  test("days older than thirteen weeks are pruned", async () => {
    let ledger = recordTurn(emptyLedger(), turn(at(6, 1), 1));
    ledger = recordTurn(ledger, turn(at(10, 6), 1));
    expect(Object.keys(ledger.days)).toEqual(["2026-10-06"]);
  });

  test("ranking keeps the top entries", async () => {
    expect(ranked({ a: 1, b: 3, c: 2 }, 2)).toEqual([
      { name: "b", usd: 3 },
      { name: "c", usd: 2 },
    ]);
  });
});

describe("activity", () => {
  // Tuesday, 6 October 2026.
  const now = at(10, 6, 18);

  test("lays thirteen weeks out as columns of Monday to Sunday", async () => {
    const grid = activity(emptyLedger(), now);
    expect(grid.weeks).toHaveLength(13);
    expect(grid.weeks.every((week) => week.length === 7)).toBe(true);
    // Monday and Tuesday of this week have happened; the rest are still ahead.
    expect(grid.weeks[12]!.slice(0, 2)).toEqual([0, 0]);
    expect(grid.weeks[12]!.slice(2)).toEqual([null, null, null, null, null]);
  });

  test("totals tokens, active days, the busiest day and the streak", async () => {
    let ledger = emptyLedger();
    ledger = recordTurn(ledger, turn(at(10, 6), 1)); // today
    ledger = recordTurn(ledger, turn(at(10, 5), 1)); // yesterday
    ledger = recordTurn(ledger, turn(at(10, 5), 1));
    ledger = recordTurn(ledger, turn(at(10, 3), 1)); // a gap on the 4th

    const grid = activity(ledger, now);
    expect(grid.totalTokens).toBe(4_000);
    expect(grid.activeDays).toBe(3);
    expect(grid.busiest).toEqual({ key: "2026-10-05", tokens: 2_000 });
    expect(grid.streak).toBe(2);
    expect(grid.weeks[12]![0]).toBe(2_000); // Monday the 5th
  });

  test("the streak holds through today until today's first turn", async () => {
    const ledger = recordTurn(emptyLedger(), turn(at(10, 5), 1));
    expect(activity(ledger, now).streak).toBe(1);
  });
});

describe("backfill", () => {
  const scanned = (days: Record<string, Partial<ReturnType<typeof today>>>) => ({
    days: Object.fromEntries(
      Object.entries(days).map(([key, day]) => [key, { ...today(emptyLedger(), 0), hours: new Array(24).fill(0), ...day }]),
    ),
    scannedAt: at(10, 6),
    source: "node" as const,
    files: 3,
    skippedFiles: 0,
    unpricedModels: [],
  });

  test("a live turn remembers its session so a scan can skip it", async () => {
    const ledger = recordTurn(emptyLedger(), turn(at(10, 6), 1));
    expect(ledger.liveSessions).toEqual({ "live-1": "2026-10-06" });
  });

  test("backfilled days add to live ones everywhere the tray reads", async () => {
    let ledger = recordTurn(emptyLedger(), turn(at(10, 6, 14), 1));
    ledger = withBackfill(
      ledger,
      scanned({
        "2026-10-06": { usd: 2, tokens: 3_000, hours: hoursWith(9, 2), models: { "Opus 5.5": 2 }, projects: { cli: 2 } },
        "2026-10-01": { usd: 5, tokens: 7_000 },
      }),
    );

    const day = today(ledger, at(10, 6, 20));
    expect(day.usd).toBe(3);
    expect(day.tokens).toBe(4_000);
    expect(day.models).toEqual({ "Opus 5.5": 3 });
    expect(day.projects).toEqual({ calavera: 1, cli: 2 });
    expect(hourly(ledger, at(10, 6, 20))[9]).toBe(2);
    expect(hourly(ledger, at(10, 6, 20))[14]).toBe(1);
    expect(activity(ledger, at(10, 6, 20)).totalTokens).toBe(11_000);
  });

  test("a new scan replaces the last one, and live turns keep it", async () => {
    let ledger = withBackfill(emptyLedger(), scanned({ "2026-10-01": { usd: 5, tokens: 7_000 } }));
    ledger = withBackfill(ledger, scanned({ "2026-10-02": { usd: 1, tokens: 1_000 } }));
    ledger = recordTurn(ledger, turn(at(10, 6), 1));
    expect(Object.keys(ledger.backfill!.days)).toEqual(["2026-10-02"]);
  });

  test("scans reach back as far as the ledger keeps days", async () => {
    expect(dayKey(backfillSince(at(10, 6, 18)))).toBe("2026-07-08");
  });
});

function hoursWith(hour: number, usd: number) {
  return Array.from({ length: 24 }, (_, index) => (index === hour ? usd : 0));
}

describe("sessions", () => {
  test("each session's turns add up, and every session is remembered", async () => {
    const first = recordTurn(emptyLedger(), turn(at(10, 6, 9), 1));
    const second = recordTurn(emptyLedger(), turn(at(10, 6, 14), 2, { sessionId: "live-2", project: "cli" }));
    const ledger = composeLedger({ "turns:live-1": first, "turns:live-2": second }, undefined, at(10, 6, 20));

    const day = today(ledger, at(10, 6, 20));
    expect(day.usd).toBe(3);
    expect(day.projects).toEqual({ calavera: 1, cli: 2 });
    expect(Object.keys(ledger.liveSessions ?? {}).sort()).toEqual(["live-1", "live-2"]);
  });

  test("a session with no day left in the thirteen weeks is stale", async () => {
    const old = recordTurn(emptyLedger(), turn(at(6, 1), 1));
    expect(isStale(old, at(10, 6))).toBe(true);
    expect(isStale(recordTurn(emptyLedger(), turn(at(10, 1), 1)), at(10, 6))).toBe(false);
  });
});
