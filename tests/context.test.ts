import { describe, expect, test } from "claude-code/testing";

import { allocateCells, CONTEXT_PALETTE, contextSegments } from "../hooks/context";

const category = (name: string, tokens: number, kind: "used" | "free" | "buffer" | "deferred" = "used") => ({
  name,
  tokens,
  kind,
});

describe("allocateCells", () => {
  test("shares the width in proportion, adding up exactly", async () => {
    expect(allocateCells([50, 30, 20], 10)).toEqual([5, 3, 2]);
    expect(allocateCells([1, 1, 1], 10)).toEqual([4, 3, 3]);
  });

  test("anything above zero gets at least one cell, taken from the largest share", async () => {
    expect(allocateCells([1, 998, 1], 10)).toEqual([1, 8, 1]);
  });

  test("zero stays zero, and an empty total draws nothing", async () => {
    expect(allocateCells([0, 10], 4)).toEqual([0, 4]);
    expect(allocateCells([0, 0], 4)).toEqual([0, 0]);
  });
});

describe("contextSegments", () => {
  test("colors follow the bar's order, so touching segments are always neighbors in the validated palette", async () => {
    // Without custom agents, MCP tools and memory files touch; fixed colors per category would put
    // aqua beside magenta, which deuteranopia cannot tell apart.
    const segments = contextSegments([
      category("System prompt", 3_000),
      category("MCP tools", 2_000),
      category("Memory files", 1_000),
      category("Messages", 9_000),
    ]);

    expect(segments.map((segment) => segment.color)).toEqual(CONTEXT_PALETTE.slice(0, 4));
  });

  test("leaves out schemas loaded on demand and keeps free space and the buffer last", async () => {
    const segments = contextSegments([
      category("Free space", 150_000, "free"),
      category("System tools", 12_000),
      category("MCP tools (deferred)", 40_000, "deferred"),
      category("Autocompact buffer", 33_000, "buffer"),
    ]);

    expect(segments.map((segment) => [segment.name, segment.kind])).toEqual([
      ["System tools", "used"],
      ["Free space", "free"],
      ["Autocompact buffer", "buffer"],
    ]);
  });

  test("past the eighth color, the remaining categories fold into Other", async () => {
    const names = ["System prompt", "System tools", "MCP tools", "Custom agents", "Memory files", "Skills", "Messages"];
    const segments = contextSegments([
      ...names.map((name) => category(name, 1_000)),
      category("Slash commands", 500),
      category("Something new", 300),
    ]);

    const used = segments.filter((segment) => segment.kind === "used");
    expect(used.map((segment) => segment.name)).toEqual([...names, "Slash commands", "Other"]);
    expect(used.find((segment) => segment.name === "Other")!.tokens).toBe(300);
    expect(used.slice(0, 8).map((segment) => segment.color)).toEqual(CONTEXT_PALETTE);
  });
});
