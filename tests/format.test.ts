import { describe, expect, test } from "claude-code/testing";

import { bar, countdown, elapsed, modelName, money, short, verticalBars } from "../hooks/format";

describe("format", () => {
  test("short numbers", async () => {
    expect(short(912)).toBe("912");
    expect(short(36_100)).toBe("36.1k");
    expect(short(37_000_000)).toBe("37M");
    expect(short(9_100_000_000)).toBe("9.1B");
  });

  test("money", async () => {
    expect(money(14.661)).toBe("$14.66");
    expect(money(0.004)).toBe("$0.00");
  });

  test("model ids read as names", async () => {
    expect(modelName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(modelName("claude-sonnet-4-20250514")).toBe("Sonnet 4");
    expect(modelName("claude-3-5-sonnet-20241022")).toBe("Sonnet 3.5");
    expect(modelName("some-gateway-model")).toBe("some-gateway-model");
  });

  test("countdowns and elapsed time", async () => {
    const hour = 3_600_000;
    expect(countdown(47 * hour + 5 * 60_000)).toBe("1d 23h");
    expect(countdown(2 * hour + 10 * 60_000)).toBe("2h 10m");
    expect(countdown(9 * 60_000)).toBe("9m");
    expect(countdown(-1)).toBe("now");
    expect(elapsed(33 * 60_000)).toBe("0:33");
    expect(elapsed(25 * hour + 60_000)).toBe("25:01");
  });

  test("a bar fills in proportion", async () => {
    expect(bar(50, 10)).toEqual({ filled: "█████", empty: "░░░░░" });
    expect(bar(0, 4)).toEqual({ filled: "", empty: "░░░░" });
    expect(bar(140, 4)).toEqual({ filled: "████", empty: "" });
  });

  test("vertical bars stack eighth blocks, tallest at full height", async () => {
    expect(verticalBars([0, 1, 2], 2)).toEqual(["  █", " ██"]);
    expect(verticalBars([0, 0], 1)).toEqual(["  "]);
  });
});
