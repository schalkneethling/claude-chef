import { describe, expect, test } from "claude-code/testing";

import { cacheLabel, cacheStatus, cacheTtlFromTranscript } from "../hooks/cache";

const MINUTE = 60_000;

const response = (cacheCreation: Record<string, number> | undefined, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "assistant",
    isSidechain: false,
    ...extra,
    message: {
      usage: {
        input_tokens: 2,
        output_tokens: 10,
        cache_read_input_tokens: 40_000,
        cache_creation_input_tokens: Object.values(cacheCreation ?? { x: 500 }).reduce((sum, value) => sum + value, 0),
        ...(cacheCreation ? { cache_creation: cacheCreation } : {}),
      },
    },
  });

describe("cacheTtlFromTranscript", () => {
  test("reads the lifetime of the latest cache write", async () => {
    const text = [
      response({ ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 0 }),
      response({ ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 900 }),
    ].join("\n");

    expect(cacheTtlFromTranscript(text)).toBe("1h");
  });

  test("looks past responses that only read the cache, and past subagents' responses", async () => {
    const text = [
      response({ ephemeral_5m_input_tokens: 700, ephemeral_1h_input_tokens: 0 }),
      response({ ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }),
      response({ ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 300 }, { isSidechain: true }),
      JSON.stringify({ type: "user", message: { content: "usage" } }),
    ].join("\n");

    expect(cacheTtlFromTranscript(text)).toBe("5m");
  });

  test("a cache write with no lifetime breakdown is a five-minute one", async () => {
    expect(cacheTtlFromTranscript(response(undefined))).toBe("5m");
  });

  test("knows nothing from a transcript with no cache write, or a partial first line", async () => {
    expect(cacheTtlFromTranscript('ge": "partial line cut by tail"}\n' + JSON.stringify({ type: "user" }))).toBeUndefined();
  });
});

describe("cacheStatus", () => {
  const start = new Date(2026, 9, 8, 14, 0).getTime();

  test("counts down from the start of the last request", async () => {
    expect(cacheStatus({ lastRequestAt: start, ttl: "1h" }, start + 18 * MINUTE)).toEqual({ state: "warm", remainingMs: 42 * MINUTE });
    expect(cacheStatus({ lastRequestAt: start, ttl: "5m" }, start + 6 * MINUTE)).toEqual({ state: "expired" });
  });

  test("assumes the five-minute lifetime when the transcript has not said", async () => {
    expect(cacheStatus({ lastRequestAt: start }, start + 4 * MINUTE)).toEqual({ state: "warm", remainingMs: MINUTE });
  });

  test("has nothing to say before the first request", async () => {
    expect(cacheStatus({}, start)).toEqual({ state: "none" });
  });
});

describe("cacheLabel", () => {
  test("reads as an estimate while warm, and plainly once expired", async () => {
    expect(cacheLabel({ state: "warm", remainingMs: 42 * MINUTE })).toBe("cache warm · ~42m left");
    expect(cacheLabel({ state: "warm", remainingMs: 30_000 })).toBe("cache warm · <1m left");
    expect(cacheLabel({ state: "expired" })).toBe("cache expired");
    expect(cacheLabel({ state: "none" })).toBeUndefined();
  });
});
