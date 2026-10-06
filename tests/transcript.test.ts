import { describe, expect, test } from "claude-code/testing";

import { addTranscript, costOf, createTally, readLine } from "../hooks/transcript.mjs";

/** Floating-point sums of dollars, compared to a millionth of a cent. */
const round = (usd: number | undefined) => (usd === undefined ? usd : Math.round(usd * 1e8) / 1e8);

const line = (overrides: Record<string, unknown> = {}, usage: Record<string, unknown> = {}, message: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "assistant",
    requestId: "req_1",
    sessionId: "s1",
    cwd: "/work/create-project-calavera",
    timestamp: new Date(2026, 9, 6, 14, 5).toISOString(),
    ...overrides,
    message: {
      id: "msg_1",
      model: "claude-opus-5-5",
      content: [{ type: "text", text: "hi" }],
      usage: {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 2_000_000,
        cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 },
        ...usage,
      },
      ...message,
    },
  });

describe("transcript", () => {
  test("reads an assistant response's usage", async () => {
    const entry = readLine(line());
    expect(entry).toMatchObject({
      id: "msg_1:req_1",
      sessionId: "s1",
      project: "create-project-calavera",
      model: "claude-opus-5-5",
      usage: { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000 },
    });
  });

  test("ignores lines that are not priced responses", async () => {
    expect(readLine("")).toBeUndefined();
    expect(readLine("{not json")).toBeUndefined();
    expect(readLine(JSON.stringify({ type: "user", message: { content: "usage" } }))).toBeUndefined();
    expect(readLine(line({}, {}, { model: "<synthetic>" }))).toBeUndefined();
  });

  test("prices every token kind at the model's rates", async () => {
    // Opus 5.5: $4 input, $20 output, $0.20 cache read, 1.25x and 2x input for 5m and 1h writes.
    expect(round(costOf(readLine(line())!))).toBe(round(4 + 20 + 0.2 + 5 + 8));
  });

  test("fast mode doubles the price", async () => {
    expect(round(costOf(readLine(line({}, { speed: "fast" }))!))).toBe(round(2 * 37.2));
  });

  test("cache writes with no TTL breakdown count as five-minute writes", async () => {
    const entry = readLine(line({}, { cache_creation: undefined }))!;
    expect(entry.usage.cacheWrite5m).toBe(2_000_000);
    expect(entry.usage.cacheWrite1h).toBe(0);
  });

  test("a model with no known price has no cost", async () => {
    expect(costOf(readLine(line({}, {}, { model: "some-gateway-model" }))!)).toBeUndefined();
  });
});

describe("tally", () => {
  const since = new Date(2026, 6, 1).getTime();

  test("counts each response once, however many lines repeat it", async () => {
    const tally = createTally({ since });
    tally.add(readLine(line()));
    tally.add(readLine(line()));
    tally.add(readLine(line({ requestId: "req_2" })));

    const { days } = tally.result();
    const day = days["2026-10-06"]!;
    expect(day.tokens).toBe(2 * 5_000_000);
    expect(round(day.usd)).toBe(round(2 * 37.2));
    expect(round(day.hours[14])).toBe(round(2 * 37.2));
    expect(round(day.models["claude-opus-5-5"])).toBe(round(2 * 37.2));
    expect(round(day.projects["create-project-calavera"])).toBe(round(2 * 37.2));
    expect(day.cacheReadTokens).toBe(2_000_000);
    expect(day.inputTokens).toBe(2 * 4_000_000);
  });

  test("skips sessions the tray already counted and days out of range", async () => {
    const tally = createTally({ since, excludeSessions: ["s1"] });
    tally.add(readLine(line()));
    tally.add(readLine(line({ sessionId: "s2", timestamp: new Date(2026, 0, 1).toISOString() })));
    expect(tally.result().days).toEqual({});
  });

  test("names the models it could not price", async () => {
    const tally = createTally({ since });
    tally.add(readLine(line({}, {}, { model: "some-gateway-model" })));
    const result = tally.result();
    expect(result.unpricedModels).toEqual(["some-gateway-model"]);
    expect(result.days["2026-10-06"]!.tokens).toBe(5_000_000);
  });
});

describe("addTranscript", () => {
  const since = new Date(2026, 6, 1).getTime();

  test("adds a file's responses once it has been read to its end", async () => {
    const tally = createTally({ since });
    expect(await addTranscript([line(), line({ requestId: "req_2" })], tally)).toBe(true);
    expect(tally.result().responses).toBe(2);
  });

  test("a file that fails partway adds nothing", async () => {
    const tally = createTally({ since });
    async function* failing() {
      yield line();
      throw new Error("EIO");
    }

    expect(await addTranscript(failing(), tally)).toBe(false);
    expect(tally.result().responses).toBe(0);
    expect(tally.result().days).toEqual({});
  });
});
